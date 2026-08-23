import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateReleaseBundle,
  verifyReleaseBundle,
} from "../scripts/release-bundle.mjs";

const temporaryRoots: string[] = [];
const commit = "a".repeat(40);

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "owncontext-release-bundle-"));
  temporaryRoots.push(root);
  const projectRoot = join(root, "project");
  const buildRoot = join(root, "build", "unsigned-fixture");
  const makerRoot = join(buildRoot, "make", "squirrel.windows", "x64");
  const evidenceRoot = join(buildRoot, "evidence");
  const complianceRoot = join(
    buildRoot,
    "OwnContext Developer Preview-win32-x64",
    "resources",
    "compliance",
  );
  await Promise.all([
    mkdir(join(projectRoot, "apps", "desktop"), { recursive: true }),
    mkdir(makerRoot, { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
    mkdir(complianceRoot, { recursive: true }),
  ]);

  await writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({
      name: "owncontext",
      version: "0.0.0",
      private: true,
      workspaces: ["apps/*"],
    }, null, 2)}\n`,
  );
  await writeFile(
    join(projectRoot, "apps", "desktop", "package.json"),
    `${JSON.stringify({
      name: "@owncontext/desktop",
      version: "0.0.0",
      private: true,
    }, null, 2)}\n`,
  );
  const lock = `${JSON.stringify({
    name: "owncontext",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "owncontext", version: "0.0.0" },
      "apps/desktop": { name: "@owncontext/desktop", version: "0.0.0" },
    },
  }, null, 2)}\n`;
  await writeFile(join(projectRoot, "package-lock.json"), lock);
  await writeFile(
    join(projectRoot, "LICENSE-STATUS.md"),
    "# License status\n\nPublic redistribution is blocked.\n",
  );

  const setupName = "OwnContext-Developer-Preview-Unsigned-Setup.exe";
  const packageName = "OwnContextDeveloperPreview-0.0.0-full.nupkg";
  const makerFiles = {
    [setupName]: Buffer.from("unsigned setup fixture"),
    [packageName]: Buffer.from("full package fixture"),
    RELEASES: Buffer.from("release index fixture"),
  };
  for (const [name, bytes] of Object.entries(makerFiles)) {
    await writeFile(join(makerRoot, name), bytes);
  }
  for (const [name, contents] of [
    ["SBOM.spdx.json", "{\"spdxVersion\":\"SPDX-2.3\"}\n"],
    ["SHA256SUMS", "b".repeat(64) + "  app.exe\n"],
    ["THIRD_PARTY_NOTICES.txt", "DRAFT — NOT FOR PUBLIC RELEASE\n"],
  ]) {
    await writeFile(join(complianceRoot, name), contents);
  }
  const provenance = {
    schemaVersion: 2,
    status: "DRAFT — NOT FOR PUBLIC RELEASE",
    makerOutput: {
      setup: {
        name: setupName,
        length: makerFiles[setupName].byteLength,
        sha256: sha256(makerFiles[setupName]),
      },
      fullPackage: {
        name: packageName,
        length: makerFiles[packageName].byteLength,
        sha256: sha256(makerFiles[packageName]),
      },
      releases: {
        name: "RELEASES",
        length: makerFiles.RELEASES.byteLength,
        sha256: sha256(makerFiles.RELEASES),
      },
    },
  };
  await writeFile(
    join(evidenceRoot, "SQUIRREL-MAKER-PROVENANCE.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );

  const sourceInspector = async () => ({
    commit,
    trackedWorktreeClean: true,
    repository: null,
  });
  const unsignedInspector = async () => ({
    status: "NotSigned",
    statusMessage: "fixture path must not enter the manifest",
    signerSubject: null,
    signerThumbprint: null,
    timestamperSubject: null,
    timestamperThumbprint: null,
  });
  return {
    projectRoot,
    buildPath: buildRoot,
    buildRoot,
    makerRoot,
    evidenceRoot,
    setupPath: join(makerRoot, setupName),
    sourceInspector,
    unsignedInspector,
  };
}

describe("release candidate bundle", () => {
  it("binds maker outputs, compliance evidence, source, lockfile, and Authenticode state", async () => {
    const f = await fixture();
    const generated = await generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    });

    expect(generated.publicRelease).toBe(false);
    expect(generated.releaseId).toBe(`owncontext-v0.0.0-windows-x64-${commit.slice(0, 12)}-draft`);
    const manifestText = await readFile(generated.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest.status).toBe("DRAFT — NOT FOR PUBLIC RELEASE");
    expect(manifest.source).toEqual({
      commit,
      trackedWorktreeClean: true,
      repository: null,
    });
    expect(manifest.artifacts.map((file: { role: string }) => file.role)).toEqual([
      "windows-setup",
      "squirrel-full-package",
      "squirrel-releases-index",
    ]);
    expect(manifest.artifacts[0].authenticode).toEqual({
      status: "NotSigned",
      valid: false,
      timestamped: false,
      signerSubject: null,
      signerThumbprint: null,
      timestamperSubject: null,
      timestamperThumbprint: null,
    });
    expect(manifestText).not.toContain(f.projectRoot);
    expect(manifestText).not.toContain("fixture path must not enter the manifest");
    expect(manifest.projectLicense.status).toBe("unresolved");
    expect(manifest.readiness.blockers).toContain("installer-not-authenticode-valid");
    expect(manifest.readiness.blockers).toContain("project-license-unresolved");
    expect(manifest.releaseChecksums.entryCount).toBe(8);

    const checksums = await readFile(generated.releaseChecksumsPath, "utf8");
    expect(checksums).toContain("OwnContext-Developer-Preview-Unsigned-Setup.exe");
    expect(checksums).toContain("evidence/SOURCE-package-lock.json");
    expect(checksums.trim().split("\n")).toHaveLength(8);
    await expect(verifyReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).resolves.toMatchObject({ publicRelease: false });
  });

  it("rejects a maker file changed after provenance was recorded", async () => {
    const f = await fixture();
    await writeFile(f.setupPath, "tampered setup fixture");
    await expect(generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).rejects.toMatchObject({ code: "MAKER_OUTPUT_MISMATCH" });
    await expect(
      readFile(join(f.evidenceRoot, "SOURCE-package-lock.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unexpected maker output entries", async () => {
    const f = await fixture();
    await writeFile(join(f.makerRoot, "unexpected.exe"), "unexpected");
    await expect(generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).rejects.toMatchObject({ code: "OUTPUT_INVENTORY_INVALID" });
  });

  it("detects source-lockfile and artifact tampering during verification", async () => {
    const f = await fixture();
    await generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    });
    await writeFile(join(f.evidenceRoot, "SOURCE-package-lock.json"), "tampered lock");
    await expect(verifyReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).rejects.toMatchObject({ code: "SOURCE_LOCK_MISMATCH" });
  });

  it("does not turn an otherwise signed draft profile into a public release", async () => {
    const f = await fixture();
    const signatureInspector = async () => ({
      status: "Valid",
      statusMessage: "Valid",
      signerSubject: "CN=NextH fixture",
      signerThumbprint: "A".repeat(40),
      timestamperSubject: "CN=Timestamp fixture",
      timestamperThumbprint: "B".repeat(40),
    });
    const generated = await generateReleaseBundle({ ...f, signatureInspector });
    const manifest = JSON.parse(await readFile(generated.manifestPath, "utf8"));
    expect(manifest.artifacts[0].authenticode.valid).toBe(true);
    expect(manifest.artifacts[0].authenticode.timestamped).toBe(true);
    expect(manifest.release.publicRelease).toBe(false);
    expect(manifest.readiness.publicRelease).toBe(false);
    expect(manifest.readiness.blockers).not.toContain("installer-not-authenticode-valid");
    expect(manifest.readiness.blockers).toContain("signed-public-build-profile-not-implemented");
  });

  it("does not preselect or approve a future project license", async () => {
    const f = await fixture();
    const license = "MIT";
    const rootPackagePath = join(f.projectRoot, "package.json");
    const desktopPackagePath = join(f.projectRoot, "apps", "desktop", "package.json");
    const lockPath = join(f.projectRoot, "package-lock.json");
    const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
    const desktopPackage = JSON.parse(await readFile(desktopPackagePath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    rootPackage.license = license;
    desktopPackage.license = license;
    lock.packages["apps/desktop"].license = license;
    await writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    await writeFile(desktopPackagePath, `${JSON.stringify(desktopPackage, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(join(f.projectRoot, "LICENSE"), "future license text\n");

    const generated = await generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    });
    const manifest = JSON.parse(await readFile(generated.manifestPath, "utf8"));
    expect(manifest.projectLicense).toMatchObject({
      status: "declared-not-release-approved",
      spdx: license,
      licenseFilePresent: true,
      workspaceMetadataConsistent: true,
    });
    expect(manifest.readiness.blockers).toContain("project-license-not-release-approved");
    expect(manifest.readiness.blockers).not.toContain("project-license-unresolved");
  });

  it("refuses to overwrite an existing evidence bundle", async () => {
    const f = await fixture();
    await generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    });
    await expect(generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
  });
});
