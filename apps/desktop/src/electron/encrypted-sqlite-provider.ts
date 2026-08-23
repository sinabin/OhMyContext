import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import type {
  EncryptedVaultCandidateOpenRequest,
  EncryptedVaultCandidateProvider,
  EncryptedVaultCandidateSession,
  EncryptedVaultCipherAttestation,
  VaultStorageConnection,
  VaultStorageRunResult,
  VaultStorageStatement,
  VaultStorageValue,
} from "@owncontext/core";

const SUPPORTED_PLATFORM = "win32" as const;
const SUPPORTED_ARCH = "x64" as const;
const VAULT_KEY_BYTES = 32;
const SQLITE_OK = 0;
const SQLITE_TEMP_STORE_MEMORY = 2;
const SQLITE3MC_CIPHER = "chacha20";
const SQLITE3MC_HMAC_CHECK_ACTIVE = "1";
const SQLITE3MC_IDENTITY_QUERY =
  "SELECT sqlite3mc_version() AS sqlite3mc_version, sqlite_version() AS sqlite_version";
const SQLITE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"] as const);

export const ENCRYPTED_SQLITE_ENGINE_IDENTITY = Object.freeze({
  sqlite3mcVersion: "SQLite3 Multiple Ciphers 2.4.0",
  sqliteVersion: "3.53.4",
  cipher: SQLITE3MC_CIPHER,
  hmacCheck: SQLITE3MC_HMAC_CHECK_ACTIVE,
  tempStore: SQLITE_TEMP_STORE_MEMORY,
});

const ACTIVE_CIPHER_ATTESTATION = Object.freeze({
  status: "active" as const,
}) satisfies EncryptedVaultCipherAttestation;

const DESCRIPTOR = Object.freeze({
  providerId: "sqlite3mc-chacha20-windows-x64",
  securityProfile: "encrypted-candidate" as const,
  atRestEncryption: "provider-managed" as const,
  keyManagement: "os-protected" as const,
});

export type EncryptedSqliteProviderErrorCode =
  | "UNSUPPORTED_RUNTIME"
  | "INVALID_REQUEST"
  | "OPEN_FAILED"
  | "CIPHER_ATTESTATION_FAILED"
  | "SCHEMA_INSPECTION_FAILED"
  | "DATABASE_OPERATION_FAILED";

const ERROR_MESSAGES: Readonly<Record<EncryptedSqliteProviderErrorCode, string>> =
  Object.freeze({
    UNSUPPORTED_RUNTIME: "Encrypted vault storage is unavailable on this runtime.",
    INVALID_REQUEST: "Encrypted vault storage request is invalid.",
    OPEN_FAILED: "Encrypted vault storage could not be opened.",
    CIPHER_ATTESTATION_FAILED: "Encrypted vault cipher attestation failed.",
    SCHEMA_INSPECTION_FAILED: "Encrypted vault schema inspection failed.",
    DATABASE_OPERATION_FAILED: "Encrypted vault database operation failed.",
  });

/** A bounded error that never includes a vault path, key, SQL, or native message. */
export class EncryptedSqliteProviderError extends Error {
  public readonly code: EncryptedSqliteProviderErrorCode;

  public constructor(code: EncryptedSqliteProviderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "EncryptedSqliteProviderError";
    this.code = code;
  }
}

interface CipherStatementLike {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
}

interface CipherDatabaseLike {
  close(): unknown;
  exec(source: string): unknown;
  key(key: Buffer): number;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  prepare(source: string): CipherStatementLike;
}

interface CipherDatabaseConstructor {
  new(
    location: string,
    options: Readonly<{ fileMustExist: true }>,
  ): CipherDatabaseLike;
}

export interface EncryptedSqliteProviderRuntime {
  readonly platform: string;
  readonly arch: string;
  /**
   * Production uses the pinned native module. Tests may inject a narrow fake
   * to verify ordering and file-identity race handling without weakening the
   * production path.
   */
  openDatabase(
    location: string,
    options: Readonly<{ fileMustExist: true }>,
  ): CipherDatabaseLike;
}

interface CapturedRuntime {
  readonly platform: string;
  readonly arch: string;
  readonly openDatabase: EncryptedSqliteProviderRuntime["openDatabase"];
}

interface CapturedOpenRequest {
  readonly location: string;
  readonly key: Buffer;
  readonly mode: EncryptedVaultCandidateOpenRequest["mode"];
}

interface OpenFileGuard {
  readonly descriptor: number;
  readonly identity: BigIntStats;
  readonly location: string;
  readonly created: boolean;
}

const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)?.get;

const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const requireFromModule = createRequire(import.meta.url);
let windowsX64DatabaseConstructor: CipherDatabaseConstructor | undefined;

const DEFAULT_RUNTIME = Object.freeze({
  platform: process.platform,
  arch: process.arch,
  openDatabase: (location: string, options: Readonly<{ fileMustExist: true }>) => {
    const Database = loadWindowsX64DatabaseConstructor();
    return new Database(location, options);
  },
}) satisfies EncryptedSqliteProviderRuntime;

function loadWindowsX64DatabaseConstructor(): CipherDatabaseConstructor {
  if (windowsX64DatabaseConstructor) return windowsX64DatabaseConstructor;
  const loaded: unknown = requireFromModule(
    "better-sqlite3-multiple-ciphers/win32-x64",
  );
  if (typeof loaded !== "function") throw new Error("Invalid native module.");
  windowsX64DatabaseConstructor = loaded as CipherDatabaseConstructor;
  return windowsX64DatabaseConstructor;
}

/**
 * Creates the Windows x64 SQLite3MultipleCiphers candidate.
 *
 * The caller still owns OS key protection and key zeroization. This provider
 * accepts a 32-byte Buffer and passes a transient byte-for-byte copy to the
 * native `key(Buffer)` API before the first query or database-page read. The
 * engine remains responsible for interpreting/deriving its ChaCha20 key; this
 * boundary does not claim that the Buffer bypasses SQLite3MC key derivation.
 */
export function createEncryptedSqliteProvider(
  runtime: EncryptedSqliteProviderRuntime = DEFAULT_RUNTIME,
): EncryptedVaultCandidateProvider {
  const capturedRuntime = captureRuntime(runtime);

  return Object.freeze({
    descriptor: DESCRIPTOR,
    openKeyed: (request: EncryptedVaultCandidateOpenRequest) =>
      openKeyed(capturedRuntime, request),
  });
}

function captureRuntime(runtime: EncryptedSqliteProviderRuntime): CapturedRuntime {
  try {
    if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime)) {
      throw new Error("Invalid runtime.");
    }
    const platform = runtime.platform;
    const arch = runtime.arch;
    const openDatabase = runtime.openDatabase;
    if (
      typeof platform !== "string" ||
      typeof arch !== "string" ||
      typeof openDatabase !== "function"
    ) {
      throw new Error("Invalid runtime.");
    }
    return Object.freeze({
      platform,
      arch,
      openDatabase: (location: string, options: Readonly<{ fileMustExist: true }>) =>
        Reflect.apply(openDatabase, runtime, [location, options]) as CipherDatabaseLike,
    });
  } catch {
    throw new EncryptedSqliteProviderError("INVALID_REQUEST");
  }
}

function openKeyed(
  runtime: CapturedRuntime,
  request: EncryptedVaultCandidateOpenRequest,
): EncryptedVaultCandidateSession {
  if (runtime.platform !== SUPPORTED_PLATFORM || runtime.arch !== SUPPORTED_ARCH) {
    throw new EncryptedSqliteProviderError("UNSUPPORTED_RUNTIME");
  }

  const capturedRequest = captureOpenRequest(request);
  let guard: OpenFileGuard | undefined;
  let database: CipherDatabaseLike | undefined;

  try {
    assertRealDirectory(dirname(capturedRequest.location));
    assertSidecarsSafe(capturedRequest.location, capturedRequest.mode);
    guard = capturedRequest.mode === "create-exclusive"
      ? reserveNewRegularFile(capturedRequest.location)
      : openExistingRegularFile(capturedRequest.location);

    database = runtime.openDatabase(
      capturedRequest.location,
      Object.freeze({ fileMustExist: true as const }),
    );
    const native = captureDatabase(database);
    assertGuardStable(guard);

    configureKeyBeforeFirstPageRead(native, capturedRequest.key);
    assertGuardStable(guard);
    assertSidecarsSafe(capturedRequest.location, capturedRequest.mode);

    const connection = new EncryptedSqliteConnection(native);
    closeSync(guard.descriptor);
    guard = undefined;
    return createCandidateSession(native, connection);
  } catch {
    safeCloseDatabase(database);
    if (guard) {
      closeFileGuard(guard);
      if (guard.created) unlinkCreatedFileIfUnchanged(guard);
    }
    throw new EncryptedSqliteProviderError("OPEN_FAILED");
  }
}

function captureOpenRequest(
  request: EncryptedVaultCandidateOpenRequest,
): CapturedOpenRequest {
  try {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw new Error("Invalid request.");
    }
    const location = request.location;
    const key = request.key;
    const mode = request.mode;
    if (
      typeof location !== "string" ||
      location.length === 0 ||
      location.includes("\0") ||
      !isCanonicalAbsolutePath(location) ||
      !isExactKeyBuffer(key) ||
      (mode !== "open-existing" && mode !== "create-exclusive")
    ) {
      throw new Error("Invalid request.");
    }
    return Object.freeze({ location, key, mode });
  } catch {
    throw new EncryptedSqliteProviderError("INVALID_REQUEST");
  }
}

function isCanonicalAbsolutePath(location: string): boolean {
  if (!isAbsolute(location) || resolve(location) !== location) return false;
  const root = parse(location).root;
  if (root.length === 0 || dirname(location) === location) return false;

  // Reject Windows alternate data streams. A vault must be a named regular
  // file whose identity can be checked independently of the SQLite handle.
  return !location.slice(root.length).includes(":");
}

function isExactKeyBuffer(value: unknown): value is Buffer {
  try {
    if (!Buffer.isBuffer(value) || typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") {
      return false;
    }
    return Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) === VAULT_KEY_BYTES;
  } catch {
    return false;
  }
}

function assertRealDirectory(directoryPath: string): void {
  const stat = lstatSync(directoryPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid parent.");
  if (!sameResolvedPath(realpathSync.native(directoryPath), directoryPath)) {
    throw new Error("Non-canonical parent.");
  }
}

function reserveNewRegularFile(location: string): OpenFileGuard {
  const descriptor = openSync(
    location,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let guard: OpenFileGuard | undefined;
  try {
    const identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n) {
      throw new Error("Invalid target.");
    }
    guard = Object.freeze({ descriptor, identity, location, created: true });
    assertGuardStable(guard);
    return guard;
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the content-free open result selected by the caller.
    }
    if (guard) unlinkCreatedFileIfUnchanged(guard);
    throw error;
  }
}

function openExistingRegularFile(location: string): OpenFileGuard {
  const before = lstatSync(location, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error("Invalid target.");
  }
  if (!sameResolvedPath(realpathSync.native(location), location)) {
    throw new Error("Non-canonical target.");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(location, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameFileIdentity(before, opened)
    ) {
      throw new Error("Target changed.");
    }
    const guard = Object.freeze({ descriptor, identity: opened, location, created: false });
    assertGuardStable(guard);
    return guard;
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the content-free open result selected by the caller.
    }
    throw error;
  }
}

function assertGuardStable(guard: OpenFileGuard): void {
  const opened = fstatSync(guard.descriptor, { bigint: true });
  const current = lstatSync(guard.location, { bigint: true });
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1n ||
    !sameFileIdentity(guard.identity, opened) ||
    !sameFileIdentity(opened, current) ||
    !sameResolvedPath(realpathSync.native(guard.location), guard.location)
  ) {
    throw new Error("Target changed.");
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameResolvedPath(left: string, right: string): boolean {
  return left.toLowerCase() === resolve(right).toLowerCase();
}

function assertSidecarsSafe(
  location: string,
  mode: EncryptedVaultCandidateOpenRequest["mode"],
): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${location}${suffix}`;
    let stat: BigIntStats;
    try {
      stat = lstatSync(sidecarPath, { bigint: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (mode === "create-exclusive") {
      throw new Error("Unexpected sidecar.");
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1n ||
      !sameResolvedPath(realpathSync.native(sidecarPath), sidecarPath)
    ) {
      throw new Error("Invalid sidecar.");
    }
  }
}

interface CapturedDatabase {
  readonly value: CipherDatabaseLike;
  readonly close: () => unknown;
  readonly exec: (source: string) => unknown;
  readonly key: (key: Buffer) => number;
  readonly pragma: (
    source: string,
    options?: { readonly simple?: boolean },
  ) => unknown;
  readonly prepare: (source: string) => CipherStatementLike;
}

function captureDatabase(database: CipherDatabaseLike): CapturedDatabase {
  if (typeof database !== "object" || database === null || Array.isArray(database)) {
    throw new Error("Invalid database.");
  }
  const close = database.close;
  const exec = database.exec;
  const key = database.key;
  const pragma = database.pragma;
  const prepare = database.prepare;
  if (
    typeof close !== "function" ||
    typeof exec !== "function" ||
    typeof key !== "function" ||
    typeof pragma !== "function" ||
    typeof prepare !== "function"
  ) {
    throw new Error("Invalid database.");
  }
  return Object.freeze({
    value: database,
    close: () => Reflect.apply(close, database, []),
    exec: (source: string) => Reflect.apply(exec, database, [source]),
    key: (rawKey: Buffer) => Reflect.apply(key, database, [rawKey]) as number,
    pragma: (source: string, options?: { readonly simple?: boolean }) =>
      Reflect.apply(pragma, database, options === undefined ? [source] : [source, options]),
    prepare: (source: string) =>
      Reflect.apply(prepare, database, [source]) as CipherStatementLike,
  });
}

function configureKeyBeforeFirstPageRead(
  database: CapturedDatabase,
  borrowedKey: Buffer,
): void {
  const cipher = database.pragma("cipher = 'chacha20'", { simple: true });
  const hmacCheck = database.pragma("hmac_check = 1", { simple: true });
  if (cipher !== SQLITE3MC_CIPHER || hmacCheck !== SQLITE3MC_HMAC_CHECK_ACTIVE) {
    throw new Error("Cipher configuration failed.");
  }

  const transientKey = Buffer.alloc(VAULT_KEY_BYTES);
  try {
    Reflect.apply(TYPED_ARRAY_SET, transientKey, [borrowedKey]);
    if (database.key(transientKey) !== SQLITE_OK) {
      throw new Error("Keying failed.");
    }
  } finally {
    transientKey.fill(0);
  }

  // SQLite3MultipleCiphers does not encrypt the temp database. Force all temp
  // storage into memory before any keyed main-database page inspection.
  database.pragma("temp_store = MEMORY", { simple: true });
}

function assertExactCipherState(database: CapturedDatabase): void {
  if (
    database.pragma("cipher", { simple: true }) !== SQLITE3MC_CIPHER ||
    database.pragma("hmac_check", { simple: true }) !==
      SQLITE3MC_HMAC_CHECK_ACTIVE ||
    database.pragma("temp_store", { simple: true }) !== SQLITE_TEMP_STORE_MEMORY
  ) {
    throw new Error("Cipher is not active.");
  }
  assertExactEngineIdentity(database);
}

function assertExactEngineIdentity(database: CapturedDatabase): void {
  const statement = database.prepare(SQLITE3MC_IDENTITY_QUERY);
  const get = statement.get;
  if (typeof get !== "function") throw new Error("Engine identity is unavailable.");
  const row = Reflect.apply(get, statement, []);
  if (
    typeof row !== "object" ||
    row === null ||
    Array.isArray(row) ||
    Object.keys(row).length !== 2 ||
    (row as { sqlite3mc_version?: unknown }).sqlite3mc_version !==
      ENCRYPTED_SQLITE_ENGINE_IDENTITY.sqlite3mcVersion ||
    (row as { sqlite_version?: unknown }).sqlite_version !==
      ENCRYPTED_SQLITE_ENGINE_IDENTITY.sqliteVersion
  ) {
    throw new Error("Engine identity is invalid.");
  }
}

function createCandidateSession(
  database: CapturedDatabase,
  connection: EncryptedSqliteConnection,
): EncryptedVaultCandidateSession {
  return Object.freeze({
    connection,
    attestCipher: (): EncryptedVaultCipherAttestation => {
      try {
        connection.assertOpen();
        assertExactCipherState(database);
        connection.markAttested();
        return ACTIVE_CIPHER_ATTESTATION;
      } catch {
        connection.closeSilently();
        throw new EncryptedSqliteProviderError("CIPHER_ATTESTATION_FAILED");
      }
    },
    inspectSchemaVersion: (): number => {
      try {
        connection.assertAttested();
        const version = database.pragma("user_version", { simple: true });
        if (!Number.isSafeInteger(version) || (version as number) < 0) {
          throw new Error("Invalid schema version.");
        }
        return version as number;
      } catch {
        connection.closeSilently();
        throw new EncryptedSqliteProviderError("SCHEMA_INSPECTION_FAILED");
      }
    },
  });
}

class EncryptedSqliteConnection implements VaultStorageConnection {
  private closed = false;
  private attested = false;

  public constructor(private readonly database: CapturedDatabase) {}

  public assertOpen(): void {
    if (this.closed) {
      throw new EncryptedSqliteProviderError("DATABASE_OPERATION_FAILED");
    }
  }

  public markAttested(): void {
    this.assertOpen();
    this.attested = true;
  }

  public assertAttested(): void {
    this.assertOpen();
    if (!this.attested) {
      throw new EncryptedSqliteProviderError("DATABASE_OPERATION_FAILED");
    }
  }

  public close(): void {
    if (this.closed) return;
    try {
      this.database.close();
      this.closed = true;
    } catch {
      throw new EncryptedSqliteProviderError("DATABASE_OPERATION_FAILED");
    }
  }

  public closeSilently(): void {
    try {
      this.close();
    } catch {
      // Never replace the bounded caller-selected failure.
    }
  }

  public exec(sql: string): void {
    this.assertAttested();
    try {
      this.database.exec(sql);
    } catch (error) {
      throw databaseOperationError(error);
    }
  }

  public prepare(sql: string): VaultStorageStatement {
    this.assertAttested();
    try {
      return new EncryptedSqliteStatement(this.database.prepare(sql));
    } catch (error) {
      throw databaseOperationError(error);
    }
  }
}

class EncryptedSqliteStatement implements VaultStorageStatement {
  private readonly allMethod: CipherStatementLike["all"];
  private readonly getMethod: CipherStatementLike["get"];
  private readonly runMethod: CipherStatementLike["run"];

  public constructor(private readonly statement: CipherStatementLike) {
    const all = statement.all;
    const get = statement.get;
    const run = statement.run;
    if (typeof all !== "function" || typeof get !== "function" || typeof run !== "function") {
      throw new EncryptedSqliteProviderError("DATABASE_OPERATION_FAILED");
    }
    this.allMethod = all;
    this.getMethod = get;
    this.runMethod = run;
  }

  public all(...parameters: VaultStorageValue[]): unknown[] {
    try {
      const rows = Reflect.apply(this.allMethod, this.statement, parameters) as unknown;
      if (!Array.isArray(rows)) throw new Error("Invalid rows.");
      return rows;
    } catch (error) {
      throw databaseOperationError(error);
    }
  }

  public get(...parameters: VaultStorageValue[]): unknown {
    try {
      return Reflect.apply(this.getMethod, this.statement, parameters);
    } catch (error) {
      throw databaseOperationError(error);
    }
  }

  public run(...parameters: VaultStorageValue[]): VaultStorageRunResult {
    try {
      const result = Reflect.apply(this.runMethod, this.statement, parameters) as unknown;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("Invalid run result.");
      }
      const changes = (result as { changes?: unknown }).changes;
      const lastInsertRowid = (result as { lastInsertRowid?: unknown }).lastInsertRowid;
      if (
        (typeof changes !== "number" && typeof changes !== "bigint") ||
        (typeof lastInsertRowid !== "number" && typeof lastInsertRowid !== "bigint")
      ) {
        throw new Error("Invalid run result.");
      }
      return { changes, lastInsertRowid };
    } catch (error) {
      throw databaseOperationError(error);
    }
  }
}

function databaseOperationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  const sqliteCode = readSqliteCode(error);
  const outward = new EncryptedSqliteProviderError("DATABASE_OPERATION_FAILED") as
    EncryptedSqliteProviderError & { code: string };

  // Preserve only the two control-flow classifications the core consumes.
  // Neither classification includes SQL, values, paths, or native text.
  if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_LOCKED") {
    Object.defineProperty(outward, "code", { value: sqliteCode, enumerable: true });
  } else if (sqliteCode === "SQLITE_ERROR" && /fts5|syntax error/iu.test(message)) {
    outward.message = "FTS5 query syntax error.";
  }
  return outward;
}

function readSqliteCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    const code = error.code;
    return typeof code === "string" && /^SQLITE_[A-Z0-9_]+$/u.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

function safeCloseDatabase(database: CipherDatabaseLike | undefined): void {
  if (!database) return;
  try {
    const close = database.close;
    if (typeof close === "function") Reflect.apply(close, database, []);
  } catch {
    // Preserve the content-free open failure.
  }
}

function closeFileGuard(guard: OpenFileGuard): void {
  try {
    closeSync(guard.descriptor);
  } catch {
    // File-descriptor cleanup cannot add path details to the outward result.
  }
}

function unlinkCreatedFileIfUnchanged(guard: OpenFileGuard): void {
  try {
    const current = lstatSync(guard.location, { bigint: true });
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.nlink === 1n &&
      sameFileIdentity(guard.identity, current)
    ) {
      unlinkSync(guard.location);
    }
  } catch {
    // Never remove a replacement and never expose a path through cleanup.
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  try {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === code;
  } catch {
    return false;
  }
}
