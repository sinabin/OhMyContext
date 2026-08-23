#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { hasExactKeyStorageBoundary } from "./key-storage-evidence-policy.mjs";

const execFileAsync = promisify(execFile);
const { COPYFILE_EXCL } = constants;
const MANIFEST_NAME = "OWNCONTEXT-RELEASE-CANDIDATE.json";
const CHECKSUM_NAME = "OWNCONTEXT-RELEASE-SHA256SUMS";
const SOURCE_LOCK_NAME = "SOURCE-package-lock.json";
const MAKER_EVIDENCE_NAME = "SQUIRREL-MAKER-PROVENANCE.json";
const KEY_STORAGE_EVIDENCE_NAME = "WINDOWS-KEY-STORAGE-SMOKE.json";
const PACKAGED_DIRECTORY_NAME = "OwnContext Developer Preview-win32-x64";
const MAKER_RELATIVE_DIRECTORY = "make/squirrel.windows/x64";
const EVIDENCE_RELATIVE_DIRECTORY = "evidence";
const COMPLIANCE_NAMES = [
  "SBOM.spdx.json",
  "SHA256SUMS",
  "THIRD_PARTY_NOTICES.txt",
];
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export class ReleaseBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseBundleError";
    this.code = code;
  }
}

export async function generateReleaseBundle({
  buildPath,
  projectRoot = process.cwd(),
  signatureInspector = inspectAuthenticode,
  sourceInspector = inspectGitSource,
} = {}) {
  const context = await createContext(buildPath, projectRoot);
  await requireAbsent(context.manifestPath, MANIFEST_NAME);
  await requireAbsent(context.releaseChecksumsPath, CHECKSUM_NAME);
  await requireAbsent(context.sourceLockPath, SOURCE_LOCK_NAME);
  let sourceLockCreated = false;
  let releaseChecksumsCreated = false;
  let manifestCreated = false;
  try {
    await copyFile(context.projectLockPath, context.sourceLockPath, COPYFILE_EXCL);
    sourceLockCreated = true;
    const rendered = await renderReleaseBundle(context, signatureInspector, sourceInspector);
    await writeExclusive(context.releaseChecksumsPath, rendered.releaseChecksums);
    releaseChecksumsCreated = true;
    await writeExclusive(context.manifestPath, rendered.manifestText);
    manifestCreated = true;
    return bundleResult(context, rendered.manifest);
  } catch (error) {
    if (manifestCreated) await unlink(context.manifestPath).catch(() => undefined);
    if (releaseChecksumsCreated) {
      await unlink(context.releaseChecksumsPath).catch(() => undefined);
    }
    if (sourceLockCreated) await unlink(context.sourceLockPath).catch(() => undefined);
    throw error;
  }
}

export async function verifyReleaseBundle({
  buildPath,
  projectRoot = process.cwd(),
  signatureInspector = inspectAuthenticode,
  sourceInspector = inspectGitSource,
} = {}) {
  const context = await createContext(buildPath, projectRoot);
  await requireRegularFile(context.manifestPath, MANIFEST_NAME);
  await requireRegularFile(context.releaseChecksumsPath, CHECKSUM_NAME);
  await requireRegularFile(context.sourceLockPath, SOURCE_LOCK_NAME);
  await requireSameBytes(
    context.projectLockPath,
    context.sourceLockPath,
    "The copied source lockfile no longer matches package-lock.json",
  );

  const rendered = await renderReleaseBundle(context, signatureInspector, sourceInspector);
  const actualChecksums = await readBoundedText(
    context.releaseChecksumsPath,
    MAX_TEXT_BYTES,
    CHECKSUM_NAME,
  );
  const actualManifest = await readBoundedText(
    context.manifestPath,
    MAX_JSON_BYTES,
    MANIFEST_NAME,
  );
  if (actualChecksums !== rendered.releaseChecksums) {
    throw new ReleaseBundleError(
      "RELEASE_CHECKSUMS_MISMATCH",
      `${CHECKSUM_NAME} does not match the current release-candidate files`,
    );
  }
  if (actualManifest !== rendered.manifestText) {
    throw new ReleaseBundleError(
      "RELEASE_MANIFEST_MISMATCH",
      `${MANIFEST_NAME} does not match the current source and release-candidate files`,
    );
  }
  return bundleResult(context, rendered.manifest);
}

async function createContext(buildPath, projectRoot) {
  if (typeof buildPath !== "string" || buildPath.trim() === "") {
    throw new ReleaseBundleError(
      "BUILD_REQUIRED",
      "A Windows Forge build directory is required (--build <directory>)",
    );
  }
  const resolvedProjectRoot = await requireRealDirectory(projectRoot, "project root");
  const buildRoot = await requireRealDirectory(buildPath, "Forge build root");
  const evidenceRoot = await requireRealDirectory(
    resolve(buildRoot, EVIDENCE_RELATIVE_DIRECTORY),
    "release evidence directory",
  );
  if (!isStrictDescendant(buildRoot, evidenceRoot)) {
    throw new ReleaseBundleError(
      "EVIDENCE_OUTSIDE_BUILD",
      "The release evidence directory must remain inside the Forge build root",
    );
  }
  const projectLockPath = resolve(resolvedProjectRoot, "package-lock.json");
  await requireRegularFile(projectLockPath, "package-lock.json");
  return {
    projectRoot: resolvedProjectRoot,
    projectLockPath,
    buildRoot,
    evidenceRoot,
    sourceLockPath: resolve(evidenceRoot, SOURCE_LOCK_NAME),
    manifestPath: resolve(evidenceRoot, MANIFEST_NAME),
    releaseChecksumsPath: resolve(evidenceRoot, CHECKSUM_NAME),
  };
}

async function renderReleaseBundle(context, signatureInspector, sourceInspector) {
  const project = await inspectProject(context);
  const maker = await inspectMakerOutput(context);
  const source = normalizeSourceIdentity(await sourceInspector(context.projectRoot));
  const authenticode = normalizeAuthenticode(
    await signatureInspector(maker.setup.absolutePath),
    maker.setup.sha256,
  );
  const setupAfterAuthenticode = await inspectFile(
    context.buildRoot,
    maker.setup.absolutePath,
    maker.setup.role,
  );
  if (!sameInspectedFile(maker.setup, setupAfterAuthenticode)) {
    throw new ReleaseBundleError(
      "FILE_CHANGED",
      "The Windows installer changed during Authenticode inspection",
    );
  }

  const artifacts = [maker.setup, maker.fullPackage, maker.releases]
    .map(publicFileRecord)
    .sort(compareRelativePath);
  artifacts[artifacts.findIndex((file) => file.role === "windows-setup")].authenticode =
    authenticode;

  const evidence = await inspectEvidenceFiles(context, maker);
  const checksumEntries = [...artifacts, ...evidence]
    .map(({ relativePath, sha256 }) => ({ relativePath, sha256 }))
    .sort(compareRelativePath);
  const releaseChecksums = `${checksumEntries
    .map((entry) => `${entry.sha256}  ${entry.relativePath}`)
    .join("\n")}\n`;
  const releaseChecksumsBytes = Buffer.from(releaseChecksums, "utf8");
  const blockers = publicReleaseBlockers(project, source, authenticode);
  const manifest = {
    schemaVersion: 1,
    status: "DRAFT — NOT FOR PUBLIC RELEASE",
    product: "OwnContext",
    release: {
      releaseId: `owncontext-v${project.version}-windows-x64-${source.commit.slice(0, 12)}-draft`,
      version: project.version,
      channel: "developer-alpha",
      platform: "Windows x64",
      publicRelease: false,
    },
    source,
    projectLicense: project.license,
    artifacts,
    evidence,
    releaseChecksums: {
      relativePath: `${EVIDENCE_RELATIVE_DIRECTORY}/${CHECKSUM_NAME}`,
      size: releaseChecksumsBytes.byteLength,
      sha256: sha256(releaseChecksumsBytes),
      entryCount: checksumEntries.length,
    },
    readiness: {
      publicRelease: false,
      blockers,
      boundary:
        "This bundle binds an unsigned developer-alpha candidate to source and local evidence. It does not authorize redistribution or prove the remaining security, licensing, signing, update, or clean-machine gates.",
    },
  };
  return {
    manifest,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    releaseChecksums,
  };
}

async function inspectProject(context) {
  const rootPackage = await readJson(
    resolve(context.projectRoot, "package.json"),
    "root package.json",
  );
  const desktopPackage = await readJson(
    resolve(context.projectRoot, "apps", "desktop", "package.json"),
    "desktop package.json",
  );
  const version = rootPackage.version;
  if (typeof version !== "string" || version !== desktopPackage.version) {
    throw new ReleaseBundleError(
      "VERSION_MISMATCH",
      "The root and desktop package versions must be identical",
    );
  }
  const statusPath = resolve(context.projectRoot, "LICENSE-STATUS.md");
  await requireRegularFile(statusPath, "LICENSE-STATUS.md");
  const statusSha256 = await hashFile(statusPath);
  const declared = typeof rootPackage.license === "string" ? rootPackage.license : null;
  const licensePath = resolve(context.projectRoot, "LICENSE");
  const licensePresent = await isRegularFile(licensePath);
  const licenseFileSha256 = licensePresent ? await hashFile(licensePath) : null;
  const workspaceLicenses = await ownContextWorkspaceLicenses(context.projectRoot);
  const metadataConsistent =
    declared !== null &&
    declared.trim() !== "" &&
    workspaceLicenses.length > 0 &&
    workspaceLicenses.every((license) => license === declared);
  return {
    version,
    license: {
      status: metadataConsistent && licensePresent
        ? "declared-not-release-approved"
        : "unresolved",
      spdx: metadataConsistent && licensePresent ? declared : null,
      licenseFilePresent: licensePresent,
      licenseFileSha256,
      workspaceMetadataConsistent: metadataConsistent,
      statusFileSha256: statusSha256,
    },
  };
}

async function ownContextWorkspaceLicenses(projectRoot) {
  const lock = await readJson(resolve(projectRoot, "package-lock.json"), "package-lock.json");
  if (lock.lockfileVersion !== 3 || !isObject(lock.packages)) {
    throw new ReleaseBundleError(
      "LOCKFILE_UNSUPPORTED",
      "package-lock.json must contain a lockfileVersion 3 packages map",
    );
  }
  const licenses = [];
  for (const [workspacePath, metadata] of Object.entries(lock.packages)) {
    if (workspacePath === "" || !isObject(metadata)) continue;
    if (typeof metadata.name !== "string" || !metadata.name.startsWith("@owncontext/")) {
      continue;
    }
    const manifest = await readJson(
      resolve(projectRoot, workspacePath, "package.json"),
      `${workspacePath}/package.json`,
    );
    licenses.push(typeof manifest.license === "string" ? manifest.license : null);
  }
  return licenses;
}

async function inspectMakerOutput(context) {
  const makerRoot = await requireRealDirectory(
    resolve(context.buildRoot, ...MAKER_RELATIVE_DIRECTORY.split("/")),
    "Squirrel maker output",
  );
  const inspectedProvenance = await inspectMakerProvenanceFile(context);
  const provenance = inspectedProvenance.value;
  validateMakerProvenance(provenance);
  const expectedNames = [
    provenance.makerOutput.setup.name,
    provenance.makerOutput.fullPackage.name,
    provenance.makerOutput.releases.name,
  ];
  await requireExactRegularFiles(makerRoot, expectedNames, "Squirrel maker output");
  const setup = await verifiedMakerFile(
    context,
    makerRoot,
    provenance.makerOutput.setup,
    "windows-setup",
  );
  const fullPackage = await verifiedMakerFile(
    context,
    makerRoot,
    provenance.makerOutput.fullPackage,
    "squirrel-full-package",
  );
  const releases = await verifiedMakerFile(
    context,
    makerRoot,
    provenance.makerOutput.releases,
    "squirrel-releases-index",
  );
  return {
    provenance,
    provenanceFile: inspectedProvenance.record,
    setup,
    fullPackage,
    releases,
  };
}

function validateMakerProvenance(provenance) {
  if (
    provenance.schemaVersion !== 2 ||
    provenance.status !== "DRAFT — NOT FOR PUBLIC RELEASE" ||
    !isObject(provenance.makerOutput) ||
    !isObject(provenance.makerOutput.setup) ||
    !isObject(provenance.makerOutput.fullPackage) ||
    !isObject(provenance.makerOutput.releases)
  ) {
    throw new ReleaseBundleError(
      "MAKER_PROVENANCE_INVALID",
      "Squirrel maker provenance is missing its exact draft output evidence",
    );
  }
  const expectedNames = [
    provenance.makerOutput.setup.name,
    provenance.makerOutput.fullPackage.name,
    provenance.makerOutput.releases.name,
  ];
  if (expectedNames.some((name) => !isSafeFileName(name))) {
    throw new ReleaseBundleError(
      "MAKER_PROVENANCE_INVALID",
      "Squirrel maker provenance contains an unsafe output name",
    );
  }
}

async function verifiedMakerFile(context, makerRoot, expected, role) {
  if (
    !isObject(expected) ||
    !isSafeFileName(expected.name) ||
    !Number.isSafeInteger(expected.length) ||
    expected.length < 1 ||
    !isSha256(expected.sha256)
  ) {
    throw new ReleaseBundleError(
      "MAKER_PROVENANCE_INVALID",
      `Squirrel maker provenance has invalid ${role} evidence`,
    );
  }
  const absolutePath = resolve(makerRoot, expected.name);
  const file = await inspectFile(context.buildRoot, absolutePath, role);
  if (file.size !== expected.length || file.sha256 !== expected.sha256) {
    throw new ReleaseBundleError(
      "MAKER_OUTPUT_MISMATCH",
      `${expected.name} does not match Squirrel maker provenance`,
    );
  }
  return file;
}

async function inspectEvidenceFiles(context, maker) {
  const keyStorageEvidencePath = resolve(
    context.evidenceRoot,
    KEY_STORAGE_EVIDENCE_NAME,
  );
  const confirmedProvenance = await inspectMakerProvenanceFile(
    context,
    maker.provenanceFile,
  );
  const records = [
    confirmedProvenance.record,
    await inspectFile(
      context.buildRoot,
      context.sourceLockPath,
      "source-lockfile",
    ),
    await inspectKeyStorageEvidenceFile({
      buildRoot: context.buildRoot,
      path: keyStorageEvidencePath,
    }),
  ];
  const complianceRoot = resolve(
    context.buildRoot,
    PACKAGED_DIRECTORY_NAME,
    "resources",
    "compliance",
  );
  for (const name of COMPLIANCE_NAMES) {
    records.push(await inspectFile(
      context.buildRoot,
      resolve(complianceRoot, name),
      `payload-${name.toLowerCase()}`,
    ));
  }
  return records.map(publicFileRecord).sort(compareRelativePath);
}

async function inspectMakerProvenanceFile(context, expectedRecord) {
  const path = resolve(context.evidenceRoot, MAKER_EVIDENCE_NAME);
  const file = await openVerifiedBuildFile(
    context.buildRoot,
    path,
    "maker-provenance",
  );
  try {
    const size = safeFileSize(file.initial, MAKER_EVIDENCE_NAME);
    if (size < 1 || size > MAX_JSON_BYTES) {
      throw new ReleaseBundleError(
        "FILE_INVALID",
        `${MAKER_EVIDENCE_NAME} is not a bounded regular file`,
      );
    }
    const bytes = await readExactHandleBytes(file.handle, size, true);
    await assertHandleStable(file, MAKER_EVIDENCE_NAME);
    const confirmedBytes = await readExactHandleBytes(file.handle, size, true);
    await assertHandleStable(file, MAKER_EVIDENCE_NAME);
    if (!bytes.equals(confirmedBytes)) {
      throw new ReleaseBundleError(
        "FILE_CHANGED",
        `${MAKER_EVIDENCE_NAME} changed while it was read`,
      );
    }
    const record = {
      role: "maker-provenance",
      relativePath: toPosix(relative(context.buildRoot, file.realPath)),
      absolutePath: file.realPath,
      size: confirmedBytes.byteLength,
      sha256: sha256(confirmedBytes),
    };
    if (expectedRecord && !sameInspectedFile(expectedRecord, record)) {
      throw new ReleaseBundleError(
        "FILE_CHANGED",
        `${MAKER_EVIDENCE_NAME} changed after maker validation`,
      );
    }
    const value = parseJsonBytes(confirmedBytes, MAKER_EVIDENCE_NAME);
    validateMakerProvenance(value);
    return { value, record };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

export async function inspectKeyStorageEvidenceFile({
  buildRoot,
  path,
  openFile = open,
}) {
  const file = await openVerifiedBuildFile(
    buildRoot,
    path,
    "windows-key-storage-smoke",
    openFile,
  );
  try {
    const size = safeFileSize(file.initial, KEY_STORAGE_EVIDENCE_NAME);
    if (size < 1 || size > MAX_JSON_BYTES) {
      throw new ReleaseBundleError(
        "FILE_INVALID",
        `${KEY_STORAGE_EVIDENCE_NAME} is not a bounded regular file`,
      );
    }
    const bytes = await readExactHandleBytes(file.handle, size, true);
    await assertHandleStable(file, KEY_STORAGE_EVIDENCE_NAME);
    const confirmedBytes = await readExactHandleBytes(file.handle, size, true);
    await assertHandleStable(file, KEY_STORAGE_EVIDENCE_NAME);
    if (!bytes.equals(confirmedBytes)) {
      throw new ReleaseBundleError(
        "FILE_CHANGED",
        `${KEY_STORAGE_EVIDENCE_NAME} changed while it was read`,
      );
    }
    const evidence = parseJsonBytes(confirmedBytes, KEY_STORAGE_EVIDENCE_NAME);
    validateKeyStorageEvidence(evidence);
    return {
      role: "windows-key-storage-smoke",
      relativePath: toPosix(relative(buildRoot, file.realPath)),
      absolutePath: file.realPath,
      size: confirmedBytes.byteLength,
      sha256: sha256(confirmedBytes),
    };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

function validateKeyStorageEvidence(evidence) {
  if (
    !hasExactKeys(evidence, [
      "boundary",
      "control",
      "envelope",
      "protector",
      "result",
      "runtime",
      "schemaVersion",
      "status",
    ]) ||
    evidence.schemaVersion !== 2 ||
    evidence.status !== "DRAFT — NOT FOR PUBLIC RELEASE" ||
    evidence.control !== "windows-safe-storage-key-envelope-spike" ||
    evidence.result !== "PASS" ||
    !isObject(evidence.runtime) ||
    !hasExactKeys(evidence.runtime, ["architecture", "isPackaged", "platform"]) ||
    evidence.runtime.platform !== "win32" ||
    evidence.runtime.architecture !== "x64" ||
    evidence.runtime.isPackaged !== true ||
    !isObject(evidence.protector) ||
    !hasExactKeys(evidence.protector, ["asyncAvailable", "providerId"]) ||
    evidence.protector.providerId !== "electron-safe-storage" ||
    evidence.protector.asyncAvailable !== true ||
    !isObject(evidence.envelope) ||
    !hasExactKeys(evidence.envelope, [
      "keyBytes",
      "persisted",
      "knownPlaintextEncodingsAbsent",
      "roundTripMatched",
      "schemaVersion",
      "shouldReEncrypt",
    ]) ||
    evidence.envelope.schemaVersion !== 1 ||
    evidence.envelope.keyBytes !== 32 ||
    evidence.envelope.persisted !== true ||
    evidence.envelope.knownPlaintextEncodingsAbsent !== true ||
    evidence.envelope.roundTripMatched !== true ||
    typeof evidence.envelope.shouldReEncrypt !== "boolean" ||
    !hasExactKeyStorageBoundary(evidence.boundary)
  ) {
    throw new ReleaseBundleError(
      "KEY_STORAGE_EVIDENCE_INVALID",
      "Packaged Windows key-storage evidence is invalid",
    );
  }
}

function parseJsonBytes(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value)) throw new TypeError("JSON root must be an object");
    return value;
  } catch (error) {
    throw new ReleaseBundleError("JSON_INVALID", `${label} is invalid: ${error.message}`);
  }
}

function publicReleaseBlockers(project, source, authenticode) {
  const blockers = [
    "clean-machine-lifecycle-not-verified",
    "draft-compliance-evidence",
    "public-security-gates-not-attested",
    "signed-public-build-profile-not-implemented",
    "update-channel-not-configured",
  ];
  if (project.version === "0.0.0" || project.version.startsWith("0.0.0-")) {
    blockers.push("placeholder-version");
  }
  if (project.license.status === "unresolved") {
    blockers.push("project-license-unresolved");
  } else {
    blockers.push("project-license-not-release-approved");
  }
  if (!authenticode.valid) blockers.push("installer-not-authenticode-valid");
  if (!authenticode.timestamped) blockers.push("installer-timestamp-not-verified");
  if (source.repository === null) blockers.push("public-repository-unconfigured");
  if (!source.trackedWorktreeClean) blockers.push("tracked-worktree-dirty");
  return blockers.sort();
}

export async function inspectGitSource(projectRoot) {
  const commit = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  const status = await runGit(projectRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  let repository = null;
  try {
    repository = normalizeRepositoryUrl(
      await runGit(projectRoot, ["config", "--get", "remote.origin.url"]),
    );
  } catch {
    repository = null;
  }
  return {
    commit,
    trackedWorktreeClean: status === "",
    repository,
  };
}

export async function inspectAuthenticode(installerPath) {
  if (process.platform !== "win32") {
    throw new ReleaseBundleError(
      "AUTHENTICODE_UNAVAILABLE",
      "Authenticode inspection requires a Windows build host",
    );
  }
  const command = `
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open(
  $env:OWNCONTEXT_SIGNATURE_TARGET,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::Read
)
try {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $inspectedSha256 = [Convert]::ToHexString($hasher.ComputeHash($stream)).ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $env:OWNCONTEXT_SIGNATURE_TARGET
  [pscustomobject]@{
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    inspectedSha256 = $inspectedSha256
    signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }
    signerThumbprint = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Thumbprint }
    timestamperSubject = if ($null -eq $signature.TimeStamperCertificate) { $null } else { [string]$signature.TimeStamperCertificate.Subject }
    timestamperThumbprint = if ($null -eq $signature.TimeStamperCertificate) { $null } else { [string]$signature.TimeStamperCertificate.Thumbprint }
  } | ConvertTo-Json -Compress
} finally {
  $stream.Dispose()
}
`;
  try {
    const { stdout } = await execFileAsync(
      "pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: { ...process.env, OWNCONTEXT_SIGNATURE_TARGET: installerPath },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    return JSON.parse(stdout.trim());
  } catch {
    throw new ReleaseBundleError(
      "AUTHENTICODE_INSPECTION_FAILED",
      "Windows Authenticode inspection failed for the candidate installer",
    );
  }
}

async function runGit(projectRoot, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

function normalizeSourceIdentity(value) {
  if (!isObject(value) || !/^[0-9a-f]{40}$/u.test(value.commit)) {
    throw new ReleaseBundleError(
      "SOURCE_IDENTITY_INVALID",
      "Source identity must include the exact 40-character Git commit",
    );
  }
  if (typeof value.trackedWorktreeClean !== "boolean") {
    throw new ReleaseBundleError(
      "SOURCE_IDENTITY_INVALID",
      "Source identity must report tracked-worktree cleanliness",
    );
  }
  return {
    commit: value.commit,
    trackedWorktreeClean: value.trackedWorktreeClean,
    repository: normalizeRepositoryUrl(value.repository),
  };
}

function normalizeRepositoryUrl(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ReleaseBundleError("SOURCE_REPOSITORY_INVALID", "Git remote URL is invalid");
  }
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(value);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    const path = parsed.pathname.replace(/\.git$/u, "").replace(/\/$/u, "");
    if (!/^\/[^/]+\/[^/]+$/u.test(path)) return null;
    return `https://github.com${path}`;
  } catch {
    return null;
  }
}

function normalizeAuthenticode(value, expectedSha256) {
  if (
    !isObject(value) ||
    typeof value.status !== "string" ||
    !isSha256(value.inspectedSha256)
  ) {
    throw new ReleaseBundleError(
      "AUTHENTICODE_RESULT_INVALID",
      "Authenticode inspection returned invalid evidence",
    );
  }
  const inspectedSha256 = value.inspectedSha256.toLowerCase();
  if (inspectedSha256 !== expectedSha256) {
    throw new ReleaseBundleError(
      "AUTHENTICODE_TARGET_MISMATCH",
      "Authenticode inspection did not cover the verified installer bytes",
    );
  }
  const nullableText = (candidate) =>
    typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
  const signerSubject = nullableText(value.signerSubject);
  const signerThumbprint = nullableText(value.signerThumbprint);
  const timestamperSubject = nullableText(value.timestamperSubject);
  const timestamperThumbprint = nullableText(value.timestamperThumbprint);
  return {
    status: value.status,
    inspectedSha256,
    valid: value.status === "Valid" && signerSubject !== null && signerThumbprint !== null,
    timestamped: timestamperSubject !== null && timestamperThumbprint !== null,
    signerSubject,
    signerThumbprint,
    timestamperSubject,
    timestamperThumbprint,
  };
}

async function inspectFile(buildRoot, absolutePath, role) {
  const file = await openVerifiedBuildFile(buildRoot, absolutePath, role);
  try {
    const size = safeFileSize(file.initial, role);
    const firstSha256 = await hashHandle(file.handle, size);
    await assertHandleStable(file, role);
    const sha256 = await hashHandle(file.handle, size);
    await assertHandleStable(file, role);
    if (sha256 !== firstSha256) {
      throw new ReleaseBundleError("FILE_CHANGED", `${role} changed while it was hashed`);
    }
    return {
      role,
      relativePath: toPosix(relative(buildRoot, file.realPath)),
      absolutePath: file.realPath,
      size,
      sha256,
    };
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

async function openVerifiedBuildFile(buildRoot, path, role, openFile = open) {
  const before = await lstat(path).catch((error) => {
    throw new ReleaseBundleError("FILE_MISSING", `${role} is unavailable: ${error.message}`);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ReleaseBundleError("FILE_INVALID", `${role} must be a regular file`);
  }
  const realPath = await realpath(path).catch(() => {
    throw new ReleaseBundleError(
      "FILE_CHANGED",
      `${role} changed while its build boundary was being verified`,
    );
  });
  if (!isStrictDescendant(buildRoot, realPath)) {
    throw new ReleaseBundleError(
      "FILE_OUTSIDE_BUILD",
      `${role} must remain inside the Forge build root`,
    );
  }
  const resolved = await lstat(realPath, { bigint: true }).catch(() => {
    throw new ReleaseBundleError(
      "FILE_CHANGED",
      `${role} changed while its build boundary was being verified`,
    );
  });
  if (!resolved.isFile() || resolved.isSymbolicLink()) {
    throw new ReleaseBundleError("FILE_INVALID", `${role} must be a regular file`);
  }

  const handle = await openFile(path, "r").catch(() => {
    throw new ReleaseBundleError(
      "FILE_CHANGED",
      `${role} changed before it could be opened`,
    );
  });
  try {
    const initial = await handle.stat({ bigint: true }).catch(() => {
      throw new ReleaseBundleError(
        "FILE_CHANGED",
        `${role} changed before it could be inspected`,
      );
    });
    if (!initial.isFile() || !sameFileIdentity(initial, resolved)) {
      throw new ReleaseBundleError(
        "FILE_CHANGED",
        `${role} changed while its build boundary was being verified`,
      );
    }
    return { handle, initial, path, realPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function safeFileSize(metadata, role) {
  if (metadata.size < 0n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReleaseBundleError("FILE_INVALID", `${role} has an invalid size`);
  }
  return Number(metadata.size);
}

async function readExactHandleBytes(handle, size, rejectGrowth = false) {
  const capacity = size + (rejectGrowth ? 1 : 0);
  const bytes = Buffer.allocUnsafe(capacity);
  let offset = 0;
  while (offset < capacity) {
    const result = await handle.read(bytes, offset, capacity - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) {
    throw new ReleaseBundleError("FILE_CHANGED", "File size changed while it was read");
  }
  return bytes.subarray(0, size);
}

async function hashHandle(handle, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position);
    const result = await handle.read(buffer, 0, length, position);
    if (result.bytesRead === 0) {
      throw new ReleaseBundleError("FILE_CHANGED", "File was truncated while it was hashed");
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return hash.digest("hex");
}

async function assertHandleStable(file, role) {
  const final = await file.handle.stat({ bigint: true });
  const current = await lstat(file.path, { bigint: true }).catch(() => null);
  const currentRealPath = await realpath(file.path).catch(() => null);
  if (
    !sameFileState(file.initial, final) ||
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(final, current) ||
    currentRealPath !== file.realPath
  ) {
    throw new ReleaseBundleError("FILE_CHANGED", `${role} changed while it was inspected`);
  }
}

function sameFileIdentity(handleMetadata, pathMetadata) {
  return handleMetadata.dev === pathMetadata.dev &&
    handleMetadata.ino === pathMetadata.ino;
}

function sameFileState(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function sameInspectedFile(left, right) {
  return left.role === right.role &&
    left.relativePath === right.relativePath &&
    left.absolutePath === right.absolutePath &&
    left.size === right.size &&
    left.sha256 === right.sha256;
}

function publicFileRecord(file) {
  return {
    role: file.role,
    relativePath: file.relativePath,
    size: file.size,
    sha256: file.sha256,
  };
}

async function requireExactRegularFiles(directory, expectedNames, label) {
  const expected = new Set(expectedNames);
  const actual = new Set();
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ReleaseBundleError(
        "OUTPUT_INVENTORY_INVALID",
        `${label} contains a non-regular entry: ${entry.name}`,
      );
    }
    actual.add(entry.name);
  }
  if (!setsEqual(actual, expected)) {
    throw new ReleaseBundleError(
      "OUTPUT_INVENTORY_INVALID",
      `${label} must contain exactly ${[...expected].sort().join(", ")}`,
    );
  }
}

async function requireRealDirectory(path, label) {
  const metadata = await lstat(path).catch((error) => {
    throw new ReleaseBundleError("DIRECTORY_MISSING", `${label} is unavailable: ${error.message}`);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ReleaseBundleError("DIRECTORY_INVALID", `${label} must be a regular directory`);
  }
  return realpath(path);
}

async function requireRegularFile(path, label) {
  const metadata = await lstat(path).catch((error) => {
    throw new ReleaseBundleError("FILE_MISSING", `${label} is unavailable: ${error.message}`);
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ReleaseBundleError("FILE_INVALID", `${label} must be a regular file`);
  }
  return realpath(path);
}

async function isRegularFile(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new ReleaseBundleError("OUTPUT_EXISTS", `${label} already exists`);
}

async function requireSameBytes(left, right, message) {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  if (!leftBytes.equals(rightBytes)) {
    throw new ReleaseBundleError("SOURCE_LOCK_MISMATCH", message);
  }
}

async function readJson(path, label) {
  const text = await readBoundedText(path, MAX_JSON_BYTES, label);
  try {
    const value = JSON.parse(text);
    if (!isObject(value)) throw new TypeError("JSON root must be an object");
    return value;
  } catch (error) {
    throw new ReleaseBundleError("JSON_INVALID", `${label} is invalid: ${error.message}`);
  }
}

async function readBoundedText(path, maxBytes, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new ReleaseBundleError("FILE_INVALID", `${label} is not a bounded regular file`);
  }
  return readFile(path, "utf8");
}

async function writeExclusive(path, contents) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSafeFileName(value) {
  return typeof value === "string" && value === basename(value) && value !== "." && value !== "..";
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isStrictDescendant(parent, child) {
  const difference = relative(parent, child);
  return difference !== "" && difference !== ".." &&
    !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function compareRelativePath(left, right) {
  return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bundleResult(context, manifest) {
  return {
    buildRoot: context.buildRoot,
    manifestPath: context.manifestPath,
    releaseChecksumsPath: context.releaseChecksumsPath,
    releaseId: manifest.release.releaseId,
    publicRelease: false,
    blockerCount: manifest.readiness.blockers.length,
  };
}

function parseCli(argv) {
  const [command, ...tokens] = argv;
  if (command !== "generate" && command !== "verify") return null;
  const options = { command };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--build" || token === "--project-root") {
      const value = tokens[index + 1];
      if (!value) throw new ReleaseBundleError("CLI_INVALID", `${token} requires a value`);
      if (token === "--build") options.buildPath = value;
      else options.projectRoot = value;
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && options.buildPath === undefined) {
      options.buildPath = token;
      continue;
    }
    throw new ReleaseBundleError("CLI_INVALID", `Unknown argument: ${token}`);
  }
  return options;
}

async function runCli() {
  const options = parseCli(process.argv.slice(2));
  if (!options) {
    process.stderr.write(
      "Usage: node scripts/release-bundle.mjs <generate|verify> <forge-build-dir> [--project-root <repo>]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const operation = options.command === "generate" ? generateReleaseBundle : verifyReleaseBundle;
    const result = await operation(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof ReleaseBundleError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await runCli();
