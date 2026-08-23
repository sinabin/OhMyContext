import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  openEncryptedVaultCandidate,
  validateEncryptedVaultCandidateProvider,
  type EncryptedVaultCandidateOpenRequest,
  type EncryptedVaultCandidateProvider,
  type EncryptedVaultCandidateSession,
  type EncryptedVaultOpenMode,
  type Vault,
  type VaultStorageConnection,
  type VaultStorageStatement,
} from "@owncontext/core";
import {
  VaultKeyEnvelopeError,
  createVaultKeyEnvelope,
  withVaultKeyFromEnvelope,
  type VaultKeyProtector,
} from "./vault-key-envelope.js";

export const WINDOWS_VAULT_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_WINDOWS_VAULT_STATE_BYTES = 4 * 1024;
export const WINDOWS_VAULT_STATE_FILE_NAME = "vault-state.v1.json" as const;
export const WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME =
  "vault-key-envelope.v1.json" as const;
export const WINDOWS_ENCRYPTED_VAULT_FILE_NAME =
  "owncontext.encrypted.sqlite" as const;
export const WINDOWS_LEGACY_PLAINTEXT_MARKER_FILE_NAME =
  "owncontext.sqlite" as const;

const VAULT_ID_DOMAIN = "owncontext:windows-vault-root:v1\0";
const IDENTITY_TABLE_NAME = "__owncontext_vault_identity";
const HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_STATE_GENERATION = 2_147_483_647;
const STATE_TEMPORARY_PREFIX = ".vault-state-";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const activeRoots = new Set<string>();
let temporaryStateCounter = 0;

export type WindowsVaultKeyManagerErrorCode =
  | "BUSY"
  | "IDENTITY_INVALID"
  | "INVALID_PROVIDER"
  | "INVALID_ROOT"
  | "INVENTORY_CONFLICT"
  | "KEY_ENVELOPE_FAILED"
  | "STATE_INVALID"
  | "STATE_OVERSIZE"
  | "STATE_PERSIST_FAILED"
  | "UNSUPPORTED_PLATFORM"
  | "VAULT_OPEN_FAILED";

const ERROR_MESSAGES: Readonly<Record<WindowsVaultKeyManagerErrorCode, string>> =
  Object.freeze({
    BUSY: "Encrypted vault lifecycle is already active.",
    IDENTITY_INVALID: "Encrypted vault identity is invalid.",
    INVALID_PROVIDER: "Encrypted vault provider is invalid.",
    INVALID_ROOT: "Encrypted vault root is invalid.",
    INVENTORY_CONFLICT: "Encrypted vault inventory is inconsistent.",
    KEY_ENVELOPE_FAILED: "Encrypted vault key recovery failed.",
    STATE_INVALID: "Encrypted vault state is invalid.",
    STATE_OVERSIZE: "Encrypted vault state exceeds the size limit.",
    STATE_PERSIST_FAILED: "Encrypted vault state could not be persisted.",
    UNSUPPORTED_PLATFORM: "Encrypted vault lifecycle is unavailable on this platform.",
    VAULT_OPEN_FAILED: "Encrypted vault could not be opened.",
  });

export class WindowsVaultKeyManagerError extends Error {
  readonly code: WindowsVaultKeyManagerErrorCode;

  constructor(code: WindowsVaultKeyManagerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WindowsVaultKeyManagerError";
    this.code = code;
  }
}

export interface OpenWindowsEncryptedVaultCandidateOptions {
  /** Existing, dedicated, real directory. It is never created by this module. */
  readonly rootPath: string;
  readonly provider: EncryptedVaultCandidateProvider;
  readonly protector: VaultKeyProtector;
}

export interface OpenedWindowsEncryptedVaultCandidate {
  readonly vault: Vault;
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
  /** A maintenance signal only. The envelope is not rotated by this module. */
  readonly rotationPending: boolean;
}

interface CreatingState {
  readonly schemaVersion: typeof WINDOWS_VAULT_STATE_SCHEMA_VERSION;
  readonly status: "creating";
  readonly vaultId: string;
  readonly generation: number;
}

interface ReadyState {
  readonly schemaVersion: typeof WINDOWS_VAULT_STATE_SCHEMA_VERSION;
  readonly status: "ready";
  readonly vaultId: string;
  readonly keyId: string;
  readonly generation: number;
}

type VaultLifecycleState = CreatingState | ReadyState;

interface VaultPaths {
  readonly rootPath: string;
  readonly rootDevice: bigint;
  readonly rootInode: bigint;
  readonly statePath: string;
  readonly envelopePath: string;
  readonly databasePath: string;
  readonly legacyPlaintextMarkerPath: string;
}

interface VaultInventory {
  readonly state: boolean;
  readonly envelope: boolean;
  readonly database: boolean;
  readonly sidecars: readonly string[];
}

interface CapturedConnection {
  readonly connection: VaultStorageConnection;
  readonly close: () => void;
}

interface ConnectionCapture {
  connection?: VaultStorageConnection;
}

interface ResolvedRealRoot {
  readonly path: string;
  readonly comparisonPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly activeIdentity: string;
}

/**
 * Opens or resumes the fail-closed Windows encrypted-vault candidate lifecycle.
 *
 * This is an orchestration boundary, not a cipher implementation or public
 * release attestation. At-rest encryption remains the injected provider's
 * responsibility and is positively checked by `openEncryptedVaultCandidate`.
 */
export async function openWindowsEncryptedVaultCandidate(
  options: OpenWindowsEncryptedVaultCandidateOptions,
): Promise<OpenedWindowsEncryptedVaultCandidate> {
  if (process.platform !== "win32") {
    throw new WindowsVaultKeyManagerError("UNSUPPORTED_PLATFORM");
  }

  const capturedOptions = captureOptions(options);
  const root = resolveRealRoot(capturedOptions.rootPath);
  const rootIdentity = root.activeIdentity;
  if (activeRoots.has(rootIdentity)) {
    throw new WindowsVaultKeyManagerError("BUSY");
  }
  activeRoots.add(rootIdentity);

  try {
    const provider = captureProvider(capturedOptions.provider);
    const paths = vaultPaths(root);
    const vaultId = deriveVaultIdFromRealRoot(root);
    let inventory = inspectInventory(paths);
    let state: VaultLifecycleState;

    if (!inventory.state) {
      if (inventory.envelope || inventory.database || inventory.sidecars.length > 0) {
        throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
      }
      state = Object.freeze({
        schemaVersion: WINDOWS_VAULT_STATE_SCHEMA_VERSION,
        status: "creating" as const,
        vaultId,
        generation: 1,
      });
      persistInitialState(paths.statePath, state);
      inventory = inspectInventory(paths);
      if (
        !inventory.state ||
        inventory.envelope ||
        inventory.database ||
        inventory.sidecars.length > 0
      ) {
        throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
      }
    } else {
      state = readState(paths.statePath);
      if (state.vaultId !== vaultId) {
        throw new WindowsVaultKeyManagerError("STATE_INVALID");
      }
    }

    if (state.status === "ready") {
      if (!inventory.envelope || !inventory.database) {
        throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
      }
      return await openReadyVault(
        paths,
        state,
        provider,
        capturedOptions.protector,
      );
    }

    if (!inventory.envelope && inventory.database) {
      throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
    }

    const opened = inventory.envelope
      ? await resumeCreatingVault(
        paths,
        state,
        provider,
        capturedOptions.protector,
        inventory.database,
      )
      : await createVaultFromJournal(
        paths,
        state,
        provider,
        capturedOptions.protector,
      );

    try {
      const finalInventory = inspectInventory(paths);
      if (
        !finalInventory.state ||
        !finalInventory.envelope ||
        !finalInventory.database
      ) {
        throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
      }
      const readyState: ReadyState = Object.freeze({
        schemaVersion: WINDOWS_VAULT_STATE_SCHEMA_VERSION,
        status: "ready",
        vaultId: state.vaultId,
        keyId: opened.keyId,
        generation: state.generation,
      });
      replaceCreatingState(paths.statePath, state, readyState);
      return Object.freeze({
        vault: opened.vault,
        vaultId: state.vaultId,
        keyId: opened.keyId,
        generation: state.generation,
        rotationPending: opened.rotationPending,
      });
    } catch (error) {
      closeVaultQuietly(opened.vault);
      throw error;
    }
  } finally {
    activeRoots.delete(rootIdentity);
  }
}

/** Returns the path-bound identifier after applying the same root checks as open. */
export function deriveWindowsVaultId(rootPath: string): string {
  if (process.platform !== "win32") {
    throw new WindowsVaultKeyManagerError("UNSUPPORTED_PLATFORM");
  }
  return deriveVaultIdFromRealRoot(resolveRealRoot(rootPath));
}

function captureOptions(
  options: OpenWindowsEncryptedVaultCandidateOptions,
): OpenWindowsEncryptedVaultCandidateOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new Error("Invalid options.");
    }
    const rootPath = options.rootPath;
    const provider = options.provider;
    const protector = options.protector;
    if (typeof rootPath !== "string") throw new Error("Invalid root.");
    return Object.freeze({ rootPath, provider, protector });
  } catch {
    throw new WindowsVaultKeyManagerError("INVALID_ROOT");
  }
}

function captureProvider(
  provider: EncryptedVaultCandidateProvider,
): EncryptedVaultCandidateProvider {
  try {
    return validateEncryptedVaultCandidateProvider(provider);
  } catch {
    throw new WindowsVaultKeyManagerError("INVALID_PROVIDER");
  }
}

function resolveRealRoot(rootPath: string): ResolvedRealRoot {
  try {
    if (
      typeof rootPath !== "string" ||
      rootPath.length === 0 ||
      rootPath.includes("\0") ||
      !isAbsolute(rootPath)
    ) {
      throw new Error("Invalid root.");
    }
    const absolute = resolve(rootPath);
    const metadata = assertRealDirectoryComponents(absolute);
    if (!metadata.isDirectory() || metadata.ino <= 0n || metadata.dev < 0n) {
      throw new Error("Invalid root.");
    }
    const real = realpathSync.native(absolute);
    const comparisonPath = windowsPathComparisonKey(real);
    if (comparisonPath !== windowsPathComparisonKey(absolute)) {
      throw new Error("Invalid root.");
    }
    const realMetadata = lstatSync(real, { bigint: true });
    if (
      realMetadata.isSymbolicLink() ||
      !realMetadata.isDirectory() ||
      realMetadata.dev !== metadata.dev ||
      realMetadata.ino !== metadata.ino
    ) {
      throw new Error("Invalid root.");
    }
    return Object.freeze({
      path: real,
      comparisonPath,
      device: metadata.dev,
      inode: metadata.ino,
      activeIdentity: `${comparisonPath}\0${metadata.dev.toString(10)}\0${metadata.ino.toString(10)}`,
    });
  } catch {
    throw new WindowsVaultKeyManagerError("INVALID_ROOT");
  }
}

function assertRealDirectoryComponents(
  absolutePath: string,
): BigIntStats {
  const volumeRoot = parse(absolutePath).root;
  if (volumeRoot.length === 0) throw new Error("Invalid root.");
  const remainder = relative(volumeRoot, absolutePath);
  const components = remainder.length === 0
    ? []
    : remainder.split(/[\\/]+/u);
  let current = volumeRoot;
  let metadata = lstatSync(current, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Invalid root.");
  }
  for (const component of components) {
    if (component.length === 0 || component === "." || component === "..") {
      throw new Error("Invalid root.");
    }
    current = join(current, component);
    metadata = lstatSync(current, { bigint: true });
    // Node reports Windows junctions and directory symlinks as symbolic links.
    // Reject them at every level rather than checking only the final directory.
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Invalid root.");
    }
  }
  return metadata;
}

function windowsPathComparisonKey(value: string): string {
  // NTFS does not normalize Unicode composition. Lowercase only to make a
  // simple case-variant spelling of the same Windows path stable; dev+ino
  // below distinguishes different directories even on case-sensitive trees.
  return resolve(value).replaceAll("/", "\\").toLowerCase();
}

function deriveVaultIdFromRealRoot(root: ResolvedRealRoot): string {
  return createHash("sha256")
    .update(VAULT_ID_DOMAIN, "utf8")
    .update(root.comparisonPath, "utf8")
    .update("\0", "utf8")
    .update(root.device.toString(10), "ascii")
    .update("\0", "utf8")
    .update(root.inode.toString(10), "ascii")
    .digest("hex");
}

function vaultPaths(root: ResolvedRealRoot): VaultPaths {
  return Object.freeze({
    rootPath: root.path,
    rootDevice: root.device,
    rootInode: root.inode,
    statePath: join(root.path, WINDOWS_VAULT_STATE_FILE_NAME),
    envelopePath: join(root.path, WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME),
    databasePath: join(root.path, WINDOWS_ENCRYPTED_VAULT_FILE_NAME),
    legacyPlaintextMarkerPath: join(
      root.path,
      WINDOWS_LEGACY_PLAINTEXT_MARKER_FILE_NAME,
    ),
  });
}

function inspectInventory(paths: VaultPaths): VaultInventory {
  assertRootIdentity(paths);
  const allowed = new Set<string>([
    WINDOWS_VAULT_STATE_FILE_NAME,
    WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME,
    WINDOWS_ENCRYPTED_VAULT_FILE_NAME,
    `${WINDOWS_ENCRYPTED_VAULT_FILE_NAME}-wal`,
    `${WINDOWS_ENCRYPTED_VAULT_FILE_NAME}-shm`,
    `${WINDOWS_ENCRYPTED_VAULT_FILE_NAME}-journal`,
    WINDOWS_LEGACY_PLAINTEXT_MARKER_FILE_NAME,
  ]);
  let names: string[];
  try {
    names = readdirSync(paths.rootPath);
  } catch {
    throw new WindowsVaultKeyManagerError("INVALID_ROOT");
  }

  if (names.includes(WINDOWS_LEGACY_PLAINTEXT_MARKER_FILE_NAME)) {
    assertInventoryEntry(paths.legacyPlaintextMarkerPath);
    throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
  }
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
    }
    assertInventoryEntry(join(paths.rootPath, name));
  }

  const state = names.includes(WINDOWS_VAULT_STATE_FILE_NAME);
  const envelope = names.includes(WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME);
  const database = names.includes(WINDOWS_ENCRYPTED_VAULT_FILE_NAME);
  const sidecars = names.filter((name) =>
    name === `${WINDOWS_ENCRYPTED_VAULT_FILE_NAME}-wal` ||
    name === `${WINDOWS_ENCRYPTED_VAULT_FILE_NAME}-shm` ||
    name === `${WINDOWS_ENCRYPTED_VAULT_FILE_NAME}-journal`
  );
  if (!database && sidecars.length > 0) {
    throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
  }
  return Object.freeze({ state, envelope, database, sidecars: Object.freeze(sidecars) });
}

function assertRootIdentity(paths: VaultPaths): void {
  try {
    const metadata = assertRealDirectoryComponents(paths.rootPath);
    if (
      metadata.dev !== paths.rootDevice ||
      metadata.ino !== paths.rootInode
    ) {
      throw new Error("Root identity changed.");
    }
  } catch {
    throw new WindowsVaultKeyManagerError("INVALID_ROOT");
  }
}

function assertInventoryEntry(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1
    ) {
      throw new Error("Invalid inventory entry.");
    }
  } catch {
    throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
  }
}

async function createVaultFromJournal(
  paths: VaultPaths,
  state: CreatingState,
  provider: EncryptedVaultCandidateProvider,
  protector: VaultKeyProtector,
): Promise<{ vault: Vault; keyId: string; rotationPending: false }> {
  try {
    const created = await createVaultKeyEnvelope(
      {
        envelopePath: paths.envelopePath,
        vaultId: state.vaultId,
        protector,
      },
      ({ key, keyId }) => openAndCheckVault(
        paths.databasePath,
        provider,
        key,
        "create-exclusive",
        {
          vaultId: state.vaultId,
          keyId,
          generation: state.generation,
        },
        true,
      ),
    );
    return Object.freeze({
      vault: created.value,
      keyId: created.keyId,
      rotationPending: false as const,
    });
  } catch (error) {
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    if (error instanceof VaultKeyEnvelopeError) {
      throw new WindowsVaultKeyManagerError("KEY_ENVELOPE_FAILED");
    }
    throw new WindowsVaultKeyManagerError("KEY_ENVELOPE_FAILED");
  }
}

async function resumeCreatingVault(
  paths: VaultPaths,
  state: CreatingState,
  provider: EncryptedVaultCandidateProvider,
  protector: VaultKeyProtector,
  databaseExists: boolean,
): Promise<{ vault: Vault; keyId: string; rotationPending: boolean }> {
  try {
    const opened = await withVaultKeyFromEnvelope(
      {
        envelopePath: paths.envelopePath,
        vaultId: state.vaultId,
        protector,
      },
      ({ key, keyId }) => openAndCheckVault(
        paths.databasePath,
        provider,
        key,
        databaseExists ? "open-existing" : "create-exclusive",
        {
          vaultId: state.vaultId,
          keyId,
          generation: state.generation,
        },
        true,
      ),
    );
    return Object.freeze({
      vault: opened.value,
      keyId: opened.keyId,
      rotationPending: opened.shouldReEncrypt,
    });
  } catch (error) {
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    throw new WindowsVaultKeyManagerError("KEY_ENVELOPE_FAILED");
  }
}

async function openReadyVault(
  paths: VaultPaths,
  state: ReadyState,
  provider: EncryptedVaultCandidateProvider,
  protector: VaultKeyProtector,
): Promise<OpenedWindowsEncryptedVaultCandidate> {
  try {
    const opened = await withVaultKeyFromEnvelope(
      {
        envelopePath: paths.envelopePath,
        vaultId: state.vaultId,
        protector,
      },
      ({ key, keyId }) => {
        if (keyId !== state.keyId) {
          throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
        }
        return openAndCheckVault(
          paths.databasePath,
          provider,
          key,
          "open-existing",
          {
            vaultId: state.vaultId,
            keyId,
            generation: state.generation,
          },
          false,
        );
      },
    );
    return Object.freeze({
      vault: opened.value,
      vaultId: state.vaultId,
      keyId: opened.keyId,
      generation: state.generation,
      rotationPending: opened.shouldReEncrypt,
    });
  } catch (error) {
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    throw new WindowsVaultKeyManagerError("KEY_ENVELOPE_FAILED");
  }
}

function openAndCheckVault(
  databasePath: string,
  provider: EncryptedVaultCandidateProvider,
  key: Buffer,
  mode: EncryptedVaultOpenMode,
  identity: { readonly vaultId: string; readonly keyId: string; readonly generation: number },
  allowIdentityCreation: boolean,
): Vault {
  const capture: ConnectionCapture = {};
  const capturingProvider = createConnectionCapturingProvider(provider, capture);
  let vault: Vault | undefined;
  try {
    try {
      vault = openEncryptedVaultCandidate(databasePath, capturingProvider, { key, mode });
    } catch {
      throw new WindowsVaultKeyManagerError("VAULT_OPEN_FAILED");
    }
    if (!capture.connection) {
      throw new WindowsVaultKeyManagerError("VAULT_OPEN_FAILED");
    }
    assertDatabaseArtifact(databasePath);
    ensureIdentity(capture.connection, identity, allowIdentityCreation);
    return vault;
  } catch (error) {
    closeVaultQuietly(vault);
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
  }
}

function createConnectionCapturingProvider(
  provider: EncryptedVaultCandidateProvider,
  capture: ConnectionCapture,
): EncryptedVaultCandidateProvider {
  return Object.freeze({
    descriptor: provider.descriptor,
    openKeyed(request: EncryptedVaultCandidateOpenRequest): EncryptedVaultCandidateSession {
      let session: EncryptedVaultCandidateSession;
      try {
        session = provider.openKeyed(request);
      } catch {
        throw new Error("Provider open failed.");
      }
      const captured = captureSession(session);
      capture.connection = captured.connection;
      return captured.session;
    },
  });
}

function captureSession(session: EncryptedVaultCandidateSession): {
  readonly connection: VaultStorageConnection;
  readonly session: EncryptedVaultCandidateSession;
} {
  let capturedConnection: CapturedConnection | undefined;
  try {
    const rawConnection = session.connection;
    capturedConnection = captureConnection(rawConnection);
    let attestCipherRead = false;
    let inspectSchemaVersionRead = false;
    let attestCipher: unknown;
    let inspectSchemaVersion: unknown;
    const facade = Object.freeze({
      connection: capturedConnection.connection,
      get attestCipher() {
        // Core deliberately reads this getter only after it has accepted the
        // connection. Capture once at that exact boundary, not while wrapping
        // the session, and preserve the provider session as the receiver.
        if (!attestCipherRead) {
          attestCipherRead = true;
          attestCipher = session.attestCipher;
        }
        if (typeof attestCipher !== "function") throw new Error("Invalid session.");
        const operation = attestCipher;
        return () => Reflect.apply(operation, session, []);
      },
      get inspectSchemaVersion() {
        // Core does not read this getter until positive cipher attestation has
        // completed. Keeping it lazy preserves that security ordering while
        // still ensuring a hostile one-shot getter is evaluated only once.
        if (!inspectSchemaVersionRead) {
          inspectSchemaVersionRead = true;
          inspectSchemaVersion = session.inspectSchemaVersion;
        }
        if (typeof inspectSchemaVersion !== "function") {
          throw new Error("Invalid session.");
        }
        const operation = inspectSchemaVersion;
        return () => Reflect.apply(operation, session, []);
      },
    } satisfies EncryptedVaultCandidateSession);
    return Object.freeze({ connection: capturedConnection.connection, session: facade });
  } catch {
    try {
      capturedConnection?.close();
    } catch {
      // Preserve the content-free provider failure selected by core.
    }
    throw new Error("Invalid session.");
  }
}

function captureConnection(connection: VaultStorageConnection): CapturedConnection {
  if (typeof connection !== "object" || connection === null) {
    throw new Error("Invalid connection.");
  }
  const receiver = connection as unknown as Record<string, unknown>;
  const close = receiver.close;
  if (typeof close !== "function") throw new Error("Invalid connection.");
  const closeBound = () => Reflect.apply(close, receiver, []);
  try {
    const exec = receiver.exec;
    const prepare = receiver.prepare;
    if (typeof exec !== "function" || typeof prepare !== "function") {
      throw new Error("Invalid connection.");
    }
    const facade: VaultStorageConnection = Object.freeze({
      close: closeBound,
      exec: (sql: string) => Reflect.apply(exec, receiver, [sql]),
      prepare: (sql: string) =>
        Reflect.apply(prepare, receiver, [sql]) as VaultStorageStatement,
    });
    return Object.freeze({ connection: facade, close: closeBound });
  } catch {
    try {
      closeBound();
    } catch {
      // The caller will receive only a bounded provider failure.
    }
    throw new Error("Invalid connection.");
  }
}

function assertDatabaseArtifact(databasePath: string): void {
  try {
    const metadata = lstatSync(databasePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1
    ) {
      throw new Error("Invalid database artifact.");
    }
  } catch {
    throw new WindowsVaultKeyManagerError("INVENTORY_CONFLICT");
  }
}

function ensureIdentity(
  connection: VaultStorageConnection,
  expected: { readonly vaultId: string; readonly keyId: string; readonly generation: number },
  allowCreation: boolean,
): void {
  try {
    const exists = identityTableExists(connection);
    if (!exists) {
      if (!allowCreation) {
        throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
      }
      createIdentity(connection, expected);
    }
    verifyIdentity(connection, expected);
  } catch (error) {
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
  }
}

function identityTableExists(connection: VaultStorageConnection): boolean {
  const row = connection.prepare(`
    SELECT type AS objectType
    FROM sqlite_schema
    WHERE name = ?
  `).get(IDENTITY_TABLE_NAME) as { objectType?: unknown } | undefined;
  if (row === undefined) return false;
  if (row.objectType !== "table") {
    throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
  }
  return true;
}

function createIdentity(
  connection: VaultStorageConnection,
  identity: { readonly vaultId: string; readonly keyId: string; readonly generation: number },
): void {
  connection.exec("BEGIN IMMEDIATE;");
  try {
    connection.exec(`
      CREATE TABLE ${IDENTITY_TABLE_NAME} (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        vault_id TEXT NOT NULL CHECK(length(vault_id) = 64),
        key_id TEXT NOT NULL CHECK(length(key_id) = 64),
        generation INTEGER NOT NULL CHECK(generation >= 1 AND generation <= ${MAX_STATE_GENERATION})
      ) STRICT;
    `);
    const result = connection.prepare(`
      INSERT INTO ${IDENTITY_TABLE_NAME} (
        singleton, schema_version, vault_id, key_id, generation
      ) VALUES (1, 1, ?, ?, ?)
    `).run(identity.vaultId, identity.keyId, identity.generation);
    if (Number(result.changes) !== 1) throw new Error("Identity insert failed.");
    connection.exec("COMMIT;");
  } catch (error) {
    try {
      connection.exec("ROLLBACK;");
    } catch {
      // Preserve the bounded identity failure.
    }
    throw error;
  }
}

function verifyIdentity(
  connection: VaultStorageConnection,
  expected: { readonly vaultId: string; readonly keyId: string; readonly generation: number },
): void {
  const rows = connection.prepare(`
    SELECT
      singleton,
      schema_version AS schemaVersion,
      vault_id AS vaultId,
      key_id AS keyId,
      generation
    FROM ${IDENTITY_TABLE_NAME}
    ORDER BY singleton
  `).all() as Array<Record<string, unknown>>;
  if (rows.length !== 1) {
    throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
  }
  const row = rows[0];
  if (
    Number(row?.singleton) !== 1 ||
    Number(row?.schemaVersion) !== 1 ||
    row?.vaultId !== expected.vaultId ||
    row?.keyId !== expected.keyId ||
    Number(row?.generation) !== expected.generation
  ) {
    throw new WindowsVaultKeyManagerError("IDENTITY_INVALID");
  }
}

function readState(statePath: string): VaultLifecycleState {
  const bytes = readBoundedRegularFile(statePath);
  let text: string;
  let parsed: unknown;
  try {
    text = utf8Decoder.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.schemaVersion !== WINDOWS_VAULT_STATE_SCHEMA_VERSION ||
    !HEX_256_PATTERN.test(typeof value.vaultId === "string" ? value.vaultId : "") ||
    !isValidGeneration(value.generation)
  ) {
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  }

  let canonical: VaultLifecycleState;
  if (value.status === "creating") {
    canonical = {
      schemaVersion: WINDOWS_VAULT_STATE_SCHEMA_VERSION,
      status: "creating",
      vaultId: value.vaultId as string,
      generation: value.generation as number,
    };
  } else if (
    value.status === "ready" &&
    HEX_256_PATTERN.test(typeof value.keyId === "string" ? value.keyId : "")
  ) {
    canonical = {
      schemaVersion: WINDOWS_VAULT_STATE_SCHEMA_VERSION,
      status: "ready",
      vaultId: value.vaultId as string,
      keyId: value.keyId as string,
      generation: value.generation as number,
    };
  } else {
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  }
  if (JSON.stringify(canonical) !== text) {
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  }
  return Object.freeze(canonical);
}

function readBoundedRegularFile(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    let pathStat: Stats;
    try {
      pathStat = lstatSync(path);
    } catch {
      throw new WindowsVaultKeyManagerError("STATE_INVALID");
    }
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink !== 1
    ) {
      throw new WindowsVaultKeyManagerError("STATE_INVALID");
    }
    if (pathStat.size > MAX_WINDOWS_VAULT_STATE_BYTES) {
      throw new WindowsVaultKeyManagerError("STATE_OVERSIZE");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.size !== pathStat.size ||
      openedStat.nlink !== 1 ||
      (pathStat.ino !== 0 && openedStat.ino !== pathStat.ino) ||
      (pathStat.dev !== 0 && openedStat.dev !== pathStat.dev)
    ) {
      throw new WindowsVaultKeyManagerError("STATE_INVALID");
    }
    if (openedStat.size > MAX_WINDOWS_VAULT_STATE_BYTES) {
      throw new WindowsVaultKeyManagerError("STATE_OVERSIZE");
    }
    const bytes = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw new WindowsVaultKeyManagerError("STATE_INVALID");
      offset += count;
    }
    if (fstatSync(descriptor).size !== openedStat.size) {
      throw new WindowsVaultKeyManagerError("STATE_INVALID");
    }
    return bytes;
  } catch (error) {
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the bounded state result.
      }
    }
  }
}

function persistInitialState(statePath: string, state: CreatingState): void {
  const bytes = serializeState(state);
  const temporaryPath = temporaryStatePath(statePath);
  let descriptor: number | undefined;
  let linked = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, statePath);
    linked = true;
    unlinkSync(temporaryPath);
  } catch (error) {
    closeDescriptorQuietly(descriptor);
    unlinkQuietly(temporaryPath);
    if (!linked && hasErrorCode(error, "EEXIST")) {
      throw new WindowsVaultKeyManagerError("BUSY");
    }
    throw new WindowsVaultKeyManagerError("STATE_PERSIST_FAILED");
  }
}

function replaceCreatingState(
  statePath: string,
  expected: CreatingState,
  ready: ReadyState,
): void {
  const observed = readState(statePath);
  if (
    observed.status !== "creating" ||
    observed.vaultId !== expected.vaultId ||
    observed.generation !== expected.generation
  ) {
    throw new WindowsVaultKeyManagerError("STATE_INVALID");
  }
  const bytes = serializeState(ready);
  const temporaryPath = temporaryStatePath(statePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, statePath);
    const persisted = readState(statePath);
    if (
      persisted.status !== "ready" ||
      persisted.vaultId !== ready.vaultId ||
      persisted.keyId !== ready.keyId ||
      persisted.generation !== ready.generation
    ) {
      throw new WindowsVaultKeyManagerError("STATE_PERSIST_FAILED");
    }
  } catch (error) {
    closeDescriptorQuietly(descriptor);
    unlinkQuietly(temporaryPath);
    if (error instanceof WindowsVaultKeyManagerError) throw error;
    throw new WindowsVaultKeyManagerError("STATE_PERSIST_FAILED");
  }
}

function serializeState(state: VaultLifecycleState): Buffer {
  const bytes = Buffer.from(JSON.stringify(state), "utf8");
  if (bytes.byteLength > MAX_WINDOWS_VAULT_STATE_BYTES) {
    throw new WindowsVaultKeyManagerError("STATE_PERSIST_FAILED");
  }
  return bytes;
}

function temporaryStatePath(statePath: string): string {
  const directory = statePath.slice(0, statePath.length - WINDOWS_VAULT_STATE_FILE_NAME.length);
  return join(
    directory,
    `${STATE_TEMPORARY_PREFIX}${process.pid}-${Date.now()}-${temporaryStateCounter++}.tmp`,
  );
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count <= 0) throw new Error("Short state write.");
    offset += count;
  }
}

function closeDescriptorQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {
    // Preserve the selected content-free lifecycle result.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary path may not exist or may already have been removed.
  }
}

function closeVaultQuietly(vault: Vault | undefined): void {
  try {
    vault?.close();
  } catch {
    // Preserve the selected content-free lifecycle result.
  }
}

function isValidGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_STATE_GENERATION;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
