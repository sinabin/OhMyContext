import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export const ENCRYPTED_SQLITE_PACKAGE_NAME =
  "better-sqlite3-multiple-ciphers";
export const ENCRYPTED_SQLITE_PACKAGE_VERSION = "13.0.3";
export const ENCRYPTED_SQLITE_PACKAGE_LICENSE = "MIT";
export const ENCRYPTED_SQLITE_PACKAGE_REPOSITORY = Object.freeze({
  type: "git",
  url: "git://github.com/m4heshd/better-sqlite3-multiple-ciphers.git",
});
export const ENCRYPTED_SQLITE_PACKAGE_RESOLVED =
  "https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.0.3.tgz";
export const ENCRYPTED_SQLITE_PACKAGE_INTEGRITY =
  "sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==";
export const ENCRYPTED_SQLITE_NATIVE_SHA256 =
  "d4f29082cde7efd5c1e85e794ba532efeef4f2f968c58cc54fe97c2095270262";
export const ENCRYPTED_SQLITE_RUNTIME_MANIFEST =
  "encrypted-sqlite-runtime-manifest.json";

// Derived from the exact npm registry 13.0.3 tarball only after independently
// hashing that archive to ENCRYPTED_SQLITE_PACKAGE_INTEGRITY. Reproduce with
// `npm pack better-sqlite3-multiple-ciphers@13.0.3 --ignore-scripts --json`
// in an OS-temporary directory, verify the tarball SHA-512 SRI, then hash these
// selected `package/` entries without transforming their bytes.
export const ENCRYPTED_SQLITE_RUNTIME_FILE_PINS = Object.freeze([
  Object.freeze({
    path: "LICENSE",
    length: 1123,
    sha256: "20a3fe2207b571d048cf004f2f29dde7b7b2c9def83e8464109da4c292c10f50",
  }),
  Object.freeze({
    path: "lib/database.js",
    length: 4813,
    sha256: "891f8fb19fccf3d5b6c67f8865de848c96bf0784a573f8050817017c2bbc8d82",
  }),
  Object.freeze({
    path: "lib/methods/aggregate.js",
    length: 1932,
    sha256: "e9f74eb919ec93fe089c95ddf25a98f1f631c80418fa34fb2346ca1bc29f1b82",
  }),
  Object.freeze({
    path: "lib/methods/backup.js",
    length: 2380,
    sha256: "ea29d34992bb02e006d0fdeda9675ac5d2bb227aaf57468decd997e9fc9c7dbf",
  }),
  Object.freeze({
    path: "lib/methods/explain.js",
    length: 292,
    sha256: "0bd8cc80ccc7338f1d93058beea0cde924d4e7e652da9f51267e7c0757361be7",
  }),
  Object.freeze({
    path: "lib/methods/function.js",
    length: 1396,
    sha256: "f431d49303b8bbdc044b1f1b455bdad21fc9b74b007de0acb22f08f25b4febd3",
  }),
  Object.freeze({
    path: "lib/methods/inspect.js",
    length: 174,
    sha256: "4975a78daee850adee62ba98719d0f223819a0ec135a07c0e302994bd8dbff61",
  }),
  Object.freeze({
    path: "lib/methods/pragma.js",
    length: 543,
    sha256: "d399bf1dbc85ef8a51f946c5a9505f2c37d0b1bed3f68863b1bf202d53d6524e",
  }),
  Object.freeze({
    path: "lib/methods/serialize.js",
    length: 625,
    sha256: "7a10ee5c2735384b7f0c361811bc6d017db29f62b203fd3c68a35f667e2c2605",
  }),
  Object.freeze({
    path: "lib/methods/table.js",
    length: 7243,
    sha256: "2356885ca1ef37d20f2daeed2b82b9dd6e61481e851194174a16d32efa3ae2f0",
  }),
  Object.freeze({
    path: "lib/methods/transaction.js",
    length: 2855,
    sha256: "40b71d6113f328f96cec8f6f888ffddd98b5926d38fb1e2746939c7daba93e2e",
  }),
  Object.freeze({
    path: "lib/methods/wrappers.js",
    length: 1464,
    sha256: "951f2c6262e2f3219eee76599006dbb72ccf121b4425dfc5f14dde2fa48130f7",
  }),
  Object.freeze({
    path: "lib/sqlite-error.js",
    length: 512,
    sha256: "903c140bb3d9d4f6256124889f5a820a491299907885d5b9d5ff2c4eaa268a06",
  }),
  Object.freeze({
    path: "lib/util.js",
    length: 331,
    sha256: "92b2e39e2151b43a2252e10b6d6de876ecaf0008336a4fa1dfe1317b20f1916f",
  }),
  Object.freeze({
    path: "lib/win32-x64.js",
    length: 163,
    sha256: "c25867a2e904a367743498377e6e156a653bd10bcc5f9be7cbdf8a28359012ef",
  }),
  Object.freeze({
    path: "package.json",
    length: 2717,
    sha256: "c34668d26d94fdec46deae4355b63d1b9b6c7219b85a08ea2e764d69b5e65668",
  }),
  Object.freeze({
    path: "prebuilds/win32-x64.node",
    length: 2365952,
    sha256: ENCRYPTED_SQLITE_NATIVE_SHA256,
  }),
]);

export const ENCRYPTED_SQLITE_RUNTIME_FILES = Object.freeze(
  ENCRYPTED_SQLITE_RUNTIME_FILE_PINS.map((entry) => entry.path),
);

const MANIFEST_SCHEMA_VERSION = 1;
const ARTIFACT_KIND = "owncontext-encrypted-sqlite-runtime";
const SUPPORTED_PLATFORM = "win32";
const SUPPORTED_ARCH = "x64";
const NATIVE_BINARY_PATH = "prebuilds/win32-x64.node";
const LOCKFILE_PACKAGE_PATH =
  "node_modules/better-sqlite3-multiple-ciphers";
const DESKTOP_WORKSPACE_PATH = "apps/desktop";
const MAX_LOCKFILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_LICENSE_BYTES = 256 * 1024;
const MAX_JAVASCRIPT_BYTES = 1024 * 1024;
const MAX_NATIVE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_RUNTIME_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 64;
const SHA256 = /^[0-9a-f]{64}$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/u;
const PINNED_RUNTIME_TOTAL_BYTES = ENCRYPTED_SQLITE_RUNTIME_FILE_PINS.reduce(
  (total, entry) => total + entry.length,
  0,
);

const EXPECTED_DIRECTORIES = Object.freeze([
  "lib",
  "lib/methods",
  "prebuilds",
]);

const EXPECTED_BOUNDARY = Object.freeze({
  status: "developer-candidate",
  publicDistributionApproved: false,
  sourceProvenance: "npm-registry-tarball-sri-derived-selected-file-pins",
  dependencyLicenseScope:
    "dependency-package-declaration-only-not-owncontext-project-license",
  proves: Object.freeze([
    "selected-installed-source-files-match-registry-tarball-pins",
    "staged-payload-length-and-sha256",
  ]),
  doesNotProve: Object.freeze([
    "unselected-package-files-byte-equivalence-to-registry-tarball",
    "authenticode-signature",
    "source-rebuild-equivalence",
    "owncontext-project-license",
  ]),
});

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(requireObject(value, label)).sort(comparePaths);
  const expected = [...expectedKeys].sort(comparePaths);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function folded(value) {
  return value.toLocaleLowerCase("en-US");
}

function hasErrorCode(error, code) {
  try {
    return isObject(error) && error.code === code;
  } catch {
    return false;
  }
}

function requireSafeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.startsWith("/") ||
    WINDOWS_DRIVE.test(value) ||
    value.split("/").some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${label} has an unsafe path.`);
  }
  return value;
}

function localPath(root, relativePath) {
  requireSafeRelativePath(relativePath, "Runtime entry");
  return join(root, ...relativePath.split("/"));
}

function assertInside(root, candidate, label) {
  const canonicalRoot = canonicalComparablePath(root);
  const canonicalCandidate = canonicalComparablePath(candidate);
  const difference = relative(canonicalRoot, canonicalCandidate);
  if (
    difference.length === 0 ||
    difference === ".." ||
    difference.startsWith("../") ||
    difference.startsWith("..\\")
  ) {
    throw new Error(`${label} escapes its runtime root.`);
  }
}

function canonicalComparablePath(value) {
  const normalized = resolve(value);
  try {
    return resolve(realpathSync.native(normalized));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    const parent = dirname(normalized);
    return join(canonicalComparablePath(parent), basename(normalized));
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertRealDirectory(path, canonicalRoot, label) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  const canonical = await realpath(path);
  if (canonicalRoot !== undefined) {
    assertInside(canonicalRoot, canonical, label);
  }
  const after = await lstat(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameIdentity(before, after)
  ) {
    throw new Error(`${label} changed during inspection.`);
  }
  return canonical;
}

async function readBoundedRegularFile(path, canonicalRoot, maxBytes, label) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file.`);
  }
  if (before.size < 0n || before.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds its size limit.`);
  }

  const canonical = await realpath(path);
  if (canonicalRoot !== undefined) assertInside(canonicalRoot, canonical, label);

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  const chunks = [];
  let length = 0;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`${label} changed before it was opened.`);
    }

    while (true) {
      const readSize = Math.min(64 * 1024, maxBytes - length + 1);
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) throw new Error(`${label} exceeds its size limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }

    const finalOpened = await handle.stat({ bigint: true });
    if (
      !finalOpened.isFile() ||
      !sameIdentity(opened, finalOpened) ||
      finalOpened.size !== BigInt(length)
    ) {
      throw new Error(`${label} changed while it was read.`);
    }
  } finally {
    await handle.close();
  }

  const after = await lstat(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    !sameIdentity(before, after) ||
    after.size !== BigInt(length)
  ) {
    throw new Error(`${label} changed during inspection.`);
  }

  const bytes = Buffer.concat(chunks, length);
  return Object.freeze({
    bytes,
    length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function parseJsonObject(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return requireObject(parsed, label);
}

function assertExpectedRepository(repository, label) {
  requireExactKeys(repository, ["type", "url"], label);
  if (
    repository.type !== ENCRYPTED_SQLITE_PACKAGE_REPOSITORY.type ||
    repository.url !== ENCRYPTED_SQLITE_PACKAGE_REPOSITORY.url
  ) {
    throw new Error(`${label} does not match the pinned repository.`);
  }
}

function assertExpectedPackageIdentity(packageJson, label) {
  if (
    packageJson.name !== ENCRYPTED_SQLITE_PACKAGE_NAME ||
    packageJson.version !== ENCRYPTED_SQLITE_PACKAGE_VERSION ||
    packageJson.license !== ENCRYPTED_SQLITE_PACKAGE_LICENSE
  ) {
    throw new Error(`${label} does not match the pinned package identity.`);
  }
  assertExpectedRepository(packageJson.repository, `${label} repository`);
  if (
    packageJson.exports?.["./win32-x64"] !== "./lib/win32-x64.js"
  ) {
    throw new Error(`${label} does not expose the pinned Windows x64 entrypoint.`);
  }
}

async function verifyPinnedLockfile(lockfilePath) {
  const evidence = await readBoundedRegularFile(
    resolve(lockfilePath),
    undefined,
    MAX_LOCKFILE_BYTES,
    "Package lockfile",
  );
  const lockfile = parseJsonObject(evidence.bytes, "Package lockfile");
  if (lockfile.lockfileVersion !== 3) {
    throw new Error("Package lockfile must use lockfileVersion 3.");
  }
  const packages = requireObject(lockfile.packages, "Package lockfile packages");
  const entry = requireObject(
    packages[LOCKFILE_PACKAGE_PATH],
    "Encrypted SQLite lockfile entry",
  );
  if (
    entry.version !== ENCRYPTED_SQLITE_PACKAGE_VERSION ||
    entry.license !== ENCRYPTED_SQLITE_PACKAGE_LICENSE ||
    entry.resolved !== ENCRYPTED_SQLITE_PACKAGE_RESOLVED ||
    entry.integrity !== ENCRYPTED_SQLITE_PACKAGE_INTEGRITY
  ) {
    throw new Error(
      "Encrypted SQLite lockfile entry does not match the exact pinned registry package.",
    );
  }
  const workspace = requireObject(
    packages[DESKTOP_WORKSPACE_PATH],
    "Desktop workspace lockfile entry",
  );
  const dependencies = requireObject(
    workspace.dependencies,
    "Desktop workspace locked dependencies",
  );
  if (dependencies[ENCRYPTED_SQLITE_PACKAGE_NAME] !== ENCRYPTED_SQLITE_PACKAGE_VERSION) {
    throw new Error("Desktop workspace does not use the exact encrypted SQLite version.");
  }
}

function maxBytesFor(relativePath) {
  if (relativePath === "package.json") return MAX_PACKAGE_JSON_BYTES;
  if (relativePath === "LICENSE") return MAX_LICENSE_BYTES;
  if (relativePath === NATIVE_BINARY_PATH) return MAX_NATIVE_BYTES;
  return MAX_JAVASCRIPT_BYTES;
}

async function inspectSource(sourceRoot) {
  const source = resolve(sourceRoot);
  const canonicalSource = await assertRealDirectory(
    source,
    undefined,
    "Encrypted SQLite source root",
  );
  for (const directory of EXPECTED_DIRECTORIES) {
    await assertRealDirectory(
      localPath(source, directory),
      canonicalSource,
      `Encrypted SQLite source directory ${directory}`,
    );
  }

  let totalBytes = 0;
  for (const expected of ENCRYPTED_SQLITE_RUNTIME_FILE_PINS) {
    const evidence = await readBoundedRegularFile(
      localPath(source, expected.path),
      canonicalSource,
      maxBytesFor(expected.path),
      `Encrypted SQLite source file ${expected.path}`,
    );
    totalBytes += evidence.length;
    if (totalBytes > MAX_RUNTIME_PAYLOAD_BYTES) {
      throw new Error("Encrypted SQLite source payload exceeds its total size limit.");
    }
    if (
      evidence.length !== expected.length ||
      evidence.sha256 !== expected.sha256
    ) {
      throw new Error(
        `Encrypted SQLite source file does not match the registry tarball pin: ${expected.path}`,
      );
    }
  }
  if (totalBytes !== PINNED_RUNTIME_TOTAL_BYTES) {
    throw new Error("Encrypted SQLite source payload differs from the fixed registry pins.");
  }

  const packageBytes = await readBoundedRegularFile(
    localPath(source, "package.json"),
    canonicalSource,
    MAX_PACKAGE_JSON_BYTES,
    "Encrypted SQLite package metadata",
  );
  const packagePin = ENCRYPTED_SQLITE_RUNTIME_FILE_PINS.find(
    (entry) => entry.path === "package.json",
  );
  if (!packagePin) throw new Error("Encrypted SQLite package metadata pin is missing.");
  if (packageBytes.length !== packagePin.length || packageBytes.sha256 !== packagePin.sha256) {
    throw new Error("Encrypted SQLite package metadata changed during inspection.");
  }
  assertExpectedPackageIdentity(
    parseJsonObject(packageBytes.bytes, "Encrypted SQLite package metadata"),
    "Encrypted SQLite package metadata",
  );

  const nativePin = ENCRYPTED_SQLITE_RUNTIME_FILE_PINS.find(
    (entry) => entry.path === NATIVE_BINARY_PATH,
  );
  if (!nativePin || nativePin.sha256 !== ENCRYPTED_SQLITE_NATIVE_SHA256) {
    throw new Error("Encrypted SQLite Windows x64 native binary hash is not approved.");
  }

  return Object.freeze({ source, canonicalSource });
}

function createManifest() {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    artifact: ARTIFACT_KIND,
    platform: SUPPORTED_PLATFORM,
    arch: SUPPORTED_ARCH,
    package: {
      name: ENCRYPTED_SQLITE_PACKAGE_NAME,
      version: ENCRYPTED_SQLITE_PACKAGE_VERSION,
      license: ENCRYPTED_SQLITE_PACKAGE_LICENSE,
      repository: {
        type: ENCRYPTED_SQLITE_PACKAGE_REPOSITORY.type,
        url: ENCRYPTED_SQLITE_PACKAGE_REPOSITORY.url,
      },
      resolved: ENCRYPTED_SQLITE_PACKAGE_RESOLVED,
      lockfileIntegrity: ENCRYPTED_SQLITE_PACKAGE_INTEGRITY,
    },
    nativeBinary: {
      path: NATIVE_BINARY_PATH,
      sha256: ENCRYPTED_SQLITE_NATIVE_SHA256,
    },
    fileCount: ENCRYPTED_SQLITE_RUNTIME_FILE_PINS.length,
    totalBytes: PINNED_RUNTIME_TOTAL_BYTES,
    files: ENCRYPTED_SQLITE_RUNTIME_FILE_PINS.map((entry) => ({ ...entry })),
    boundary: {
      status: EXPECTED_BOUNDARY.status,
      publicDistributionApproved: EXPECTED_BOUNDARY.publicDistributionApproved,
      sourceProvenance: EXPECTED_BOUNDARY.sourceProvenance,
      dependencyLicenseScope: EXPECTED_BOUNDARY.dependencyLicenseScope,
      proves: [...EXPECTED_BOUNDARY.proves],
      doesNotProve: [...EXPECTED_BOUNDARY.doesNotProve],
    },
  };
}

function canonicalManifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function assertStringArrayExact(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} does not match the fixed developer boundary.`);
  }
}

function validateManifest(manifest) {
  requireExactKeys(
    manifest,
    [
      "schemaVersion",
      "artifact",
      "platform",
      "arch",
      "package",
      "nativeBinary",
      "fileCount",
      "totalBytes",
      "files",
      "boundary",
    ],
    "Encrypted SQLite runtime manifest",
  );
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.artifact !== ARTIFACT_KIND
  ) {
    throw new Error("Encrypted SQLite runtime manifest has an unsupported identity.");
  }
  if (manifest.platform !== SUPPORTED_PLATFORM || manifest.arch !== SUPPORTED_ARCH) {
    throw new Error("Encrypted SQLite runtime manifest is not Windows x64.");
  }

  requireExactKeys(
    manifest.package,
    ["name", "version", "license", "repository", "resolved", "lockfileIntegrity"],
    "Encrypted SQLite runtime package identity",
  );
  if (
    manifest.package.name !== ENCRYPTED_SQLITE_PACKAGE_NAME ||
    manifest.package.version !== ENCRYPTED_SQLITE_PACKAGE_VERSION ||
    manifest.package.license !== ENCRYPTED_SQLITE_PACKAGE_LICENSE ||
    manifest.package.resolved !== ENCRYPTED_SQLITE_PACKAGE_RESOLVED ||
    manifest.package.lockfileIntegrity !== ENCRYPTED_SQLITE_PACKAGE_INTEGRITY
  ) {
    throw new Error("Encrypted SQLite runtime manifest has the wrong package version or provenance.");
  }
  assertExpectedRepository(
    manifest.package.repository,
    "Encrypted SQLite runtime package repository",
  );

  requireExactKeys(
    manifest.nativeBinary,
    ["path", "sha256"],
    "Encrypted SQLite native binary evidence",
  );
  if (
    manifest.nativeBinary.path !== NATIVE_BINARY_PATH ||
    manifest.nativeBinary.sha256 !== ENCRYPTED_SQLITE_NATIVE_SHA256
  ) {
    throw new Error("Encrypted SQLite runtime manifest has the wrong native binary evidence.");
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error("Encrypted SQLite runtime manifest has no file inventory.");
  }
  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const candidate of manifest.files) {
    requireExactKeys(candidate, ["path", "length", "sha256"], "Runtime file entry");
    const path = requireSafeRelativePath(candidate.path, "Runtime file entry");
    const key = folded(path);
    if (seen.has(key)) {
      throw new Error(`Encrypted SQLite runtime manifest contains a duplicate path: ${path}`);
    }
    seen.add(key);
    if (
      !Number.isSafeInteger(candidate.length) ||
      candidate.length < 0 ||
      candidate.length > maxBytesFor(path) ||
      typeof candidate.sha256 !== "string" ||
      !SHA256.test(candidate.sha256)
    ) {
      throw new Error(`Encrypted SQLite runtime manifest has invalid evidence for ${path}.`);
    }
    totalBytes += candidate.length;
    if (totalBytes > MAX_RUNTIME_PAYLOAD_BYTES) {
      throw new Error("Encrypted SQLite runtime manifest exceeds its total size limit.");
    }
    files.push(candidate);
  }
  if (files.length !== ENCRYPTED_SQLITE_RUNTIME_FILES.length) {
    throw new Error("Encrypted SQLite runtime manifest has the wrong file count.");
  }
  files.forEach((entry, index) => {
    const expected = ENCRYPTED_SQLITE_RUNTIME_FILE_PINS[index];
    if (!expected || entry.path !== expected.path) {
      throw new Error("Encrypted SQLite runtime manifest does not contain the exact allowlist.");
    }
    if (entry.length !== expected.length || entry.sha256 !== expected.sha256) {
      throw new Error(
        `Encrypted SQLite runtime manifest does not match the registry tarball pin: ${entry.path}`,
      );
    }
  });
  if (
    manifest.fileCount !== files.length ||
    manifest.totalBytes !== totalBytes
  ) {
    throw new Error("Encrypted SQLite runtime manifest summary is inconsistent.");
  }

  requireExactKeys(
    manifest.boundary,
    [
      "status",
      "publicDistributionApproved",
      "sourceProvenance",
      "dependencyLicenseScope",
      "proves",
      "doesNotProve",
    ],
    "Encrypted SQLite runtime boundary",
  );
  if (
    manifest.boundary.status !== EXPECTED_BOUNDARY.status ||
    manifest.boundary.publicDistributionApproved !== false ||
    manifest.boundary.sourceProvenance !== EXPECTED_BOUNDARY.sourceProvenance ||
    manifest.boundary.dependencyLicenseScope !==
      EXPECTED_BOUNDARY.dependencyLicenseScope
  ) {
    throw new Error("Encrypted SQLite runtime manifest exceeds the developer-candidate boundary.");
  }
  assertStringArrayExact(
    manifest.boundary.proves,
    EXPECTED_BOUNDARY.proves,
    "Encrypted SQLite runtime proof scope",
  );
  assertStringArrayExact(
    manifest.boundary.doesNotProve,
    EXPECTED_BOUNDARY.doesNotProve,
    "Encrypted SQLite runtime proof limitations",
  );
  return files;
}

async function createNewTargetDirectory(targetDirectory) {
  const target = resolve(targetDirectory);
  try {
    await lstat(target);
    throw new Error("Encrypted SQLite runtime target must be a new directory.");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  await assertRealDirectory(dirname(target), undefined, "Runtime target parent");
  await mkdir(target, { recursive: false });
  const canonicalTarget = await assertRealDirectory(
    target,
    undefined,
    "Encrypted SQLite runtime target",
  );
  const entries = await readdir(target);
  if (entries.length !== 0) {
    throw new Error("Encrypted SQLite runtime target is not empty.");
  }
  return Object.freeze({ target, canonicalTarget });
}

async function copyPayload(source, canonicalSource, target, canonicalTarget, files) {
  for (const directory of EXPECTED_DIRECTORIES) {
    const destination = localPath(target, directory);
    assertInside(canonicalTarget, resolve(destination), `Runtime target directory ${directory}`);
    await mkdir(destination, { recursive: false });
    await assertRealDirectory(
      destination,
      canonicalTarget,
      `Runtime target directory ${directory}`,
    );
  }

  for (const expected of files) {
    const sourcePath = localPath(source, expected.path);
    const destination = localPath(target, expected.path);
    assertInside(canonicalSource, await realpath(sourcePath), `Runtime source ${expected.path}`);
    assertInside(canonicalTarget, resolve(destination), `Runtime target ${expected.path}`);
    await copyFile(sourcePath, destination, fsConstants.COPYFILE_EXCL);
    const copied = await readBoundedRegularFile(
      destination,
      canonicalTarget,
      maxBytesFor(expected.path),
      `Staged runtime file ${expected.path}`,
    );
    if (
      copied.length !== expected.length ||
      copied.sha256 !== expected.sha256
    ) {
      throw new Error(`Staged runtime file changed while copying: ${expected.path}`);
    }
    const sourceAfter = await readBoundedRegularFile(
      sourcePath,
      canonicalSource,
      maxBytesFor(expected.path),
      `Encrypted SQLite source file ${expected.path}`,
    );
    if (
      sourceAfter.length !== expected.length ||
      sourceAfter.sha256 !== expected.sha256
    ) {
      throw new Error(`Encrypted SQLite source changed while copying: ${expected.path}`);
    }
  }
}

async function collectRuntimeTree(root, canonicalRoot) {
  const files = new Map();
  const directories = new Set();
  const foldedEntries = new Set();
  let entryCount = 0;
  let totalFileBytes = 0;

  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) {
        throw new Error("Encrypted SQLite runtime contains too many filesystem entries.");
      }
      const entryPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      requireSafeRelativePath(entryPath, "Runtime filesystem entry");
      const foldedPath = folded(entryPath);
      if (foldedEntries.has(foldedPath)) {
        throw new Error(`Encrypted SQLite runtime contains a case-folded duplicate: ${entryPath}`);
      }
      foldedEntries.add(foldedPath);

      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`Encrypted SQLite runtime contains a symlink: ${entryPath}`);
      }
      const canonical = await realpath(absolute);
      assertInside(canonicalRoot, canonical, `Runtime filesystem entry ${entryPath}`);
      if (stat.isDirectory()) {
        directories.add(entryPath);
        await visit(absolute, entryPath);
      } else if (stat.isFile()) {
        totalFileBytes += Number(stat.size);
        if (totalFileBytes > MAX_RUNTIME_PAYLOAD_BYTES + MAX_MANIFEST_BYTES) {
          throw new Error("Encrypted SQLite runtime tree exceeds its total size limit.");
        }
        files.set(entryPath, Number(stat.size));
      } else {
        throw new Error(`Encrypted SQLite runtime contains a non-regular entry: ${entryPath}`);
      }
    }
  }

  await visit(root, "");
  return Object.freeze({ files, directories });
}

/**
 * Stage the exact unpublished Windows x64 developer-candidate runtime.
 *
 * The target must not exist. The function creates it once, copies every file
 * exclusively, writes a canonical manifest, and verifies the completed tree.
 * A failed staging attempt is intentionally left as an unmistakably incomplete
 * directory; callers must never treat a directory without successful verify()
 * evidence as usable.
 */
export async function stageEncryptedSqliteRuntime({
  sourceRoot,
  lockfilePath,
  targetDirectory,
}) {
  if (
    typeof sourceRoot !== "string" ||
    typeof lockfilePath !== "string" ||
    typeof targetDirectory !== "string"
  ) {
    throw new Error("Encrypted SQLite runtime staging paths must be strings.");
  }
  await verifyPinnedLockfile(lockfilePath);
  const source = await inspectSource(sourceRoot);
  const target = await createNewTargetDirectory(targetDirectory);
  await copyPayload(
    source.source,
    source.canonicalSource,
    target.target,
    target.canonicalTarget,
    ENCRYPTED_SQLITE_RUNTIME_FILE_PINS,
  );

  const manifest = createManifest();
  const manifestBytes = canonicalManifestBytes(manifest);
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error("Encrypted SQLite runtime manifest exceeds its size limit.");
  }
  const manifestPath = localPath(target.target, ENCRYPTED_SQLITE_RUNTIME_MANIFEST);
  await writeFile(manifestPath, manifestBytes, { flag: "wx" });
  return verifyEncryptedSqliteRuntime({ targetDirectory: target.target });
}

/** Verify the exact allowlist, canonical evidence, byte hashes, and boundary. */
export async function verifyEncryptedSqliteRuntime({ targetDirectory }) {
  if (typeof targetDirectory !== "string") {
    throw new Error("Encrypted SQLite runtime target path must be a string.");
  }
  const target = resolve(targetDirectory);
  const canonicalTarget = await assertRealDirectory(
    target,
    undefined,
    "Encrypted SQLite runtime target",
  );
  const manifestPath = localPath(target, ENCRYPTED_SQLITE_RUNTIME_MANIFEST);
  const manifestEvidence = await readBoundedRegularFile(
    manifestPath,
    canonicalTarget,
    MAX_MANIFEST_BYTES,
    "Encrypted SQLite runtime manifest",
  );
  const manifest = parseJsonObject(
    manifestEvidence.bytes,
    "Encrypted SQLite runtime manifest",
  );
  if (!manifestEvidence.bytes.equals(canonicalManifestBytes(manifest))) {
    throw new Error("Encrypted SQLite runtime manifest is not canonical JSON.");
  }
  const files = validateManifest(manifest);

  const tree = await collectRuntimeTree(target, canonicalTarget);
  const expectedDirectories = new Set(EXPECTED_DIRECTORIES);
  if (
    tree.directories.size !== expectedDirectories.size ||
    [...tree.directories].some((path) => !expectedDirectories.has(path))
  ) {
    throw new Error("Encrypted SQLite runtime contains an unexpected or missing directory.");
  }
  const expectedFiles = new Set([
    ...ENCRYPTED_SQLITE_RUNTIME_FILES,
    ENCRYPTED_SQLITE_RUNTIME_MANIFEST,
  ]);
  if (
    tree.files.size !== expectedFiles.size ||
    [...tree.files.keys()].some((path) => !expectedFiles.has(path))
  ) {
    throw new Error("Encrypted SQLite runtime contains an unexpected or missing file.");
  }

  let verifiedBytes = 0;
  for (const expected of files) {
    if (!tree.files.has(expected.path)) {
      throw new Error(`Encrypted SQLite runtime is missing ${expected.path}.`);
    }
    const evidence = await readBoundedRegularFile(
      localPath(target, expected.path),
      canonicalTarget,
      maxBytesFor(expected.path),
      `Encrypted SQLite runtime file ${expected.path}`,
    );
    if (
      evidence.length !== expected.length ||
      evidence.sha256 !== expected.sha256
    ) {
      throw new Error(`Encrypted SQLite runtime file is missing or modified: ${expected.path}`);
    }
    verifiedBytes += evidence.length;
  }
  if (verifiedBytes !== manifest.totalBytes) {
    throw new Error("Encrypted SQLite runtime verified byte count is inconsistent.");
  }

  const stagedPackage = await readBoundedRegularFile(
    localPath(target, "package.json"),
    canonicalTarget,
    MAX_PACKAGE_JSON_BYTES,
    "Staged encrypted SQLite package metadata",
  );
  assertExpectedPackageIdentity(
    parseJsonObject(stagedPackage.bytes, "Staged encrypted SQLite package metadata"),
    "Staged encrypted SQLite package metadata",
  );

  return Object.freeze({
    targetDirectory: canonicalTarget,
    manifestPath: await realpath(manifestPath),
    packageName: ENCRYPTED_SQLITE_PACKAGE_NAME,
    packageVersion: ENCRYPTED_SQLITE_PACKAGE_VERSION,
    platform: SUPPORTED_PLATFORM,
    arch: SUPPORTED_ARCH,
    fileCount: files.length,
    totalBytes: verifiedBytes,
    nativeBinaryPath: await realpath(localPath(target, NATIVE_BINARY_PATH)),
    nativeSha256: ENCRYPTED_SQLITE_NATIVE_SHA256,
    manifest,
  });
}
