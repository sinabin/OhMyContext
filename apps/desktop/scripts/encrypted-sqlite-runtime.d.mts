export const ENCRYPTED_SQLITE_PACKAGE_NAME: "better-sqlite3-multiple-ciphers";
export const ENCRYPTED_SQLITE_PACKAGE_VERSION: "13.0.3";
export const ENCRYPTED_SQLITE_PACKAGE_LICENSE: "MIT";
export const ENCRYPTED_SQLITE_PACKAGE_REPOSITORY: Readonly<{
  type: "git";
  url: "git://github.com/m4heshd/better-sqlite3-multiple-ciphers.git";
}>;
export const ENCRYPTED_SQLITE_PACKAGE_RESOLVED: "https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.0.3.tgz";
export const ENCRYPTED_SQLITE_PACKAGE_INTEGRITY: "sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==";
export const ENCRYPTED_SQLITE_NATIVE_SHA256: "d4f29082cde7efd5c1e85e794ba532efeef4f2f968c58cc54fe97c2095270262";
export const ENCRYPTED_SQLITE_RUNTIME_MANIFEST: "encrypted-sqlite-runtime-manifest.json";

export interface EncryptedSqliteRuntimeFileEvidence {
  readonly path: string;
  readonly length: number;
  readonly sha256: string;
}

export const ENCRYPTED_SQLITE_RUNTIME_FILE_PINS: readonly Readonly<EncryptedSqliteRuntimeFileEvidence>[];
export const ENCRYPTED_SQLITE_RUNTIME_FILES: readonly string[];

export interface EncryptedSqliteRuntimeManifest {
  readonly schemaVersion: 1;
  readonly artifact: "owncontext-encrypted-sqlite-runtime";
  readonly platform: "win32";
  readonly arch: "x64";
  readonly package: Readonly<{
    name: "better-sqlite3-multiple-ciphers";
    version: "13.0.3";
    license: "MIT";
    repository: Readonly<{
      type: "git";
      url: "git://github.com/m4heshd/better-sqlite3-multiple-ciphers.git";
    }>;
    resolved: "https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-13.0.3.tgz";
    lockfileIntegrity: "sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==";
  }>;
  readonly nativeBinary: Readonly<{
    path: "prebuilds/win32-x64.node";
    sha256: "d4f29082cde7efd5c1e85e794ba532efeef4f2f968c58cc54fe97c2095270262";
  }>;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly EncryptedSqliteRuntimeFileEvidence[];
  readonly boundary: Readonly<{
    status: "developer-candidate";
    publicDistributionApproved: false;
    sourceProvenance: "npm-registry-tarball-sri-derived-selected-file-pins";
    dependencyLicenseScope: "dependency-package-declaration-only-not-owncontext-project-license";
    proves: readonly [
      "selected-installed-source-files-match-registry-tarball-pins",
      "staged-payload-length-and-sha256",
    ];
    doesNotProve: readonly [
      "unselected-package-files-byte-equivalence-to-registry-tarball",
      "authenticode-signature",
      "source-rebuild-equivalence",
      "owncontext-project-license",
    ];
  }>;
}

export interface EncryptedSqliteRuntimeResult {
  readonly targetDirectory: string;
  readonly manifestPath: string;
  readonly packageName: "better-sqlite3-multiple-ciphers";
  readonly packageVersion: "13.0.3";
  readonly platform: "win32";
  readonly arch: "x64";
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly nativeBinaryPath: string;
  readonly nativeSha256: "d4f29082cde7efd5c1e85e794ba532efeef4f2f968c58cc54fe97c2095270262";
  readonly manifest: EncryptedSqliteRuntimeManifest;
}

export interface StageEncryptedSqliteRuntimeOptions {
  readonly sourceRoot: string;
  readonly lockfilePath: string;
  readonly targetDirectory: string;
}

export interface VerifyEncryptedSqliteRuntimeOptions {
  readonly targetDirectory: string;
}

export function stageEncryptedSqliteRuntime(
  options: StageEncryptedSqliteRuntimeOptions,
): Promise<EncryptedSqliteRuntimeResult>;

export function verifyEncryptedSqliteRuntime(
  options: VerifyEncryptedSqliteRuntimeOptions,
): Promise<EncryptedSqliteRuntimeResult>;
