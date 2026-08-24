import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { TextDecoder } from "node:util";
import {
  fetchDocument,
  importDirectory,
  searchVault,
  type Vault,
} from "@owncontext/core";
import {
  ENCRYPTED_SQLITE_ENGINE_IDENTITY,
  createEncryptedSqliteProvider,
  type EncryptedSqliteProviderRuntime,
} from "./encrypted-sqlite-provider.js";
import {
  ElectronSafeStorageKeyProtector,
  MAX_VAULT_KEY_ENVELOPE_BYTES,
  VAULT_KEY_PROVIDER_ID,
  type SafeStorageLike,
} from "./vault-key-envelope.js";
import {
  MAX_WINDOWS_VAULT_STATE_BYTES,
  WINDOWS_ENCRYPTED_VAULT_FILE_NAME,
  WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME,
  WINDOWS_VAULT_STATE_FILE_NAME,
  WINDOWS_VAULT_STATE_SCHEMA_VERSION,
  openWindowsEncryptedVaultCandidate,
} from "./vault-key-manager.js";

export const ENCRYPTED_VAULT_SMOKE_ARGUMENT =
  "--owncontext-encrypted-vault-smoke" as const;
export const ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME =
  "OWNCONTEXT_ENCRYPTED_VAULT_SMOKE_ROOT" as const;
export const ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME =
  "OWNCONTEXT_ENCRYPTED_VAULT_SMOKE_NONCE" as const;
export const ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME =
  "encrypted-vault-smoke.json" as const;
export const ENCRYPTED_VAULT_SMOKE_RESULT_SCHEMA_VERSION = 1 as const;
export const ENCRYPTED_VAULT_SMOKE_STATUS =
  "windows-encrypted-vault-developer-candidate-reopen-complete" as const;
export const ENCRYPTED_VAULT_SMOKE_RELEASE_BOUNDARY =
  "developer-candidate-not-public-release" as const;
export const ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE = Object.freeze([
  "normal-desktop-and-mcp-vault-integration",
  "complete-plaintext-absence-beyond-one-fixture-and-five-encodings",
  "logs-user-data-os-temp-pagefile-and-backup-coverage",
  "process-restart-crash-and-power-loss-recovery",
  "resistance-to-concurrent-same-user-vault-directory-tampering",
] as const);
export const ENCRYPTED_VAULT_SMOKE_PROVIDER_ID =
  "sqlite3mc-chacha20-windows-x64" as const;
export const ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES = 16 * 1024;

const SUPPORTED_PLATFORM = "win32" as const;
const SUPPORTED_ARCHITECTURE = "x64" as const;
const USER_DATA_DIRECTORY_NAME = "electron-user-data";
const VAULT_DIRECTORY_NAME = "encrypted-vault";
const FIXTURE_DIRECTORY_NAME = "fixture-source";
const FIXTURE_FILE_NAME = "encrypted-vault-smoke.md";
const FIXTURE_COLLECTION = "encrypted-vault-smoke";
const FIXTURE_SOURCE_NAME = "Encrypted vault smoke fixture";
const FIXTURE_CANARY_PREFIX = "owncontextencryptedvaultsmoke";
const PACKAGED_RUNTIME_ENTRY_SEGMENTS = Object.freeze([
  "encrypted-sqlite-runtime",
  "lib",
  "win32-x64.js",
] as const);
const SQLITE_SIDECAR_SUFFIXES = Object.freeze([
  "-wal",
  "-shm",
  "-journal",
] as const);
const MAX_DATABASE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_SCANNED_ARTIFACT_BYTES = 128 * 1024 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface EncryptedVaultSmokeContext {
  readonly rootPath: string;
  readonly userDataPath: string;
  readonly vaultDirectoryPath: string;
  readonly fixtureDirectoryPath: string;
  readonly fixturePath: string;
  readonly resultPath: string;
  readonly nonce: string;
}

export interface EncryptedVaultSmokeResult {
  readonly schemaVersion: typeof ENCRYPTED_VAULT_SMOKE_RESULT_SCHEMA_VERSION;
  readonly status: typeof ENCRYPTED_VAULT_SMOKE_STATUS;
  readonly nonce: string;
  readonly platform: typeof SUPPORTED_PLATFORM;
  readonly architecture: typeof SUPPORTED_ARCHITECTURE;
  readonly isPackaged: true;
  readonly releaseBoundary: typeof ENCRYPTED_VAULT_SMOKE_RELEASE_BOUNDARY;
  readonly publicReleaseApproved: false;
  readonly doesNotProve: typeof ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE;
  readonly providerId: typeof ENCRYPTED_VAULT_SMOKE_PROVIDER_ID;
  readonly keyProtectorProviderId: typeof VAULT_KEY_PROVIDER_ID;
  readonly engineIdentity: typeof ENCRYPTED_SQLITE_ENGINE_IDENTITY;
  readonly safeStorageAsyncAvailable: true;
  readonly fixtureImported: true;
  readonly initialSearchMatched: true;
  readonly initialFetchMatched: true;
  readonly reopenSearchMatched: true;
  readonly reopenFetchMatched: true;
  readonly stateReady: true;
  readonly vaultIdentityMatched: true;
  readonly keyIdentityMatched: true;
  readonly generationMatched: true;
  readonly knownPlaintextEncodingsAbsent: true;
}

export interface PrepareEncryptedVaultSmokeOptions {
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly temporaryDirectory?: string;
}

interface PreparedContextBoundary {
  readonly temporaryRootPath: string;
  readonly rootIdentity: BigIntStats;
}

interface ReadyStateEvidence {
  readonly schemaVersion: typeof WINDOWS_VAULT_STATE_SCHEMA_VERSION;
  readonly status: "ready";
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
}

interface LookupEvidence {
  readonly documentId: string;
  readonly chunkId: string;
}

type PackagedCipherDatabase = ReturnType<
  EncryptedSqliteProviderRuntime["openDatabase"]
>;

interface PackagedCipherDatabaseConstructor {
  new(
    location: string,
    options: Readonly<{ fileMustExist: true }>,
  ): PackagedCipherDatabase;
}

const preparedContexts = new WeakMap<
  EncryptedVaultSmokeContext,
  PreparedContextBoundary
>();

/** A single content-free failure for every invocation and verification error. */
export class EncryptedVaultSmokeError extends Error {
  public constructor() {
    super("OhMyContext packaged encrypted-vault verification failed.");
    this.name = "EncryptedVaultSmokeError";
  }
}

/**
 * Captures the dedicated packaged-smoke boundary before Electron readiness.
 * The caller may use `userDataPath` with `app.setPath("userData", ...)`.
 */
export function prepareEncryptedVaultSmoke(
  options: PrepareEncryptedVaultSmokeOptions = {},
): EncryptedVaultSmokeContext | null {
  try {
    const argv = options.argv ?? process.argv;
    const occurrences = argv.filter(
      (argument) => argument === ENCRYPTED_VAULT_SMOKE_ARGUMENT,
    ).length;
    if (occurrences === 0) return null;
    if (
      occurrences !== 1 ||
      (options.platform ?? process.platform) !== SUPPORTED_PLATFORM ||
      (options.architecture ?? process.arch) !== SUPPORTED_ARCHITECTURE
    ) {
      throw new Error("Invalid smoke invocation.");
    }

    const environment = options.environment ?? process.env;
    const requestedRoot = environment[ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME];
    const nonce = environment[ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME];
    if (
      typeof requestedRoot !== "string" ||
      requestedRoot.length === 0 ||
      requestedRoot.includes("\0") ||
      !isAbsolute(requestedRoot) ||
      normalizePath(resolve(requestedRoot)) !== normalizePath(requestedRoot) ||
      typeof nonce !== "string" ||
      !UUID_V4_PATTERN.test(nonce)
    ) {
      throw new Error("Invalid smoke boundary.");
    }

    const rootPath = resolve(requestedRoot);
    const temporaryRootPath = resolveRealDirectory(
      options.temporaryDirectory ?? tmpdir(),
    );
    const rootIdentity = assertRealDirectory(rootPath);
    if (
      !isStrictDescendant(temporaryRootPath, rootPath) ||
      readdirSync(rootPath).length !== 0
    ) {
      throw new Error("Invalid smoke root.");
    }

    const userDataPath = join(rootPath, USER_DATA_DIRECTORY_NAME);
    const vaultDirectoryPath = join(rootPath, VAULT_DIRECTORY_NAME);
    const fixtureDirectoryPath = join(rootPath, FIXTURE_DIRECTORY_NAME);
    const fixturePath = join(fixtureDirectoryPath, FIXTURE_FILE_NAME);
    const resultPath = join(rootPath, ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME);
    assertSeparatedPaths(rootPath, [
      userDataPath,
      vaultDirectoryPath,
      fixtureDirectoryPath,
      fixturePath,
      resultPath,
    ]);
    mkdirSync(userDataPath, { mode: 0o700 });
    assertRealDirectory(userDataPath);
    if (!sameFileIdentity(rootIdentity, lstatSync(rootPath, { bigint: true }))) {
      throw new Error("Smoke root changed.");
    }

    const context = Object.freeze({
      rootPath,
      userDataPath,
      vaultDirectoryPath,
      fixtureDirectoryPath,
      fixturePath,
      resultPath,
      nonce,
    });
    preparedContexts.set(context, Object.freeze({
      temporaryRootPath,
      rootIdentity,
    }));
    return context;
  } catch {
    throw new EncryptedVaultSmokeError();
  }
}

/**
 * Runs a real packaged-runtime candidate journey. Passing a SafeStorageLike is
 * dependency injection for Electron main-process integration and unit tests;
 * a reversible test fake is not evidence of operating-system key protection.
 */
export async function runEncryptedVaultSmoke(
  context: EncryptedVaultSmokeContext,
  safeStorage: SafeStorageLike,
  isPackaged: boolean,
  resourcesPath: string,
): Promise<EncryptedVaultSmokeResult> {
  try {
    if (
      process.platform !== SUPPORTED_PLATFORM ||
      process.arch !== SUPPORTED_ARCHITECTURE ||
      isPackaged !== true
    ) {
      throw new Error("Unsupported smoke runtime.");
    }
    capturePreparedContext(context);

    const runtime = loadPackagedEncryptedSqliteRuntime(resourcesPath);
    mkdirSync(context.vaultDirectoryPath, { mode: 0o700 });
    mkdirSync(context.fixtureDirectoryPath, { mode: 0o700 });
    assertRealDirectory(context.vaultDirectoryPath);
    assertRealDirectory(context.fixtureDirectoryPath);

    const randomCanaryBytes = randomBytes(32);
    let canary: string;
    try {
      canary = `${FIXTURE_CANARY_PREFIX}${randomCanaryBytes.toString("hex")}`;
    } finally {
      randomCanaryBytes.fill(0);
    }
    await writeExclusiveBytes(
      context.fixturePath,
      Buffer.from(
        `# Encrypted vault smoke fixture\n\n${canary} proves import, search, fetch, and same-process reopen.\n`,
        "utf8",
      ),
      16 * 1024,
    );

    const firstProvider = createEncryptedSqliteProvider(runtime);
    assertExactProvider(firstProvider.descriptor);
    const firstOpened = await openWindowsEncryptedVaultCandidate({
      rootPath: context.vaultDirectoryPath,
      provider: firstProvider,
      protector: new ElectronSafeStorageKeyProtector(safeStorage),
    });
    let firstLookup: LookupEvidence;
    try {
      const imported = await importDirectory(
        firstOpened.vault,
        context.fixtureDirectoryPath,
        {
          collection: FIXTURE_COLLECTION,
          sourceName: FIXTURE_SOURCE_NAME,
          maxFiles: 1,
          maxEntries: 2,
        },
      );
      if (
        imported.scanned !== 1 ||
        imported.imported !== 1 ||
        imported.updated !== 0 ||
        imported.unchanged !== 0 ||
        imported.skipped !== 0 ||
        imported.documents.length !== 1 ||
        imported.documents[0]?.status !== "created"
      ) {
        throw new Error("Fixture import failed.");
      }
      firstLookup = verifyLookup(firstOpened.vault, canary);
      if (firstLookup.documentId !== imported.documents[0].documentId) {
        throw new Error("Imported fixture identity changed.");
      }
      scanVaultArtifacts(context.vaultDirectoryPath, canary);
    } finally {
      firstOpened.vault.close();
    }

    scanVaultArtifacts(context.vaultDirectoryPath, canary);
    const firstState = readReadyState(context.vaultDirectoryPath);
    if (
      firstState.vaultId !== firstOpened.vaultId ||
      firstState.keyId !== firstOpened.keyId ||
      firstState.generation !== firstOpened.generation
    ) {
      throw new Error("Initial lifecycle identity is inconsistent.");
    }

    const reopenProvider = createEncryptedSqliteProvider(runtime);
    assertExactProvider(reopenProvider.descriptor);
    const reopened = await openWindowsEncryptedVaultCandidate({
      rootPath: context.vaultDirectoryPath,
      provider: reopenProvider,
      protector: new ElectronSafeStorageKeyProtector(safeStorage),
    });
    let reopenLookup: LookupEvidence;
    try {
      reopenLookup = verifyLookup(reopened.vault, canary, firstLookup);
      scanVaultArtifacts(context.vaultDirectoryPath, canary);
    } finally {
      reopened.vault.close();
    }

    scanVaultArtifacts(context.vaultDirectoryPath, canary);
    const reopenState = readReadyState(context.vaultDirectoryPath);
    const stateReady = firstState.status === "ready" && reopenState.status === "ready";
    const vaultIdentityMatched =
      reopened.vaultId === firstOpened.vaultId &&
      reopenState.vaultId === firstState.vaultId;
    const keyIdentityMatched =
      reopened.keyId === firstOpened.keyId &&
      reopenState.keyId === firstState.keyId;
    const generationMatched =
      reopened.generation === firstOpened.generation &&
      reopenState.generation === firstState.generation;
    if (
      !stateReady ||
      !vaultIdentityMatched ||
      !keyIdentityMatched ||
      !generationMatched ||
      reopenLookup.documentId !== firstLookup.documentId ||
      reopenLookup.chunkId !== firstLookup.chunkId
    ) {
      throw new Error("Reopen verification failed.");
    }

    const result: EncryptedVaultSmokeResult = Object.freeze({
      schemaVersion: ENCRYPTED_VAULT_SMOKE_RESULT_SCHEMA_VERSION,
      status: ENCRYPTED_VAULT_SMOKE_STATUS,
      nonce: context.nonce,
      platform: SUPPORTED_PLATFORM,
      architecture: SUPPORTED_ARCHITECTURE,
      isPackaged: true,
      releaseBoundary: ENCRYPTED_VAULT_SMOKE_RELEASE_BOUNDARY,
      publicReleaseApproved: false,
      doesNotProve: ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE,
      providerId: ENCRYPTED_VAULT_SMOKE_PROVIDER_ID,
      keyProtectorProviderId: VAULT_KEY_PROVIDER_ID,
      engineIdentity: Object.freeze({ ...ENCRYPTED_SQLITE_ENGINE_IDENTITY }),
      safeStorageAsyncAvailable: true,
      fixtureImported: true,
      initialSearchMatched: true,
      initialFetchMatched: true,
      reopenSearchMatched: true,
      reopenFetchMatched: true,
      stateReady: true,
      vaultIdentityMatched: true,
      keyIdentityMatched: true,
      generationMatched: true,
      knownPlaintextEncodingsAbsent: true,
    });
    if (!isEncryptedVaultSmokeResult(result, context.nonce)) {
      throw new Error("Invalid smoke result.");
    }
    await writeExclusiveResult(context.resultPath, result);
    return result;
  } catch {
    throw new EncryptedVaultSmokeError();
  }
}

/** Exact, content-free result validator for the packaged smoke harness. */
export function isEncryptedVaultSmokeResult(
  value: unknown,
  expectedNonce?: string,
): value is EncryptedVaultSmokeResult {
  try {
    if (!isObject(value) || !hasExactKeys(value, [
      "schemaVersion",
      "status",
      "nonce",
      "platform",
      "architecture",
      "isPackaged",
      "releaseBoundary",
      "publicReleaseApproved",
      "doesNotProve",
      "providerId",
      "keyProtectorProviderId",
      "engineIdentity",
      "safeStorageAsyncAvailable",
      "fixtureImported",
      "initialSearchMatched",
      "initialFetchMatched",
      "reopenSearchMatched",
      "reopenFetchMatched",
      "stateReady",
      "vaultIdentityMatched",
      "keyIdentityMatched",
      "generationMatched",
      "knownPlaintextEncodingsAbsent",
    ])) {
      return false;
    }
    const engine = value.engineIdentity;
    if (!isObject(engine) || !hasExactKeys(engine, [
      "sqlite3mcVersion",
      "sqliteVersion",
      "cipher",
      "hmacCheck",
      "tempStore",
    ])) {
      return false;
    }
    const nonce = value.nonce;
    return value.schemaVersion === ENCRYPTED_VAULT_SMOKE_RESULT_SCHEMA_VERSION &&
      value.status === ENCRYPTED_VAULT_SMOKE_STATUS &&
      typeof nonce === "string" &&
      UUID_V4_PATTERN.test(nonce) &&
      (expectedNonce === undefined || nonce === expectedNonce) &&
      value.platform === SUPPORTED_PLATFORM &&
      value.architecture === SUPPORTED_ARCHITECTURE &&
      value.isPackaged === true &&
      value.releaseBoundary === ENCRYPTED_VAULT_SMOKE_RELEASE_BOUNDARY &&
      value.publicReleaseApproved === false &&
      Array.isArray(value.doesNotProve) &&
      value.doesNotProve.length === ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE.length &&
      value.doesNotProve.every(
        (item, index) => item === ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE[index],
      ) &&
      value.providerId === ENCRYPTED_VAULT_SMOKE_PROVIDER_ID &&
      value.keyProtectorProviderId === VAULT_KEY_PROVIDER_ID &&
      engine.sqlite3mcVersion === ENCRYPTED_SQLITE_ENGINE_IDENTITY.sqlite3mcVersion &&
      engine.sqliteVersion === ENCRYPTED_SQLITE_ENGINE_IDENTITY.sqliteVersion &&
      engine.cipher === ENCRYPTED_SQLITE_ENGINE_IDENTITY.cipher &&
      engine.hmacCheck === ENCRYPTED_SQLITE_ENGINE_IDENTITY.hmacCheck &&
      engine.tempStore === ENCRYPTED_SQLITE_ENGINE_IDENTITY.tempStore &&
      value.safeStorageAsyncAvailable === true &&
      value.fixtureImported === true &&
      value.initialSearchMatched === true &&
      value.initialFetchMatched === true &&
      value.reopenSearchMatched === true &&
      value.reopenFetchMatched === true &&
      value.stateReady === true &&
      value.vaultIdentityMatched === true &&
      value.keyIdentityMatched === true &&
      value.generationMatched === true &&
      value.knownPlaintextEncodingsAbsent === true;
  } catch {
    return false;
  }
}

function capturePreparedContext(context: EncryptedVaultSmokeContext): void {
  const boundary = preparedContexts.get(context);
  if (!boundary) throw new Error("Unprepared smoke context.");
  const rootIdentity = assertRealDirectory(context.rootPath);
  if (
    !sameFileIdentity(rootIdentity, boundary.rootIdentity) ||
    !isStrictDescendant(boundary.temporaryRootPath, context.rootPath) ||
    !sameResolvedPath(context.userDataPath, join(context.rootPath, USER_DATA_DIRECTORY_NAME)) ||
    !sameResolvedPath(context.vaultDirectoryPath, join(context.rootPath, VAULT_DIRECTORY_NAME)) ||
    !sameResolvedPath(
      context.fixtureDirectoryPath,
      join(context.rootPath, FIXTURE_DIRECTORY_NAME),
    ) ||
    !sameResolvedPath(context.fixturePath, join(context.fixtureDirectoryPath, FIXTURE_FILE_NAME)) ||
    !sameResolvedPath(
      context.resultPath,
      join(context.rootPath, ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME),
    ) ||
    !UUID_V4_PATTERN.test(context.nonce)
  ) {
    throw new Error("Smoke context changed.");
  }
  assertRealDirectory(context.userDataPath);
  assertAbsent(context.vaultDirectoryPath);
  assertAbsent(context.fixtureDirectoryPath);
  assertAbsent(context.resultPath);
}

export function loadPackagedEncryptedSqliteRuntime(
  resourcesPath: string,
): EncryptedSqliteProviderRuntime {
  if (
    typeof resourcesPath !== "string" ||
    resourcesPath.length === 0 ||
    resourcesPath.includes("\0") ||
    !isAbsolute(resourcesPath) ||
    normalizePath(resolve(resourcesPath)) !== normalizePath(resourcesPath)
  ) {
    throw new Error("Invalid resources path.");
  }
  const canonicalResourcesPath = resolveRealDirectory(resourcesPath);
  if (!sameResolvedPath(canonicalResourcesPath, resourcesPath)) {
    throw new Error("Invalid resources path.");
  }
  const entryPath = join(
    canonicalResourcesPath,
    ...PACKAGED_RUNTIME_ENTRY_SEGMENTS,
  );
  if (!isStrictDescendant(canonicalResourcesPath, entryPath)) {
    throw new Error("Invalid runtime entry.");
  }
  const entry = lstatSync(entryPath, { bigint: true });
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1n ||
    !sameResolvedPath(realpathSync.native(entryPath), entryPath)
  ) {
    throw new Error("Invalid runtime entry.");
  }

  const requireFromRuntime = createRequire(entryPath);
  const loaded: unknown = requireFromRuntime(entryPath);
  if (typeof loaded !== "function") {
    throw new Error("Invalid runtime constructor.");
  }
  const Database = loaded as PackagedCipherDatabaseConstructor;
  return Object.freeze({
    platform: SUPPORTED_PLATFORM,
    arch: SUPPORTED_ARCHITECTURE,
    openDatabase(
      location: string,
      options: Readonly<{ fileMustExist: true }>,
    ): PackagedCipherDatabase {
      return new Database(location, options);
    },
  });
}

function assertExactProvider(descriptor: {
  readonly providerId: string;
  readonly securityProfile: string;
  readonly atRestEncryption: string;
  readonly keyManagement: string;
}): void {
  if (
    descriptor.providerId !== ENCRYPTED_VAULT_SMOKE_PROVIDER_ID ||
    descriptor.securityProfile !== "encrypted-candidate" ||
    descriptor.atRestEncryption !== "provider-managed" ||
    descriptor.keyManagement !== "os-protected"
  ) {
    throw new Error("Unexpected encrypted provider.");
  }
}

function verifyLookup(
  vault: Vault,
  canary: string,
  expected?: LookupEvidence,
): LookupEvidence {
  const results = searchVault(
    vault,
    { query: canary, collection: FIXTURE_COLLECTION, limit: 2 },
    { clientKind: "desktop" },
  );
  const issued = results[0];
  if (
    results.length !== 1 ||
    !issued ||
    !HEX_256_PATTERN.test(issued.documentId) ||
    !HEX_256_PATTERN.test(issued.chunkId) ||
    (expected !== undefined &&
      (issued.documentId !== expected.documentId || issued.chunkId !== expected.chunkId))
  ) {
    throw new Error("Fixture search failed.");
  }
  const fetched = fetchDocument(
    vault,
    {
      documentId: issued.documentId,
      chunkId: issued.chunkId,
      before: 0,
      after: 0,
      maxChars: 16 * 1024,
    },
    { clientKind: "desktop" },
  );
  if (
    !fetched ||
    fetched.documentId !== issued.documentId ||
    !fetched.content.includes(canary) ||
    fetched.chunks.length !== 1 ||
    fetched.chunks[0]?.chunkId !== issued.chunkId ||
    !fetched.chunks[0].content.includes(canary)
  ) {
    throw new Error("Fixture fetch failed.");
  }
  return Object.freeze({
    documentId: issued.documentId,
    chunkId: issued.chunkId,
  });
}

function readReadyState(vaultDirectoryPath: string): ReadyStateEvidence {
  const statePath = join(vaultDirectoryPath, WINDOWS_VAULT_STATE_FILE_NAME);
  const bytes = readBoundedRegularFile(statePath, MAX_WINDOWS_VAULT_STATE_BYTES);
  try {
    const parsed: unknown = JSON.parse(utf8Decoder.decode(bytes));
    if (!isObject(parsed) || !hasExactKeys(parsed, [
      "schemaVersion",
      "status",
      "vaultId",
      "keyId",
      "generation",
    ])) {
      throw new Error("Invalid ready state.");
    }
    const canonical: ReadyStateEvidence = {
      schemaVersion: WINDOWS_VAULT_STATE_SCHEMA_VERSION,
      status: "ready",
      vaultId: typeof parsed.vaultId === "string" ? parsed.vaultId : "",
      keyId: typeof parsed.keyId === "string" ? parsed.keyId : "",
      generation: typeof parsed.generation === "number" ? parsed.generation : 0,
    };
    if (
      parsed.schemaVersion !== WINDOWS_VAULT_STATE_SCHEMA_VERSION ||
      parsed.status !== "ready" ||
      !HEX_256_PATTERN.test(canonical.vaultId) ||
      !HEX_256_PATTERN.test(canonical.keyId) ||
      !Number.isSafeInteger(canonical.generation) ||
      canonical.generation < 1 ||
      !bytes.equals(Buffer.from(JSON.stringify(canonical), "utf8"))
    ) {
      throw new Error("Invalid ready state.");
    }
    return Object.freeze(canonical);
  } finally {
    bytes.fill(0);
  }
}

function scanVaultArtifacts(vaultDirectoryPath: string, canary: string): void {
  const databasePath = join(vaultDirectoryPath, WINDOWS_ENCRYPTED_VAULT_FILE_NAME);
  const artifacts: Array<Readonly<{
    path: string;
    maximumBytes: number;
    allowEmpty?: boolean;
  }>> = [
    Object.freeze({
      path: databasePath,
      maximumBytes: MAX_DATABASE_ARTIFACT_BYTES,
    }),
    Object.freeze({
      path: join(vaultDirectoryPath, WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME),
      maximumBytes: MAX_VAULT_KEY_ENVELOPE_BYTES,
    }),
    Object.freeze({
      path: join(vaultDirectoryPath, WINDOWS_VAULT_STATE_FILE_NAME),
      maximumBytes: MAX_WINDOWS_VAULT_STATE_BYTES,
    }),
  ];
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (pathExists(sidecarPath)) {
      artifacts.push(Object.freeze({
        path: sidecarPath,
        maximumBytes: MAX_DATABASE_ARTIFACT_BYTES,
        // A live or recently checkpointed SQLite WAL may legitimately be empty.
        allowEmpty: true,
      }));
    }
  }

  const representations = plaintextRepresentations(canary);
  let scannedBytes = 0;
  try {
    for (const artifact of artifacts) {
      const bytes = readBoundedRegularFile(
        artifact.path,
        artifact.maximumBytes,
        artifact.allowEmpty ?? false,
      );
      try {
        scannedBytes += bytes.byteLength;
        if (
          scannedBytes > MAX_SCANNED_ARTIFACT_BYTES ||
          representations.some((representation) => bytes.includes(representation))
        ) {
          throw new Error("Fixture plaintext appeared in encrypted inventory.");
        }
      } finally {
        bytes.fill(0);
      }
    }
  } finally {
    for (const representation of representations) representation.fill(0);
  }
}

function plaintextRepresentations(value: string): Buffer[] {
  return [
    Buffer.from(value, "utf8"),
    Buffer.from(value, "utf16le"),
    encodeUtf16BigEndian(value),
    encodeUtf32(value, "little"),
    encodeUtf32(value, "big"),
  ];
}

function encodeUtf16BigEndian(value: string): Buffer {
  return Buffer.from(value, "utf16le").swap16();
}

function encodeUtf32(value: string, byteOrder: "little" | "big"): Buffer {
  const bytes = Buffer.allocUnsafe(value.length * 4);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (byteOrder === "little") bytes.writeUInt32LE(codeUnit, index * 4);
    else bytes.writeUInt32BE(codeUnit, index * 4);
  }
  return bytes;
}

function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  allowEmpty = false,
): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    (!allowEmpty && before.size < 1n) ||
    before.size > BigInt(maximumBytes) ||
    !sameResolvedPath(realpathSync.native(path), path)
  ) {
    throw new Error("Invalid smoke artifact.");
  }
  const length = Number(before.size);
  const bytes = Buffer.allocUnsafe(length);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(before, opened) || opened.size !== before.size) {
      throw new Error("Smoke artifact changed.");
    }
    let offset = 0;
    while (offset < length) {
      const bytesRead = readSync(descriptor, bytes, offset, length - offset, offset);
      if (bytesRead <= 0) throw new Error("Short smoke artifact read.");
      offset += bytesRead;
    }
    const finalOpened = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, finalOpened) || finalOpened.size !== before.size) {
      throw new Error("Smoke artifact changed.");
    }
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1n ||
    !sameFileIdentity(before, after) ||
    after.size !== before.size
  ) {
    bytes.fill(0);
    throw new Error("Smoke artifact changed.");
  }
  return bytes;
}

async function writeExclusiveBytes(
  path: string,
  bytes: Buffer,
  maximumBytes: number,
): Promise<void> {
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new Error("Smoke output is outside its bound.");
  }
  const handle = await openFile(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusiveResult(
  path: string,
  result: EncryptedVaultSmokeResult,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
  await writeExclusiveBytes(path, bytes, ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES);
  const persisted = readBoundedRegularFile(
    path,
    ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES,
  );
  try {
    if (!persisted.equals(bytes)) throw new Error("Smoke result changed.");
  } finally {
    bytes.fill(0);
    persisted.fill(0);
  }
}

function resolveRealDirectory(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    !isAbsolute(path)
  ) {
    throw new Error("Invalid directory.");
  }
  const absolute = resolve(path);
  assertRealDirectory(absolute);
  const real = realpathSync.native(absolute);
  if (!sameResolvedPath(real, absolute)) throw new Error("Invalid directory.");
  return real;
}

function assertRealDirectory(path: string): BigIntStats {
  const absolute = resolve(path);
  const before = assertRealDirectoryComponents(absolute);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Invalid directory.");
  }
  const real = realpathSync.native(absolute);
  if (!sameResolvedPath(real, absolute)) throw new Error("Invalid directory.");
  const after = lstatSync(absolute, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    !sameFileIdentity(before, after)
  ) {
    throw new Error("Directory changed.");
  }
  return after;
}

function assertRealDirectoryComponents(absolutePath: string): BigIntStats {
  const volumeRoot = parse(absolutePath).root;
  if (volumeRoot.length === 0) throw new Error("Invalid directory.");
  const remainder = relative(volumeRoot, absolutePath);
  const components = remainder.length === 0
    ? []
    : remainder.split(/[\\/]+/u);
  let current = volumeRoot;
  let metadata = lstatSync(current, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Invalid directory.");
  }
  for (const component of components) {
    if (component.length === 0 || component === "." || component === "..") {
      throw new Error("Invalid directory.");
    }
    current = join(current, component);
    metadata = lstatSync(current, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Invalid directory.");
    }
  }
  return metadata;
}

function assertSeparatedPaths(rootPath: string, paths: readonly string[]): void {
  const normalized = paths.map(normalizePath);
  if (
    new Set(normalized).size !== normalized.length ||
    paths.some((path) => !isStrictDescendant(rootPath, path))
  ) {
    throw new Error("Smoke paths overlap.");
  }
}

function assertAbsent(path: string): void {
  try {
    lstatSync(path);
    throw new Error("Smoke target already exists.");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isStrictDescendant(parent: string, child: string): boolean {
  const difference = relative(
    canonicalComparablePath(parent),
    canonicalComparablePath(child),
  );
  return difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference);
}

function sameResolvedPath(left: string, right: string): boolean {
  return normalizePath(canonicalComparablePath(left)) ===
    normalizePath(canonicalComparablePath(right));
}

function canonicalComparablePath(value: string): string {
  const normalized = resolve(value);
  try {
    return resolve(realpathSync.native(normalized));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    const canonicalParent = canonicalComparablePath(dirname(normalized));
    return join(canonicalParent, basename(normalized));
  }
}

function normalizePath(path: string): string {
  // Windows case-folds ordinary path lookup but does not normalize Unicode
  // composition, so NFC and NFD spellings must remain distinct boundaries.
  return path.replaceAll("/", "\\").toLowerCase();
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasErrorCode(error: unknown, code: string): boolean {
  try {
    return isObject(error) && error.code === code;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
