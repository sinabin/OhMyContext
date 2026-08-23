import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeSqliteDevelopmentStorageProvider,
  ENCRYPTED_VAULT_KEY_BYTES,
  EncryptedVaultCandidateError,
  openEncryptedVaultCandidate,
  openVault,
  type EncryptedVaultCandidateErrorCode,
  type EncryptedVaultCandidateProvider,
  type EncryptedVaultCipherAttestation,
  type EncryptedVaultOpenMode,
  type EncryptedVaultStorageDescriptor,
  type OpenEncryptedVaultCandidateOptions,
  type Vault,
  type VaultStorageConnection,
  type VaultStorageProvider,
  type VaultStorageStatement,
} from "../src/index.js";

const CANDIDATE_DESCRIPTOR = Object.freeze({
  providerId: "test-encrypted-candidate",
  securityProfile: "encrypted-candidate",
  atRestEncryption: "provider-managed",
  keyManagement: "os-protected",
} satisfies EncryptedVaultStorageDescriptor);

const temporaryPaths: string[] = [];
const openVaults: Vault[] = [];

afterEach(async () => {
  for (const vault of openVaults.splice(0)) vault.close();
  for (const temporaryPath of temporaryPaths.splice(0)) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "owncontext-encrypted-storage-"));
  temporaryPaths.push(root);
  return root;
}

function expectCandidateError(
  operation: () => unknown,
  code: EncryptedVaultCandidateErrorCode,
  forbidden: readonly string[] = [],
): EncryptedVaultCandidateError {
  let observed: unknown;
  try {
    operation();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(EncryptedVaultCandidateError);
  if (!(observed instanceof EncryptedVaultCandidateError)) {
    throw new Error("Expected an EncryptedVaultCandidateError.");
  }
  expect(observed.code).toBe(code);
  expect("cause" in observed).toBe(false);
  for (const value of forbidden) {
    expect(observed.message).not.toContain(value);
  }
  return observed;
}

function inertStatement(): VaultStorageStatement {
  return {
    all: () => [],
    get: () => undefined,
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
  };
}

function tracedConnection(
  trace: string[],
  options: {
    closeThrows?: boolean;
    execThrows?: boolean;
  } = {},
): VaultStorageConnection {
  return {
    close() {
      trace.push("close");
      if (options.closeThrows) throw new Error("secret:close-failure");
    },
    exec() {
      trace.push("schema-exec");
      if (options.execThrows) throw new Error("secret:initialization-failure");
    },
    prepare() {
      trace.push("schema-prepare");
      return inertStatement();
    },
  };
}

describe("encrypted vault candidate boundary", () => {
  it("rejects an encrypted descriptor on the keyless open path before filesystem access", async () => {
    const root = await temporaryRoot();
    const databaseDirectory = join(root, "not-created");
    const databasePath = join(databaseDirectory, "vault.sqlite");
    const plaintext = createNodeSqliteDevelopmentStorageProvider();
    let inspected = false;
    let opened = false;
    const spoof = {
      descriptor: CANDIDATE_DESCRIPTOR,
      inspectSchemaVersion(location: string) {
        inspected = true;
        return plaintext.inspectSchemaVersion(location);
      },
      open(location: string) {
        opened = true;
        return plaintext.open(location);
      },
    } as unknown as VaultStorageProvider;

    expectCandidateError(
      () => openVault(databasePath, spoof),
      "KEYED_OPEN_REQUIRED",
      [databasePath, CANDIDATE_DESCRIPTOR.providerId],
    );
    expect(inspected).toBe(false);
    expect(opened).toBe(false);
    expect(existsSync(databaseDirectory)).toBe(false);
  });

  it("captures a keyless provider descriptor once so it cannot change the reported profile", () => {
    const plaintext = createNodeSqliteDevelopmentStorageProvider();
    let descriptorReads = 0;
    const provider = {
      get descriptor() {
        descriptorReads += 1;
        return descriptorReads === 1
          ? plaintext.descriptor
          : CANDIDATE_DESCRIPTOR;
      },
      inspectSchemaVersion: plaintext.inspectSchemaVersion,
      open: plaintext.open,
    } as unknown as VaultStorageProvider;

    const vault = openVault(":memory:", provider);
    openVaults.push(vault);

    expect(descriptorReads).toBe(1);
    expect(vault.storage).toEqual(plaintext.descriptor);
    expect(vault.storage.securityProfile).toBe("plaintext-development");
  });

  it.each(["open-existing", "create-exclusive"] satisfies EncryptedVaultOpenMode[])(
    "passes a borrowed 32-byte Buffer and the explicit %s mode before attesting and reading schema",
    async (mode) => {
      const root = await temporaryRoot();
      const databasePath = join(root, `${mode}.sqlite`);
      const key = Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES, 0xa7);
      const trace: string[] = [];
      const plaintext = createNodeSqliteDevelopmentStorageProvider();
      let receivedKey: Buffer | undefined;
      let receivedLocation: string | undefined;
      let receivedMode: EncryptedVaultOpenMode | undefined;
      let requestFrozen = false;
      let closeCount = 0;

      const provider: EncryptedVaultCandidateProvider = {
        descriptor: CANDIDATE_DESCRIPTOR,
        openKeyed(request) {
          trace.push("open-keyed");
          receivedKey = request.key;
          receivedLocation = request.location;
          receivedMode = request.mode;
          requestFrozen = Object.isFrozen(request);
          const base = plaintext.open(":memory:");
          const connection: VaultStorageConnection = {
            close() {
              closeCount += 1;
              base.close();
            },
            exec(sql) {
              trace.push("schema-exec");
              base.exec(sql);
            },
            prepare(sql) {
              trace.push("schema-prepare");
              return base.prepare(sql);
            },
          };
          return {
            connection,
            attestCipher() {
              trace.push("attest-cipher");
              return Object.freeze({ status: "active" as const });
            },
            inspectSchemaVersion() {
              trace.push("inspect-schema");
              return 0;
            },
          };
        },
      };

      const vault = openEncryptedVaultCandidate(databasePath, provider, { key, mode });
      openVaults.push(vault);

      expect(receivedKey).toBe(key);
      expect(receivedKey).toEqual(Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES, 0xa7));
      expect(receivedLocation).toBe(resolve(databasePath));
      expect(receivedMode).toBe(mode);
      expect(requestFrozen).toBe(true);
      expect(trace.slice(0, 3)).toEqual([
        "open-keyed",
        "attest-cipher",
        "inspect-schema",
      ]);
      expect(trace.indexOf("schema-exec")).toBeGreaterThan(trace.indexOf("inspect-schema"));
      expect(closeCount).toBe(0);
      expect(vault.storage).toEqual(CANDIDATE_DESCRIPTOR);
      expect(Object.isFrozen(vault.storage)).toBe(true);

      vault.close();
      expect(closeCount).toBe(1);
    },
  );

  it("rejects non-Buffer, short, long, and invalid-mode requests before calling the provider", async () => {
    const root = await temporaryRoot();
    const databaseDirectory = join(root, "not-created");
    const databasePath = join(databaseDirectory, "vault.sqlite");
    let opens = 0;
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        opens += 1;
        throw new Error("must not open");
      },
    };
    const shadowedShortKey = Buffer.alloc(1);
    Object.defineProperty(shadowedShortKey, "byteLength", {
      value: ENCRYPTED_VAULT_KEY_BYTES,
    });
    const shadowedLongKey = Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES + 1);
    Object.defineProperty(shadowedLongKey, "byteLength", {
      value: ENCRYPTED_VAULT_KEY_BYTES,
    });
    const proxiedKey = new Proxy(Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES), {
      get(target, property, receiver) {
        if (property === "byteLength") return ENCRYPTED_VAULT_KEY_BYTES;
        return Reflect.get(target, property, receiver);
      },
    });
    const invalidOptions: unknown[] = [
      { key: new Uint8Array(ENCRYPTED_VAULT_KEY_BYTES), mode: "open-existing" },
      { key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES - 1), mode: "open-existing" },
      { key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES + 1), mode: "open-existing" },
      { key: shadowedShortKey, mode: "open-existing" },
      { key: shadowedLongKey, mode: "open-existing" },
      { key: proxiedKey, mode: "open-existing" },
      { key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES), mode: "open-or-create" },
    ];

    for (const options of invalidOptions) {
      expectCandidateError(
        () => openEncryptedVaultCandidate(
          databasePath,
          provider,
          options as OpenEncryptedVaultCandidateOptions,
        ),
        "INVALID_REQUEST",
        [databasePath],
      );
    }
    expect(opens).toBe(0);
    expect(existsSync(databaseDirectory)).toBe(false);
  });

  it("maps invalid or hostile provider metadata to a content-free error", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "invalid-provider.sqlite");
    const key = Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES, 0xd1);
    const provider = {
      get descriptor(): EncryptedVaultStorageDescriptor {
        throw new Error(`secret:${key.toString("hex")}:${databasePath}`);
      },
      openKeyed() {
        throw new Error("must not open");
      },
    } as EncryptedVaultCandidateProvider;

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key,
        mode: "open-existing",
      }),
      "INVALID_PROVIDER",
      [key.toString("hex"), databasePath],
    );
  });

  it("closes without schema access when cipher attestation fails, even if close throws", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "cipher-failure.sqlite");
    const key = Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES, 0xb8);
    const trace: string[] = [];
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        trace.push("open-keyed");
        return {
          connection: tracedConnection(trace, { closeThrows: true }),
          attestCipher() {
            trace.push("attest-cipher");
            throw new Error(`secret:${key.toString("hex")}:${databasePath}`);
          },
          inspectSchemaVersion() {
            trace.push("inspect-schema");
            return 0;
          },
        };
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key,
        mode: "open-existing",
      }),
      "CIPHER_ATTESTATION_FAILED",
      [key.toString("hex"), databasePath, CANDIDATE_DESCRIPTOR.providerId],
    );
    expect(trace).toEqual(["open-keyed", "attest-cipher", "close"]);
  });

  it("requires an exact active attestation object", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "invalid-attestation.sqlite");
    const trace: string[] = [];
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        return {
          connection: tracedConnection(trace),
          attestCipher() {
            trace.push("attest-cipher");
            return {
              status: "active",
              unreviewedClaim: true,
            } as unknown as EncryptedVaultCipherAttestation;
          },
          inspectSchemaVersion() {
            trace.push("inspect-schema");
            return 0;
          },
        };
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES),
        mode: "open-existing",
      }),
      "CIPHER_ATTESTATION_FAILED",
    );
    expect(trace).toEqual(["attest-cipher", "close"]);
  });

  it.each([
    {
      name: "provider schema error",
      inspect: () => {
        throw new Error("secret:schema-inspection");
      },
    },
    { name: "future schema", inspect: () => 99 },
  ])("closes before initialization on $name", async ({ inspect }) => {
    const root = await temporaryRoot();
    const databasePath = join(root, "schema-failure.sqlite");
    const trace: string[] = [];
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        return {
          connection: tracedConnection(trace),
          attestCipher() {
            trace.push("attest-cipher");
            return { status: "active" };
          },
          inspectSchemaVersion() {
            trace.push("inspect-schema");
            return inspect();
          },
        };
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES),
        mode: "open-existing",
      }),
      "SCHEMA_INSPECTION_FAILED",
      ["secret:schema-inspection", databasePath],
    );
    expect(trace).toEqual(["attest-cipher", "inspect-schema", "close"]);
  });

  it("closes and returns a content-free error when schema initialization fails", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "initialization-failure.sqlite");
    const trace: string[] = [];
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        return {
          connection: tracedConnection(trace, { execThrows: true }),
          attestCipher() {
            trace.push("attest-cipher");
            return { status: "active" };
          },
          inspectSchemaVersion() {
            trace.push("inspect-schema");
            return 0;
          },
        };
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES),
        mode: "create-exclusive",
      }),
      "INITIALIZATION_FAILED",
      ["secret:initialization-failure", databasePath],
    );
    expect(trace).toEqual([
      "attest-cipher",
      "inspect-schema",
      "schema-exec",
      "close",
    ]);
  });

  it("does not fall back or create storage when keyed open fails", async () => {
    const root = await temporaryRoot();
    const databaseDirectory = join(root, "not-created");
    const databasePath = join(databaseDirectory, "vault.sqlite");
    const key = Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES, 0xc9);
    let opens = 0;
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        opens += 1;
        throw new Error(`secret:${key.toString("hex")}:${databasePath}`);
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key,
        mode: "create-exclusive",
      }),
      "OPEN_FAILED",
      [key.toString("hex"), databasePath, CANDIDATE_DESCRIPTOR.providerId],
    );
    expect(opens).toBe(1);
    expect(existsSync(databaseDirectory)).toBe(false);
  });

  it("closes a connection returned inside a malformed session", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "malformed-session.sqlite");
    let closes = 0;
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        return {
          connection: {
            close() {
              closes += 1;
            },
          },
        } as unknown as ReturnType<EncryptedVaultCandidateProvider["openKeyed"]>;
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES),
        mode: "open-existing",
      }),
      "OPEN_FAILED",
    );
    expect(closes).toBe(1);
  });

  it("captures one-shot connection and close getters once before malformed-session cleanup", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "one-shot-malformed-session.sqlite");
    let connectionReads = 0;
    let closeReads = 0;
    let closes = 0;
    const malformedConnection = {
      get close() {
        closeReads += 1;
        if (closeReads > 1) throw new Error("secret:second-close-read");
        return () => {
          closes += 1;
        };
      },
    };
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed() {
        return {
          get connection() {
            connectionReads += 1;
            return connectionReads === 1 ? malformedConnection : undefined;
          },
        } as unknown as ReturnType<EncryptedVaultCandidateProvider["openKeyed"]>;
      },
    };

    expectCandidateError(
      () => openEncryptedVaultCandidate(databasePath, provider, {
        key: Buffer.alloc(ENCRYPTED_VAULT_KEY_BYTES),
        mode: "open-existing",
      }),
      "OPEN_FAILED",
      ["secret:second-close-read"],
    );
    expect(connectionReads).toBe(1);
    expect(closeReads).toBe(1);
    expect(closes).toBe(1);
  });
});
