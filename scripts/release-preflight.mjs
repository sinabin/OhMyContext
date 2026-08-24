#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const JSON_OUTPUT = process.argv.includes("--json");

const checks = [];

function addCheck(id, passed, detail, remediation) {
  checks.push({ id, status: passed ? "passed" : "blocked", detail, remediation });
}

async function regularFile(candidate) {
  try {
    const metadata = await lstat(candidate);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(resolve(projectRoot, relativePath), "utf8"));
  } catch {
    return undefined;
  }
}

async function git(args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function envPath(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) return null;
  return value;
}

async function inspect() {
  const rootPackage = await readJson("package.json");
  const workspacePaths = [
    "apps/desktop/package.json",
    "apps/mcp-server/package.json",
    "packages/core/package.json",
  ];
  const workspacePackages = await Promise.all(workspacePaths.map((path) => readJson(path)));
  const version = rootPackage?.version;
  const versionsMatch =
    typeof version === "string" &&
    workspacePackages.every((pkg) => pkg?.version === version) &&
    !/^0\.0\.0(?:$|[-.])/u.test(version);
  addCheck(
    "version",
    versionsMatch,
    versionsMatch ? `release version ${version}` : "workspace version is missing, mismatched, or still a 0.0.0 placeholder",
    "Set one non-placeholder semver version in the root and every @owncontext workspace.",
  );

  const remote = await git(["config", "--get", "remote.origin.url"]);
  const repositoryReady = typeof remote === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+$/u.test(remote.replace(/\.git$/u, ""));
  addCheck(
    "public-repository",
    repositoryReady,
    repositoryReady ? "GitHub origin is configured" : "no canonical public GitHub origin is configured",
    "Create or select the public GitHub repository and configure origin before a public release.",
  );

  const licenseFile = resolve(projectRoot, "LICENSE");
  const statusText = await readFile(resolve(projectRoot, "LICENSE-STATUS.md"), "utf8").catch(() => "");
  const license = rootPackage?.license;
  const workspaceLicensesMatch =
    typeof license === "string" &&
    workspacePackages.every((pkg) => pkg?.license === license) &&
    (await regularFile(licenseFile)) &&
    !/not selected|undecided|not for public release|unresolved/iu.test(statusText);
  addCheck(
    "project-license",
    workspaceLicensesMatch,
    workspaceLicensesMatch ? `SPDX ${license} is present and approved` : "project license is absent, inconsistent, or still held as undecided",
    "Select the project license, add the complete LICENSE text, align workspace metadata, and record maintainer approval.",
  );

  const profile = process.env.OWNCONTEXT_RELEASE_PROFILE;
  addCheck(
    "public-build-profile",
    profile === "public",
    profile === "public" ? "public release profile selected" : "OWNCONTEXT_RELEASE_PROFILE is not public",
    "Use OWNCONTEXT_RELEASE_PROFILE=public only in the controlled release job after all gates pass.",
  );

  const certificatePath = envPath("OWNCONTEXT_SIGNING_CERTIFICATE_FILE");
  const signingReady =
    certificatePath !== null &&
    (await regularFile(certificatePath)) &&
    typeof process.env.OWNCONTEXT_SIGNING_CERTIFICATE_PASSWORD === "string" &&
    process.env.OWNCONTEXT_SIGNING_CERTIFICATE_PASSWORD.length > 0 &&
    typeof process.env.OWNCONTEXT_TIMESTAMP_SERVER === "string" &&
    /^https:\/\//u.test(process.env.OWNCONTEXT_TIMESTAMP_SERVER);
  addCheck(
    "authenticode-signing",
    signingReady,
    signingReady ? "certificate, password, and HTTPS timestamp server are configured" : "public signing inputs are unavailable",
    "Supply the organization-owned Authenticode certificate through the protected release runner; never commit it or its password.",
  );

  const updateUrl = process.env.OWNCONTEXT_UPDATE_URL;
  const updateReady = typeof updateUrl === "string" && /^https:\/\/[^/\s]+/u.test(updateUrl);
  addCheck(
    "update-channel",
    updateReady,
    updateReady ? "HTTPS update channel is configured" : "no HTTPS update channel is configured",
    "Configure the immutable HTTPS Squirrel RELEASES endpoint and verify signed update installation before publishing.",
  );

  const securityEvidence = envPath("OWNCONTEXT_SECURITY_ATTESTATION_FILE");
  const securityReady = securityEvidence !== null && await regularFile(securityEvidence);
  addCheck(
    "security-attestation",
    securityReady,
    securityReady ? "release security attestation file is present" : "no release security attestation evidence is present",
    "Attach evidence covering encrypted normal desktop/MCP storage, sidecars, backups, crash/restart recovery, races, DACLs, key rotation, and parser boundaries.",
  );

  const lifecycleEvidence = envPath("OWNCONTEXT_CLEAN_MACHINE_EVIDENCE_FILE");
  const lifecycleReady = lifecycleEvidence !== null && await regularFile(lifecycleEvidence);
  addCheck(
    "clean-machine-lifecycle",
    lifecycleReady,
    lifecycleReady ? "clean-machine lifecycle evidence file is present" : "no disposable clean-machine lifecycle evidence is present",
    "Run the installed lifecycle harness on a disposable GitHub-hosted windows-latest runner and retain its source-bound evidence.",
  );

  const workflowReady = await regularFile(resolve(projectRoot, ".github", "workflows", "public-release.yml"));
  addCheck(
    "public-release-workflow",
    workflowReady,
    workflowReady ? "public release workflow exists" : "public release workflow is not configured",
    "Add a protected-tag workflow that builds, signs, verifies, and publishes one source-bound release.",
  );

  const trackedStatus = await git(["status", "--porcelain=v1", "--untracked-files=no"]);
  addCheck(
    "tracked-worktree",
    trackedStatus === "",
    trackedStatus === "" ? "tracked worktree is clean" : "tracked worktree has uncommitted changes",
    "Commit the exact release source before generating the source-bound bundle.",
  );

  return {
    schemaVersion: 1,
    product: "OwnContext",
    publicRelease: checks.every((check) => check.status === "passed"),
    blockers: checks.filter((check) => check.status === "blocked").map((check) => check.id),
    checks,
  };
}

const result = await inspect();
if (JSON_OUTPUT) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`OwnContext public release: ${result.publicRelease ? "READY" : "BLOCKED"}\n`);
  for (const check of result.checks) {
    process.stdout.write(`${check.status === "passed" ? "PASS" : "BLOCK"} ${check.id}: ${check.detail}\n`);
    if (check.status === "blocked") process.stdout.write(`      ${check.remediation}\n`);
  }
}
process.exitCode = result.publicRelease ? 0 : 1;
