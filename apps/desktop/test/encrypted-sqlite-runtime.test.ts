import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENCRYPTED_SQLITE_NATIVE_SHA256,
  ENCRYPTED_SQLITE_PACKAGE_INTEGRITY,
  ENCRYPTED_SQLITE_RUNTIME_FILE_PINS,
  ENCRYPTED_SQLITE_RUNTIME_FILES,
  ENCRYPTED_SQLITE_RUNTIME_MANIFEST,
  stageEncryptedSqliteRuntime,
  verifyEncryptedSqliteRuntime,
} from "../scripts/encrypted-sqlite-runtime.mjs";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SOURCE_ROOT = join(
  REPOSITORY_ROOT,
  "node_modules",
  "better-sqlite3-multiple-ciphers",
);
const LOCKFILE_PATH = join(REPOSITORY_ROOT, "package-lock.json");

const temporaryRoots = new Set<string>();

afterEach(async () => {
  for (const root of temporaryRoots) {
    await rm(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("encrypted SQLite Windows runtime staging", () => {
  it("stages and verifies the exact unpublished developer candidate", async () => {
    const { target } = await stageFixture();
    const result = await verifyEncryptedSqliteRuntime({ targetDirectory: target });

    expect(result.packageName).toBe("better-sqlite3-multiple-ciphers");
    expect(result.packageVersion).toBe("13.0.3");
    expect(result.platform).toBe("win32");
    expect(result.arch).toBe("x64");
    expect(result.fileCount).toBe(ENCRYPTED_SQLITE_RUNTIME_FILES.length);
    expect(result.nativeSha256).toBe(ENCRYPTED_SQLITE_NATIVE_SHA256);
    expect(result.manifest.package.lockfileIntegrity).toBe(
      ENCRYPTED_SQLITE_PACKAGE_INTEGRITY,
    );
    expect(result.manifest.boundary).toEqual({
      status: "developer-candidate",
      publicDistributionApproved: false,
      sourceProvenance: "npm-registry-tarball-sri-derived-selected-file-pins",
      dependencyLicenseScope:
        "dependency-package-declaration-only-not-owncontext-project-license",
      proves: [
        "selected-installed-source-files-match-registry-tarball-pins",
        "staged-payload-length-and-sha256",
      ],
      doesNotProve: [
        "unselected-package-files-byte-equivalence-to-registry-tarball",
        "authenticode-signature",
        "source-rebuild-equivalence",
        "owncontext-project-license",
      ],
    });
    expect(result.manifest.files).toEqual(ENCRYPTED_SQLITE_RUNTIME_FILE_PINS);
  });

  it("creates byte-identical canonical manifests for identical inputs", async () => {
    const first = await stageFixture();
    const second = await stageFixture();
    const [firstManifest, secondManifest] = await Promise.all([
      readFile(join(first.target, ENCRYPTED_SQLITE_RUNTIME_MANIFEST)),
      readFile(join(second.target, ENCRYPTED_SQLITE_RUNTIME_MANIFEST)),
    ]);

    expect(secondManifest.equals(firstManifest)).toBe(true);
  });

  it("requires a new target rather than reusing an empty directory", async () => {
    const root = await temporaryRoot();
    const target = join(root, "runtime");
    await mkdir(target);

    await expect(stageEncryptedSqliteRuntime({
      sourceRoot: SOURCE_ROOT,
      lockfilePath: LOCKFILE_PATH,
      targetDirectory: target,
    })).rejects.toThrow(/target must be a new directory/u);
  });

  it("rejects a lockfile whose registry integrity is not the exact pin", async () => {
    const root = await temporaryRoot();
    const lockfile = JSON.parse(await readFile(LOCKFILE_PATH, "utf8")) as {
      packages: Record<string, { integrity?: string }>;
    };
    const entry = lockfile.packages[
      "node_modules/better-sqlite3-multiple-ciphers"
    ];
    if (!entry) throw new Error("Encrypted SQLite lock fixture is missing.");
    entry.integrity = "sha512-not-the-approved-package";
    const changedLockfile = join(root, "package-lock.json");
    await writeFile(changedLockfile, JSON.stringify(lockfile));

    await expect(stageEncryptedSqliteRuntime({
      sourceRoot: SOURCE_ROOT,
      lockfilePath: changedLockfile,
      targetDirectory: join(root, "runtime"),
    })).rejects.toThrow(/exact pinned registry package/u);
  });

  it("rejects a symlink source root", async () => {
    const root = await temporaryRoot();
    const linkedSource = join(root, "linked-source");
    await symlink(
      SOURCE_ROOT,
      linkedSource,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(stageEncryptedSqliteRuntime({
      sourceRoot: linkedSource,
      lockfilePath: LOCKFILE_PATH,
      targetDirectory: join(root, "runtime"),
    })).rejects.toThrow(/source root must be a non-symlink directory/u);
  });

  it("rejects a symlink inside the selected source entries", async () => {
    const staged = await stageFixture();
    const externalMethods = join(staged.root, "external-methods");
    const methods = join(staged.target, "lib", "methods");
    await cp(methods, externalMethods, { recursive: true, errorOnExist: true });
    await rm(methods, { recursive: true });
    await symlink(
      externalMethods,
      methods,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(stageEncryptedSqliteRuntime({
      sourceRoot: staged.target,
      lockfilePath: LOCKFILE_PATH,
      targetDirectory: join(staged.root, "second-runtime"),
    })).rejects.toThrow(/source directory lib\/methods must be a non-symlink directory/u);
  });

  it("rejects changed package identity at the staging boundary", async () => {
    const staged = await stageFixture();
    const packagePath = join(staged.target, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      repository: { url: string };
    };
    packageJson.repository.url = "https://example.invalid/untrusted.git";
    await writeFile(packagePath, JSON.stringify(packageJson));

    await expect(stageEncryptedSqliteRuntime({
      sourceRoot: staged.target,
      lockfilePath: LOCKFILE_PATH,
      targetDirectory: join(staged.root, "second-runtime"),
    })).rejects.toThrow(/does not match the registry tarball pin: package\.json/u);
  });

  it("fails closed before staging a source wrapper that intercepts keys", async () => {
    const staged = await stageFixture();
    const wrapper = join(staged.target, "lib", "methods", "wrappers.js");
    await appendFile(
      wrapper,
      "\nmodule.exports.key = function interceptedKey() { return 0; };\n",
    );

    await expect(stageEncryptedSqliteRuntime({
      sourceRoot: staged.target,
      lockfilePath: LOCKFILE_PATH,
      targetDirectory: join(staged.root, "second-runtime"),
    })).rejects.toThrow(
      /does not match the registry tarball pin: lib\/methods\/wrappers\.js/u,
    );
    await expect(
      verifyEncryptedSqliteRuntime({
        targetDirectory: join(staged.root, "second-runtime"),
      }),
    ).rejects.toThrow();
  });

  it("rejects a missing allowlisted file", async () => {
    const { target } = await stageFixture();
    await unlink(join(target, "LICENSE"));

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/unexpected or missing file/u);
  });

  it("rejects an extra file", async () => {
    const { target } = await stageFixture();
    await writeFile(join(target, "unreviewed.js"), "module.exports = true;\n");

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/unexpected or missing file/u);
  });

  it("rejects modified payload bytes", async () => {
    const { target } = await stageFixture();
    await appendFile(join(target, "lib", "util.js"), "\n// modified\n");

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/missing or modified: lib\/util\.js/u);
  });

  it("rejects symlinks in the staged tree", async () => {
    const staged = await stageFixture();
    const externalMethods = join(staged.root, "external-methods");
    const methods = join(staged.target, "lib", "methods");
    await cp(methods, externalMethods, { recursive: true, errorOnExist: true });
    await rm(methods, { recursive: true });
    await symlink(
      externalMethods,
      methods,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: staged.target }))
      .rejects.toThrow(/contains a symlink: lib\/methods/u);
  });

  it("rejects a manifest path escape", async () => {
    const { target } = await stageFixture();
    await mutateManifest(target, (manifest) => {
      manifest.files[0]!.path = "../LICENSE";
    });

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/unsafe path/u);
  });

  it.each([
    ["architecture", (manifest: MutableManifest) => { manifest.arch = "arm64"; }],
    ["version", (manifest: MutableManifest) => { manifest.package.version = "13.0.2"; }],
  ])("rejects the wrong %s", async (_label, mutate) => {
    const { target } = await stageFixture();
    await mutateManifest(target, mutate);

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/not Windows x64|wrong package version/u);
  });

  it("rejects duplicate manifest paths before accepting its summary", async () => {
    const { target } = await stageFixture();
    await mutateManifest(target, (manifest) => {
      manifest.files.push({ ...manifest.files[0]! });
      manifest.fileCount += 1;
      manifest.totalBytes += manifest.files[0]!.length;
    });

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/duplicate path/u);
  });

  it("rejects non-canonical manifest serialization", async () => {
    const { target } = await stageFixture();
    const manifestPath = join(target, ENCRYPTED_SQLITE_RUNTIME_MANIFEST);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/not canonical JSON/u);
  });

  it("rejects changed staged package identity even with a rewritten manifest hash", async () => {
    const { target } = await stageFixture();
    const packagePath = join(target, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      version: string;
    };
    packageJson.version = "13.0.2";
    const packageBytes = Buffer.from(JSON.stringify(packageJson));
    await writeFile(packagePath, packageBytes);
    await mutateManifest(target, (manifest) => {
      const entry = manifest.files.find((candidate) => candidate.path === "package.json");
      if (!entry) throw new Error("Package manifest fixture is missing.");
      entry.length = packageBytes.length;
      entry.sha256 = sha256(packageBytes);
      manifest.totalBytes = manifest.files.reduce(
        (total, candidate) => total + candidate.length,
        0,
      );
    });

    await expect(verifyEncryptedSqliteRuntime({ targetDirectory: target }))
      .rejects.toThrow(/does not match the registry tarball pin: package\.json/u);
  });
});

interface MutableManifestFile {
  path: string;
  length: number;
  sha256: string;
}

interface MutableManifest {
  arch: string;
  package: { version: string };
  fileCount: number;
  totalBytes: number;
  files: MutableManifestFile[];
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "owncontext-encrypted-runtime-"));
  temporaryRoots.add(root);
  return root;
}

async function stageFixture(): Promise<{ root: string; target: string }> {
  const root = await temporaryRoot();
  const target = join(root, "runtime");
  await stageEncryptedSqliteRuntime({
    sourceRoot: SOURCE_ROOT,
    lockfilePath: LOCKFILE_PATH,
    targetDirectory: target,
  });
  return { root, target };
}

async function mutateManifest(
  target: string,
  mutate: (manifest: MutableManifest) => void,
): Promise<void> {
  const manifestPath = join(target, ENCRYPTED_SQLITE_RUNTIME_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
