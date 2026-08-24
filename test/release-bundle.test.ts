import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOWS_KEY_STORAGE_BOUNDARY } from "../scripts/key-storage-evidence-policy.mjs";
import {
  generateReleaseBundle,
  inspectKeyStorageEvidenceFile,
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
  const keyStorageEvidence = {
    schemaVersion: 2,
    status: "DRAFT — NOT FOR PUBLIC RELEASE",
    control: "windows-safe-storage-key-envelope-spike",
    result: "PASS",
    runtime: { platform: "win32", architecture: "x64", isPackaged: true },
    protector: { providerId: "electron-safe-storage", asyncAvailable: true },
    envelope: {
      schemaVersion: 1,
      keyBytes: 32,
      persisted: true,
      knownPlaintextEncodingsAbsent: true,
      roundTripMatched: true,
      shouldReEncrypt: false,
    },
    boundary: WINDOWS_KEY_STORAGE_BOUNDARY,
  };
  await writeFile(
    join(evidenceRoot, "WINDOWS-KEY-STORAGE-SMOKE.json"),
    `${JSON.stringify(keyStorageEvidence, null, 2)}\n`,
  );

  const sourceInspector = async () => ({
    commit,
    trackedWorktreeClean: true,
    repository: null,
  });
  const unsignedInspector = async (path: string) => ({
    status: "NotSigned",
    statusMessage: "fixture path must not enter the manifest",
    inspectedSha256: sha256(await readFile(path)),
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
      inspectedSha256: sha256("unsigned setup fixture"),
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
    expect(manifest.releaseChecksums.entryCount).toBe(9);

    const checksums = await readFile(generated.releaseChecksumsPath, "utf8");
    expect(checksums).toContain("OwnContext-Developer-Preview-Unsigned-Setup.exe");
    expect(checksums).toContain("evidence/SOURCE-package-lock.json");
    expect(checksums).toContain("evidence/WINDOWS-KEY-STORAGE-SMOKE.json");
    expect(checksums.trim().split("\n")).toHaveLength(9);
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

  it("rejects self-asserted or malformed packaged key-storage evidence", async () => {
    const f = await fixture();
    const evidencePath = join(f.evidenceRoot, "WINDOWS-KEY-STORAGE-SMOKE.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.envelope.knownPlaintextEncodingsAbsent = false;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    await expect(generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).rejects.toMatchObject({ code: "KEY_STORAGE_EVIDENCE_INVALID" });
  });

  it("rejects packaged key-storage evidence that overclaims real-vault encryption", async () => {
    const f = await fixture();
    const evidencePath = join(f.evidenceRoot, "WINDOWS-KEY-STORAGE-SMOKE.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.boundary.proves = "The real SQLite vault is fully encrypted and release-ready.";
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    await expect(generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    })).rejects.toMatchObject({ code: "KEY_STORAGE_EVIDENCE_INVALID" });
  });

  it("rejects a parent-junction swap between containment check and evidence open", async () => {
    const f = await fixture();
    const evidenceDirectory = join(f.buildRoot, "evidence");
    const evidencePath = join(evidenceDirectory, "WINDOWS-KEY-STORAGE-SMOKE.json");
    const preservedDirectory = join(f.buildRoot, "evidence-before-swap");
    const outsideDirectory = join(f.projectRoot, "outside-evidence");
    await mkdir(outsideDirectory);
    await copyFile(
      evidencePath,
      join(outsideDirectory, "WINDOWS-KEY-STORAGE-SMOKE.json"),
    );
    let swapped = false;

    await expect(inspectKeyStorageEvidenceFile({
      buildRoot: f.buildRoot,
      path: evidencePath,
      openFile: async (path, flags) => {
        if (!swapped) {
          swapped = true;
          await rename(evidenceDirectory, preservedDirectory);
          await symlink(
            outsideDirectory,
            evidenceDirectory,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return open(path, flags);
      },
    })).rejects.toMatchObject({ code: "FILE_CHANGED" });
  });

  it("rejects deletion between evidence path validation and open", async () => {
    const f = await fixture();
    const evidencePath = join(f.evidenceRoot, "WINDOWS-KEY-STORAGE-SMOKE.json");

    await expect(inspectKeyStorageEvidenceFile({
      buildRoot: f.buildRoot,
      path: evidencePath,
      openFile: async (path, flags) => {
        await rm(path);
        return open(path, flags);
      },
    })).rejects.toMatchObject({ code: "FILE_CHANGED" });
  });

  it("rejects an equal-length in-place evidence rewrite during inspection", async () => {
    const f = await fixture();
    const evidencePath = join(f.evidenceRoot, "WINDOWS-KEY-STORAGE-SMOKE.json");
    const original = await readFile(evidencePath);
    const marker = Buffer.from('"result": "PASS"', "utf8");
    const replacement = Buffer.from('"result": "FAIL"', "utf8");
    const markerOffset = original.indexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    const writer = await open(evidencePath, "r+");
    let mutated = false;

    await expect(inspectKeyStorageEvidenceFile({
      buildRoot: f.buildRoot,
      path: evidencePath,
      openFile: async (path, flags) => {
        const reader = await open(path, flags);
        return {
          stat: reader.stat.bind(reader),
          read: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            const result = await reader.read(buffer, offset, length, position);
            if (!mutated && result.bytesRead > 0) {
              mutated = true;
              await writer.write(replacement, 0, replacement.byteLength, markerOffset);
              await writer.sync();
              await writer.close();
            }
            return result;
          },
          close: reader.close.bind(reader),
        };
      },
    })).rejects.toMatchObject({ code: "FILE_CHANGED" });

    if (!mutated) await writer.close();
  });

  it("rejects an installer changed by the Authenticode inspection phase", async () => {
    const f = await fixture();
    const signatureInspector = async (path: string) => {
      const bytes = await readFile(path);
      bytes[0] ^= 0xff;
      await writeFile(path, bytes);
      return f.unsignedInspector(path);
    };

    await expect(generateReleaseBundle({ ...f, signatureInspector }))
      .rejects.toMatchObject({ code: "AUTHENTICODE_TARGET_MISMATCH" });
  });

  it("rejects Authenticode evidence from transient replacement bytes", async () => {
    const f = await fixture();
    const signatureInspector = async (path: string) => {
      const original = await readFile(path);
      const replacement = Buffer.from(original);
      replacement[0] ^= 0xff;
      await writeFile(path, replacement);
      const inspected = await f.unsignedInspector(path);
      await writeFile(path, original);
      return inspected;
    };

    await expect(generateReleaseBundle({ ...f, signatureInspector }))
      .rejects.toMatchObject({ code: "AUTHENTICODE_TARGET_MISMATCH" });
  });

  it("rejects maker provenance changed after artifact validation", async () => {
    const f = await fixture();
    const provenancePath = join(f.evidenceRoot, "SQUIRREL-MAKER-PROVENANCE.json");
    const signatureInspector = async (path: string) => {
      await writeFile(provenancePath, "{}\n");
      return f.unsignedInspector(path);
    };

    await expect(generateReleaseBundle({ ...f, signatureInspector }))
      .rejects.toMatchObject({ code: "FILE_CHANGED" });
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
    const signatureInspector = async (path: string) => ({
      status: "Valid",
      statusMessage: "Valid",
      inspectedSha256: sha256(await readFile(path)),
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

  it("requires an explicit status-file approval marker before opening the license gate", async () => {
    const f = await fixture();
    const rootPackagePath = join(f.projectRoot, "package.json");
    const desktopPackagePath = join(f.projectRoot, "apps", "desktop", "package.json");
    const lockPath = join(f.projectRoot, "package-lock.json");
    const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
    const desktopPackage = JSON.parse(await readFile(desktopPackagePath, "utf8"));
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    rootPackage.license = "MIT";
    desktopPackage.license = "MIT";
    lock.packages["apps/desktop"].license = "MIT";
    await writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    await writeFile(desktopPackagePath, `${JSON.stringify(desktopPackage, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await writeFile(join(f.projectRoot, "LICENSE"), "future license text\n");
    await writeFile(
      join(f.projectRoot, "LICENSE-STATUS.md"),
      "# License status\n\nPublic release license approval: approved\n",
    );

    const generated = await generateReleaseBundle({
      ...f,
      signatureInspector: f.unsignedInspector,
    });
    const manifest = JSON.parse(await readFile(generated.manifestPath, "utf8"));
    expect(manifest.projectLicense).toMatchObject({
      status: "release-approved",
      spdx: "MIT",
      licenseFilePresent: true,
      workspaceMetadataConsistent: true,
      releaseApprovalRecorded: true,
    });
    expect(manifest.readiness.blockers).not.toContain("project-license-unresolved");
    expect(manifest.readiness.blockers).not.toContain("project-license-not-release-approved");
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
