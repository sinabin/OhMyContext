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

export interface VaultStorageDescriptor {
  readonly providerId: string;
  readonly securityProfile: VaultStorageSecurityProfile;
  readonly atRestEncryption: "none" | "provider-managed";
  readonly keyManagement: "none" | "os-protected";
}

export interface VaultStorageProvider {
  readonly descriptor: VaultStorageDescriptor;
  /**
   * Reads the schema compatibility marker without changing the original
   * storage or creating its parent directory.
   */
  inspectSchemaVersion(location: string): number;
  open(location: string): VaultStorageConnection;
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
} satisfies VaultStorageDescriptor);

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
  if (
    !isObject(value) ||
    typeof value.inspectSchemaVersion !== "function" ||
    typeof value.open !== "function"
  ) {
    throw new TypeError("An explicit OwnContext vault storage provider is required.");
  }
  const descriptor = value.descriptor;
  if (
    !isObject(descriptor) ||
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
  if (!plaintext && !encryptedCandidate) {
    throw new TypeError("Vault storage provider security metadata is inconsistent.");
  }
  return value as unknown as VaultStorageProvider;
}

export function snapshotVaultStorageDescriptor(
  descriptor: VaultStorageDescriptor,
): VaultStorageDescriptor {
  return Object.freeze({
    providerId: descriptor.providerId,
    securityProfile: descriptor.securityProfile,
    atRestEncryption: descriptor.atRestEncryption,
    keyManagement: descriptor.keyManagement,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
