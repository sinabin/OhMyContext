import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { inspectNodeSqliteSchemaVersion } from "./sqlite-compatibility.js";

export type VaultStorageValue = SQLInputValue;

export interface VaultStorageRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface VaultStorageStatement {
  all(...parameters: VaultStorageValue[]): unknown[];
  get(...parameters: VaultStorageValue[]): unknown;
  run(...parameters: VaultStorageValue[]): VaultStorageRunResult;
}

export interface VaultStorageConnection {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): VaultStorageStatement;
}

export type VaultStorageSecurityProfile =
  | "plaintext-development"
  | "encrypted-candidate";

export const ENCRYPTED_VAULT_KEY_BYTES = 32 as const;

export type EncryptedVaultOpenMode = "open-existing" | "create-exclusive";

export interface VaultStorageDescriptor {
  readonly providerId: string;
  readonly securityProfile: VaultStorageSecurityProfile;
  readonly atRestEncryption: "none" | "provider-managed";
  readonly keyManagement: "none" | "os-protected";
}

export interface EncryptedVaultStorageDescriptor extends VaultStorageDescriptor {
  readonly securityProfile: "encrypted-candidate";
  readonly atRestEncryption: "provider-managed";
  readonly keyManagement: "os-protected";
}

export interface PlaintextVaultStorageDescriptor extends VaultStorageDescriptor {
  readonly securityProfile: "plaintext-development";
  readonly atRestEncryption: "none";
  readonly keyManagement: "none";
}

export interface VaultStorageProvider {
  readonly descriptor: PlaintextVaultStorageDescriptor;
  /**
   * Reads the schema compatibility marker without changing the original
   * storage or creating its parent directory.
   */
  inspectSchemaVersion(location: string): number;
  open(location: string): VaultStorageConnection;
}

export interface EncryptedVaultCipherAttestation {
  readonly status: "active";
}

export interface EncryptedVaultCandidateSession {
  readonly connection: VaultStorageConnection;
  /** Performs the provider-specific positive cipher-status query. */
  attestCipher(): EncryptedVaultCipherAttestation;
  /** Reads the schema version only after keying and cipher attestation. */
  inspectSchemaVersion(): number;
}

export interface EncryptedVaultCandidateOpenRequest {
  readonly location: string;
  /**
   * Borrowed raw key bytes. The provider must not stringify, retain, or expose
   * this Buffer and must apply it before its first database-page access.
   */
  readonly key: Buffer;
  /**
   * `open-existing` must never create a replacement database.
   * `create-exclusive` must fail rather than overwrite an existing artifact.
   */
  readonly mode: EncryptedVaultOpenMode;
}

export interface EncryptedVaultCandidateProvider {
  readonly descriptor: EncryptedVaultStorageDescriptor;
  /**
   * No plaintext or keyless compatibility fallback is permitted. If this
   * method throws after acquiring a connection, it must close that connection
   * before throwing because the caller has no handle it can clean up.
   */
  openKeyed(
    request: EncryptedVaultCandidateOpenRequest,
  ): EncryptedVaultCandidateSession;
}

export type EncryptedVaultCandidateErrorCode =
  | "KEYED_OPEN_REQUIRED"
  | "INVALID_REQUEST"
  | "INVALID_PROVIDER"
  | "OPEN_FAILED"
  | "CIPHER_ATTESTATION_FAILED"
  | "SCHEMA_INSPECTION_FAILED"
  | "INITIALIZATION_FAILED";

const ENCRYPTED_VAULT_CANDIDATE_ERROR_MESSAGES: Readonly<
  Record<EncryptedVaultCandidateErrorCode, string>
> = Object.freeze({
  KEYED_OPEN_REQUIRED: "Encrypted vault candidates require the keyed open boundary.",
  INVALID_REQUEST: "Encrypted vault candidate request is invalid.",
  INVALID_PROVIDER: "Encrypted vault candidate provider is invalid.",
  OPEN_FAILED: "Encrypted vault candidate could not be opened.",
  CIPHER_ATTESTATION_FAILED: "Encrypted vault candidate cipher attestation failed.",
  SCHEMA_INSPECTION_FAILED: "Encrypted vault candidate schema inspection failed.",
  INITIALIZATION_FAILED: "Encrypted vault candidate initialization failed.",
});

export class EncryptedVaultCandidateError extends Error {
  public readonly code: EncryptedVaultCandidateErrorCode;

  public constructor(code: EncryptedVaultCandidateErrorCode) {
    super(ENCRYPTED_VAULT_CANDIDATE_ERROR_MESSAGES[code]);
    this.name = "EncryptedVaultCandidateError";
    this.code = code;
  }
}

class NodeSqliteStatement implements VaultStorageStatement {
  public constructor(private readonly statement: StatementSync) {}

  public all(...parameters: VaultStorageValue[]): unknown[] {
    return this.statement.all(...parameters);
  }

  public get(...parameters: VaultStorageValue[]): unknown {
    return this.statement.get(...parameters);
  }

  public run(...parameters: VaultStorageValue[]): VaultStorageRunResult {
    const result = this.statement.run(...parameters);
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

class NodeSqliteDevelopmentConnection implements VaultStorageConnection {
  private readonly database: DatabaseSync;

  public constructor(location: string) {
    this.database = new DatabaseSync(location);
  }

  public close(): void {
    this.database.close();
  }

  public exec(sql: string): void {
    this.database.exec(sql);
  }

  public prepare(sql: string): VaultStorageStatement {
    return new NodeSqliteStatement(this.database.prepare(sql));
  }
}

const NODE_SQLITE_DEVELOPMENT_DESCRIPTOR = Object.freeze({
  providerId: "node-sqlite-development",
  securityProfile: "plaintext-development",
  atRestEncryption: "none",
  keyManagement: "none",
} satisfies PlaintextVaultStorageDescriptor);

/**
 * Creates the explicit plaintext provider used by tests and the developer
 * alpha. It is deliberately named and described as development-only so a
 * future public profile cannot obtain plaintext storage through an implicit
 * fallback.
 */
export function createNodeSqliteDevelopmentStorageProvider(): VaultStorageProvider {
  return Object.freeze({
    descriptor: NODE_SQLITE_DEVELOPMENT_DESCRIPTOR,
    inspectSchemaVersion: inspectNodeSqliteSchemaVersion,
    open: (location: string) => new NodeSqliteDevelopmentConnection(location),
  });
}

export function validateVaultStorageProvider(
  value: unknown,
): VaultStorageProvider {
  if (!isObject(value)) {
    throw new TypeError("An explicit OhMyContext vault storage provider is required.");
  }

  let descriptor: CapturedVaultStorageDescriptor | undefined;
  let inspectSchemaVersion: unknown;
  let openConnection: unknown;
  try {
    descriptor = captureVaultStorageDescriptor(value.descriptor);
    inspectSchemaVersion = value.inspectSchemaVersion;
    openConnection = value.open;
  } catch {
    throw new TypeError("Vault storage provider metadata is invalid.");
  }

  if (descriptor && isEncryptedCandidateDescriptor(descriptor)) {
    throw new EncryptedVaultCandidateError("KEYED_OPEN_REQUIRED");
  }
  if (
    typeof inspectSchemaVersion !== "function" ||
    typeof openConnection !== "function"
  ) {
    throw new TypeError("An explicit OhMyContext vault storage provider is required.");
  }
  if (
    !descriptor ||
    typeof descriptor.providerId !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{2,63}$/u.test(descriptor.providerId)
  ) {
    throw new TypeError("Vault storage provider metadata is invalid.");
  }
  const plaintext =
    descriptor.securityProfile === "plaintext-development" &&
    descriptor.atRestEncryption === "none" &&
    descriptor.keyManagement === "none";
  const encryptedCandidate =
    descriptor.securityProfile === "encrypted-candidate" &&
    descriptor.atRestEncryption === "provider-managed" &&
    descriptor.keyManagement === "os-protected";
  if (encryptedCandidate) {
    throw new EncryptedVaultCandidateError("KEYED_OPEN_REQUIRED");
  }
  if (!plaintext) {
    throw new TypeError("Vault storage provider security metadata is inconsistent.");
  }

  const descriptorSnapshot = Object.freeze({
    providerId: descriptor.providerId,
    securityProfile: "plaintext-development" as const,
    atRestEncryption: "none" as const,
    keyManagement: "none" as const,
  });
  return Object.freeze({
    descriptor: descriptorSnapshot,
    inspectSchemaVersion: (location: string) =>
      Reflect.apply(inspectSchemaVersion, value, [location]) as number,
    open: (location: string) =>
      Reflect.apply(openConnection, value, [location]) as VaultStorageConnection,
  });
}

export function validateEncryptedVaultCandidateProvider(
  value: unknown,
): EncryptedVaultCandidateProvider {
  try {
    if (!isObject(value)) {
      throw new Error("Invalid encrypted provider.");
    }
    const descriptor = captureVaultStorageDescriptor(value.descriptor);
    const openKeyed = value.openKeyed;
    if (typeof openKeyed !== "function" || !isEncryptedCandidateDescriptor(descriptor)) {
      throw new Error("Invalid encrypted provider.");
    }
    const descriptorSnapshot = Object.freeze({
      providerId: descriptor.providerId,
      securityProfile: "encrypted-candidate" as const,
      atRestEncryption: "provider-managed" as const,
      keyManagement: "os-protected" as const,
    });
    return Object.freeze({
      descriptor: descriptorSnapshot,
      openKeyed: (request: EncryptedVaultCandidateOpenRequest) =>
        Reflect.apply(openKeyed, value, [request]) as EncryptedVaultCandidateSession,
    });
  } catch {
    throw new EncryptedVaultCandidateError("INVALID_PROVIDER");
  }
}

export function snapshotVaultStorageDescriptor(
  descriptor: VaultStorageDescriptor,
): VaultStorageDescriptor {
  const captured = captureVaultStorageDescriptor(descriptor);
  if (
    !captured ||
    typeof captured.providerId !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{2,63}$/u.test(captured.providerId) ||
    (!isPlaintextDescriptor(captured) &&
      !isEncryptedCandidateDescriptor(captured))
  ) {
    throw new TypeError("Vault storage provider metadata is invalid.");
  }
  return Object.freeze({
    providerId: captured.providerId,
    securityProfile: captured.securityProfile,
    atRestEncryption: captured.atRestEncryption,
    keyManagement: captured.keyManagement,
  });
}

interface CapturedVaultStorageDescriptor {
  readonly providerId: unknown;
  readonly securityProfile: unknown;
  readonly atRestEncryption: unknown;
  readonly keyManagement: unknown;
}

function captureVaultStorageDescriptor(
  value: unknown,
): CapturedVaultStorageDescriptor | undefined {
  if (!isObject(value)) return undefined;
  return Object.freeze({
    providerId: value.providerId,
    securityProfile: value.securityProfile,
    atRestEncryption: value.atRestEncryption,
    keyManagement: value.keyManagement,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEncryptedCandidateDescriptor(
  value: unknown,
): value is EncryptedVaultStorageDescriptor {
  return isObject(value) &&
    typeof value.providerId === "string" &&
    /^[a-z0-9][a-z0-9.-]{2,63}$/u.test(value.providerId) &&
    value.securityProfile === "encrypted-candidate" &&
    value.atRestEncryption === "provider-managed" &&
    value.keyManagement === "os-protected";
}

function isPlaintextDescriptor(
  value: unknown,
): value is PlaintextVaultStorageDescriptor {
  return isObject(value) &&
    typeof value.providerId === "string" &&
    /^[a-z0-9][a-z0-9.-]{2,63}$/u.test(value.providerId) &&
    value.securityProfile === "plaintext-development" &&
    value.atRestEncryption === "none" &&
    value.keyManagement === "none";
}
