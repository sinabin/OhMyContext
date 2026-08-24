import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeSqliteDevelopmentStorageProvider,
  type EncryptedVaultCandidateProvider,
  type EncryptedVaultCandidateSession,
  type EncryptedVaultOpenMode,
  type EncryptedVaultStorageDescriptor,
  type VaultStorageConnection,
  type VaultStorageStatement,
} from "@owncontext/core";
import {
  VAULT_KEY_PROVIDER_ID,
  VaultKeyProtector,
  createVaultKeyEnvelope,
  type UnprotectedVaultKey,
} from "../src/electron/vault-key-envelope.js";
import {
  MAX_WINDOWS_VAULT_STATE_BYTES,
  WINDOWS_ENCRYPTED_VAULT_FILE_NAME,
  WINDOWS_LEGACY_PLAINTEXT_MARKER_FILE_NAME,
  WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME,
  WINDOWS_VAULT_STATE_FILE_NAME,
  WindowsVaultKeyManagerError,
  deriveWindowsVaultId,
  openWindowsEncryptedVaultCandidate,
  type WindowsVaultKeyManagerErrorCode,
} from "../src/electron/vault-key-manager.js";

const CANDIDATE_DESCRIPTOR = Object.freeze({
  providerId: "test-encrypted-lifecycle-candidate",
  securityProfile: "encrypted-candidate",
  atRestEncryption: "provider-managed",
  keyManagement: "os-protected",
} satisfies EncryptedVaultStorageDescriptor);
const createdRoots: string[] = [];
const retainedKeys: Buffer[] = [];

class TestProtector extends VaultKeyProtector {
  readonly providerId = VAULT_KEY_PROVIDER_ID;
  available = true;
  failUnprotect = false;
  shouldReEncrypt = false;
  protectEntered?: () => void;
  protectGate?: Promise<void>;
  seenProtectKey?: Buffer;
  seenUnprotectedKey?: Buffer;
  protectCalls = 0;
  unprotectCalls = 0;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async protect(key: Buffer): Promise<Buffer> {
    this.protectCalls += 1;
    this.seenProtectKey = key;
    this.protectEntered?.();
    await this.protectGate;
    return Buffer.concat([Buffer.from("test-wrapped:"), key]);
  }

  async unprotect(wrappedKey: Buffer): Promise<UnprotectedVaultKey> {
    this.unprotectCalls += 1;
    if (this.failUnprotect) throw new Error("secret:unwrap-failure");
    const prefix = Buffer.from("test-wrapped:");
    if (!wrappedKey.subarray(0, prefix.length).equals(prefix)) {
      throw new Error("secret:bad-wrapper");
    }
    this.seenUnprotectedKey = Buffer.from(wrappedKey.subarray(prefix.length));
    return {
      key: this.seenUnprotectedKey,
      shouldReEncrypt: this.shouldReEncrypt,
    };
  }
}

interface TestProviderOptions {
  failOpen?: boolean;
  failIdentityCreateOnce?: boolean;
  failIdentityVerifyOnce?: boolean;
  wrongKey?: boolean;
}

class TestEncryptedProvider implements EncryptedVaultCandidateProvider {
  readonly descriptor = CANDIDATE_DESCRIPTOR;
  readonly modes: EncryptedVaultOpenMode[] = [];
  readonly seenKeys: Buffer[] = [];
  openCount = 0;
  closeCount = 0;
  failOpen = false;
  failIdentityCreateOnce = false;
  failIdentityVerifyOnce = false;
  wrongKey = false;
  private expectedKey?: Buffer;

  constructor(options: TestProviderOptions = {}) {
    Object.assign(this, options);
  }

  openKeyed(request: Parameters<EncryptedVaultCandidateProvider["openKeyed"]>[0]) {
    this.openCount += 1;
    this.modes.push(request.mode);
    this.seenKeys.push(request.key);
    if (this.failOpen) throw new Error("secret:provider-open-failure");

    if (request.mode === "create-exclusive") {
      const descriptor = openSync(request.location, "wx", 0o600);
      closeSync(descriptor);
      this.expectedKey = Buffer.from(request.key);
      retainedKeys.push(this.expectedKey);
    } else {
      if (!existsSync(request.location)) throw new Error("secret:missing-database");
      if (
        this.wrongKey ||
        (this.expectedKey && !sameBytes(this.expectedKey, request.key))
      ) {
        throw new Error("secret:wrong-key");
      }
    }

    const development = createNodeSqliteDevelopmentStorageProvider();
    const base = development.open(request.location);
    const owner = this;
    const connection: VaultStorageConnection = {
      close() {
        owner.closeCount += 1;
        base.close();
      },
      exec(sql: string) {
        if (
          owner.failIdentityCreateOnce &&
          sql.includes("CREATE TABLE __owncontext_vault_identity")
        ) {
          owner.failIdentityCreateOnce = false;
          throw new Error("secret:identity-create-failure");
        }
        base.exec(sql);
      },
      prepare(sql: string): VaultStorageStatement {
        const statement = base.prepare(sql);
        if (
          owner.failIdentityVerifyOnce &&
          sql.includes("FROM __owncontext_vault_identity")
        ) {
          owner.failIdentityVerifyOnce = false;
          return {
            all() {
              throw new Error("secret:identity-verify-failure");
            },
            get(...parameters) {
              return statement.get(...parameters);
            },
            run(...parameters) {
              return statement.run(...parameters);
            },
          };
        }
        return statement;
      },
    };
    return {
      connection,
      attestCipher() {
        return { status: "active" as const };
      },
      inspectSchemaVersion() {
        const row = connection.prepare("PRAGMA user_version").get() as {
          user_version?: number | bigint;
        } | undefined;
        return Number(row?.user_version ?? 0);
      },
    };
  }
}

afterEach(() => {
  for (const key of retainedKeys.splice(0)) key.fill(0);
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "owncontext-vault-manager-"));
  createdRoots.push(root);
  return root;
}

function statePath(root: string): string {
  return join(root, WINDOWS_VAULT_STATE_FILE_NAME);
}

function envelopePath(root: string): string {
  return join(root, WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME);
}

function databasePath(root: string): string {
  return join(root, WINDOWS_ENCRYPTED_VAULT_FILE_NAME);
}

function readState(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(root), "utf8")) as Record<string, unknown>;
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function expectManagerError(
  operation: () => unknown | Promise<unknown>,
  code: WindowsVaultKeyManagerErrorCode,
  forbidden: readonly string[] = [],
): Promise<WindowsVaultKeyManagerError> {
  let observed: unknown;
  try {
    await operation();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(WindowsVaultKeyManagerError);
  if (!(observed instanceof WindowsVaultKeyManagerError)) {
    throw new Error("Expected WindowsVaultKeyManagerError.");
  }
  expect(observed.code).toBe(code);
  expect("cause" in observed).toBe(false);
  for (const value of forbidden) expect(observed.message).not.toContain(value);
  return observed;
}

async function successfullyCreate(
  root: string,
  provider = new TestEncryptedProvider(),
  protector = new TestProtector(),
) {
  const opened = await openWindowsEncryptedVaultCandidate({
    rootPath: root,
    provider,
    protector,
  });
  return { opened, provider, protector };
}

function identityExists(root: string): boolean {
  const development = createNodeSqliteDevelopmentStorageProvider();
  const connection = development.open(databasePath(root));
  try {
    const row = connection.prepare(`
      SELECT type FROM sqlite_schema
      WHERE name = '__owncontext_vault_identity'
    `).get() as { type?: string } | undefined;
    return row?.type === "table";
  } finally {
    connection.close();
  }
}

const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("Windows encrypted vault key manager", () => {
  it("creates a canonical path-bound journal, identity, and restarts without rewriting", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    const first = await successfullyCreate(root, provider, protector);
    const expectedVaultId = deriveWindowsVaultId(root);

    expect(first.opened.vaultId).toBe(expectedVaultId);
    expect(first.opened.vaultId).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.opened.generation).toBe(1);
    expect(first.opened.rotationPending).toBe(false);
    expect(provider.modes).toEqual(["create-exclusive"]);
    expect(identityExists(root)).toBe(true);
    expect(protector.seenProtectKey).toEqual(Buffer.alloc(32));
    expect(provider.seenKeys[0]).toEqual(Buffer.alloc(32));

    const canonicalState = JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      vaultId: expectedVaultId,
      keyId: first.opened.keyId,
      generation: 1,
    });
    expect(readFileSync(statePath(root), "utf8")).toBe(canonicalState);
    const beforeState = readFileSync(statePath(root));
    const beforeEnvelope = readFileSync(envelopePath(root));
    first.opened.vault.close();

    protector.shouldReEncrypt = true;
    const second = await openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector,
    });
    expect(second.rotationPending).toBe(true);
    expect(second.keyId).toBe(first.opened.keyId);
    expect(provider.modes).toEqual(["create-exclusive", "open-existing"]);
    expect(protector.seenUnprotectedKey).toEqual(Buffer.alloc(32));
    expect(readFileSync(statePath(root))).toEqual(beforeState);
    expect(readFileSync(envelopePath(root))).toEqual(beforeEnvelope);
    second.vault.close();
  });

  it("allows exactly one simultaneous first-run winner", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    let releaseProtect!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    protector.protectEntered = markEntered;
    protector.protectGate = new Promise<void>((resolve) => {
      releaseProtect = resolve;
    });

    const winner = openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector,
    });
    await entered;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "BUSY",
      [root],
    );
    releaseProtect();
    const opened = await winner;
    expect(provider.modes).toEqual(["create-exclusive"]);
    opened.vault.close();
  });

  it("defers one-shot operation getters until core reaches each security stage", async () => {
    const root = temporaryRoot();
    const baseProvider = new TestEncryptedProvider();
    const trace: string[] = [];
    let connectionReads = 0;
    let attestReads = 0;
    let inspectReads = 0;
    let attested = false;
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed(request) {
        const underlying = baseProvider.openKeyed(request);
        let session: EncryptedVaultCandidateSession;
        session = {
          get connection() {
            connectionReads += 1;
            trace.push("read-connection");
            if (connectionReads > 1) throw new Error("secret:second-connection-read");
            return underlying.connection;
          },
          get attestCipher() {
            attestReads += 1;
            trace.push("read-attest");
            if (attestReads > 1) throw new Error("secret:second-attest-read");
            return function (this: EncryptedVaultCandidateSession) {
              expect(this).toBe(session);
              trace.push("call-attest");
              const result = Reflect.apply(underlying.attestCipher, underlying, []);
              attested = true;
              return result;
            };
          },
          get inspectSchemaVersion() {
            inspectReads += 1;
            trace.push("read-inspect");
            if (!attested) throw new Error("secret:inspect-before-attestation");
            if (inspectReads > 1) throw new Error("secret:second-inspect-read");
            return function (this: EncryptedVaultCandidateSession) {
              expect(this).toBe(session);
              trace.push("call-inspect");
              return Reflect.apply(underlying.inspectSchemaVersion, underlying, []);
            };
          },
        };
        return session;
      },
    };

    const opened = await openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector: new TestProtector(),
    });
    expect(connectionReads).toBe(1);
    expect(attestReads).toBe(1);
    expect(inspectReads).toBe(1);
    expect(trace).toEqual([
      "read-connection",
      "read-attest",
      "call-attest",
      "read-inspect",
      "call-inspect",
    ]);
    opened.vault.close();
  });

  it("does not read operation getters when the captured connection is invalid", async () => {
    const root = temporaryRoot();
    let operationReads = 0;
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
          get attestCipher() {
            operationReads += 1;
            return () => ({ status: "active" as const });
          },
          get inspectSchemaVersion() {
            operationReads += 1;
            return () => 0;
          },
        } as unknown as EncryptedVaultCandidateSession;
      },
    };

    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: root,
        provider,
        protector: new TestProtector(),
      }),
      "VAULT_OPEN_FAILED",
    );
    expect(operationReads).toBe(0);
    expect(closes).toBe(1);
  });

  it("closes the captured connection when a delayed operation getter throws", async () => {
    const root = temporaryRoot();
    const baseProvider = new TestEncryptedProvider();
    let attestReads = 0;
    let inspectReads = 0;
    const provider: EncryptedVaultCandidateProvider = {
      descriptor: CANDIDATE_DESCRIPTOR,
      openKeyed(request) {
        const underlying = baseProvider.openKeyed(request);
        return {
          connection: underlying.connection,
          get attestCipher() {
            attestReads += 1;
            throw new Error("secret:attest-getter");
          },
          get inspectSchemaVersion() {
            inspectReads += 1;
            return underlying.inspectSchemaVersion;
          },
        } as unknown as EncryptedVaultCandidateSession;
      },
    };

    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: root,
        provider,
        protector: new TestProtector(),
      }),
      "VAULT_OPEN_FAILED",
      [root, "secret:attest-getter"],
    );
    expect(attestReads).toBe(1);
    expect(inspectReads).toBe(0);
    expect(baseProvider.closeCount).toBe(1);
  });

  it("recovers a creating journal interrupted before the envelope", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    protector.available = false;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "KEY_ENVELOPE_FAILED",
    );
    expect(readdirSync(root)).toEqual([WINDOWS_VAULT_STATE_FILE_NAME]);
    expect(readState(root).status).toBe("creating");

    protector.available = true;
    const recovered = await openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector,
    });
    expect(provider.modes).toEqual(["create-exclusive"]);
    expect(readState(root).status).toBe("ready");
    recovered.vault.close();
  });

  it("recovers an envelope-only creating state after keyed open failed", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider({ failOpen: true });
    const protector = new TestProtector();
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "VAULT_OPEN_FAILED",
    );
    expect(existsSync(envelopePath(root))).toBe(true);
    expect(existsSync(databasePath(root))).toBe(false);
    expect(readState(root).status).toBe("creating");

    provider.failOpen = false;
    const recovered = await openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector,
    });
    expect(provider.modes).toEqual(["create-exclusive", "create-exclusive"]);
    expect(readState(root).status).toBe("ready");
    recovered.vault.close();
  });

  it("recovers a keyed database interrupted before identity creation", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider({ failIdentityCreateOnce: true });
    const protector = new TestProtector();
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "IDENTITY_INVALID",
    );
    expect(existsSync(databasePath(root))).toBe(true);
    expect(identityExists(root)).toBe(false);
    expect(provider.closeCount).toBe(1);
    expect(readState(root).status).toBe("creating");

    const recovered = await openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector,
    });
    expect(provider.modes).toEqual(["create-exclusive", "open-existing"]);
    expect(identityExists(root)).toBe(true);
    recovered.vault.close();
  });

  it("recovers a creating state interrupted after the identity commit", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider({ failIdentityVerifyOnce: true });
    const protector = new TestProtector();
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "IDENTITY_INVALID",
    );
    expect(identityExists(root)).toBe(true);
    expect(provider.closeCount).toBe(1);
    expect(readState(root).status).toBe("creating");

    const recovered = await openWindowsEncryptedVaultCandidate({
      rootPath: root,
      provider,
      protector,
    });
    expect(provider.modes).toEqual(["create-exclusive", "open-existing"]);
    expect(readState(root).status).toBe("ready");
    recovered.vault.close();
  });

  it.each([
    { missing: "database" as const, expectedRemaining: "envelope" },
    { missing: "envelope" as const, expectedRemaining: "database" },
  ])("fails closed for a ready state with only $expectedRemaining", async ({ missing }) => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    const created = await successfullyCreate(root, provider, protector);
    created.opened.vault.close();
    const stateBefore = readFileSync(statePath(root));
    const target = missing === "database" ? databasePath(root) : envelopePath(root);
    unlinkSync(target);
    const remainingPath = missing === "database" ? envelopePath(root) : databasePath(root);
    const remainingBefore = readFileSync(remainingPath);

    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "INVENTORY_CONFLICT",
    );
    expect(readFileSync(statePath(root))).toEqual(stateBefore);
    expect(readFileSync(remainingPath)).toEqual(remainingBefore);
  });

  it("rejects state tampering and oversize journals before key or provider access", async () => {
    const cases: Array<{ bytes: Buffer; code: WindowsVaultKeyManagerErrorCode }> = [];
    const rootForId = temporaryRoot();
    const vaultId = deriveWindowsVaultId(rootForId);
    const canonicalCreating = {
      schemaVersion: 1,
      status: "creating",
      vaultId,
      generation: 1,
    };
    cases.push(
      {
        bytes: Buffer.from(JSON.stringify({ ...canonicalCreating, extra: true })),
        code: "STATE_INVALID",
      },
      {
        bytes: Buffer.from(JSON.stringify({ ...canonicalCreating, status: "unknown" })),
        code: "STATE_INVALID",
      },
      {
        bytes: Buffer.from(JSON.stringify({ ...canonicalCreating, vaultId: "ff".repeat(32) })),
        code: "STATE_INVALID",
      },
      {
        bytes: Buffer.alloc(MAX_WINDOWS_VAULT_STATE_BYTES + 1, 0x61),
        code: "STATE_OVERSIZE",
      },
    );

    for (const [index, testCase] of cases.entries()) {
      const root = index === 0 ? rootForId : temporaryRoot();
      const state = index === 0
        ? testCase.bytes
        : testCase.code === "STATE_OVERSIZE"
          ? testCase.bytes
          : Buffer.from(testCase.bytes.toString("utf8").replace(vaultId, deriveWindowsVaultId(root)));
      writeFileSync(statePath(root), state);
      const provider = new TestEncryptedProvider();
      const protector = new TestProtector();
      await expectManagerError(
        () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
        testCase.code,
      );
      expect(provider.openCount).toBe(0);
      expect(protector.protectCalls + protector.unprotectCalls).toBe(0);
    }
  });

  it("rejects mismatched ready key and encrypted identity without repair", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    const created = await successfullyCreate(root, provider, protector);
    created.opened.vault.close();
    const original = readState(root);
    writeFileSync(statePath(root), JSON.stringify({ ...original, keyId: "ee".repeat(32) }));
    const envelopeBefore = readFileSync(envelopePath(root));
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "IDENTITY_INVALID",
    );
    expect(readFileSync(envelopePath(root))).toEqual(envelopeBefore);

    writeFileSync(statePath(root), JSON.stringify(original));
    const development = createNodeSqliteDevelopmentStorageProvider();
    const connection = development.open(databasePath(root));
    connection.prepare(`
      UPDATE __owncontext_vault_identity SET vault_id = ? WHERE singleton = 1
    `).run("dd".repeat(32));
    connection.close();
    const closesBefore = provider.closeCount;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "IDENTITY_INVALID",
    );
    expect(provider.closeCount).toBe(closesBefore + 1);
  });

  it("maps unwrap, provider, and wrong-key failures to stable content-free codes", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    const created = await successfullyCreate(root, provider, protector);
    created.opened.vault.close();
    const forbidden = [root, "secret:", readState(root).keyId as string];

    protector.failUnprotect = true;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "KEY_ENVELOPE_FAILED",
      forbidden,
    );
    protector.failUnprotect = false;
    provider.failOpen = true;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "VAULT_OPEN_FAILED",
      forbidden,
    );
    provider.failOpen = false;
    provider.wrongKey = true;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({ rootPath: root, provider, protector }),
      "VAULT_OPEN_FAILED",
      forbidden,
    );

    const invalidRoot = temporaryRoot();
    const invalidProvider = {
      descriptor: { ...CANDIDATE_DESCRIPTOR, securityProfile: "plaintext-development" },
      openKeyed() {
        throw new Error("secret:must-not-open");
      },
    } as unknown as EncryptedVaultCandidateProvider;
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: invalidRoot,
        provider: invalidProvider,
        protector: new TestProtector(),
      }),
      "INVALID_PROVIDER",
      [invalidRoot, "secret:"],
    );
    expect(readdirSync(invalidRoot)).toEqual([]);
  });

  it("keeps distinct NFC and NFD directories separate while folding case aliases", () => {
    const parent = temporaryRoot();
    const nfcRoot = join(parent, "caf\u00e9");
    const nfdRoot = join(parent, "cafe\u0301");
    mkdirSync(nfcRoot);
    mkdirSync(nfdRoot);

    const nfcId = deriveWindowsVaultId(nfcRoot);
    const nfdId = deriveWindowsVaultId(nfdRoot);
    expect(nfcId).toMatch(/^[0-9a-f]{64}$/u);
    expect(nfdId).toMatch(/^[0-9a-f]{64}$/u);
    expect(nfcId).not.toBe(nfdId);
    expect(deriveWindowsVaultId(nfcRoot.toUpperCase())).toBe(nfcId);
    expect(deriveWindowsVaultId(nfdRoot.toUpperCase())).toBe(nfdId);
  });

  it("rejects relative, directly linked, and junction-ancestor roots", async () => {
    const root = temporaryRoot();
    const provider = new TestEncryptedProvider();
    const protector = new TestProtector();
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: "relative-vault-root",
        provider,
        protector,
      }),
      "INVALID_ROOT",
    );
    expect(readdirSync(root)).toEqual([]);

    const parent = temporaryRoot();
    const target = temporaryRoot();
    const linkedRoot = join(parent, "linked-root");
    symlinkSync(target, linkedRoot, "junction");
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: linkedRoot,
        provider,
        protector,
      }),
      "INVALID_ROOT",
      [linkedRoot],
    );
    expect(readdirSync(target)).toEqual([]);

    const targetTree = temporaryRoot();
    const targetLeaf = join(targetTree, "vault-leaf");
    mkdirSync(targetLeaf);
    const ancestorJunction = join(parent, "ancestor-junction");
    symlinkSync(targetTree, ancestorJunction, "junction");
    const descendantThroughJunction = join(ancestorJunction, "vault-leaf");
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: descendantThroughJunction,
        provider,
        protector,
      }),
      "INVALID_ROOT",
      [descendantThroughJunction],
    );
    expect(readdirSync(targetLeaf)).toEqual([]);
  });

  it.each([
    WINDOWS_LEGACY_PLAINTEXT_MARKER_FILE_NAME,
    "unknown-entry.bin",
  ])("fails without mutation when exact inventory contains %s", async (name) => {
    const root = temporaryRoot();
    const existingPath = join(root, name);
    const original = Buffer.from("do-not-overwrite");
    writeFileSync(existingPath, original);
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: root,
        provider: new TestEncryptedProvider(),
        protector: new TestProtector(),
      }),
      "INVENTORY_CONFLICT",
    );
    expect(readdirSync(root)).toEqual([name]);
    expect(readFileSync(existingPath)).toEqual(original);
  });

  it("rejects DB-only and envelope-only inventories without fallback or overwrite", async () => {
    const dbOnlyRoot = temporaryRoot();
    const dbBytes = Buffer.from("legacy-or-unmanaged-database");
    writeFileSync(databasePath(dbOnlyRoot), dbBytes);
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: dbOnlyRoot,
        provider: new TestEncryptedProvider(),
        protector: new TestProtector(),
      }),
      "INVENTORY_CONFLICT",
    );
    expect(readFileSync(databasePath(dbOnlyRoot))).toEqual(dbBytes);
    expect(existsSync(statePath(dbOnlyRoot))).toBe(false);
    expect(existsSync(envelopePath(dbOnlyRoot))).toBe(false);

    const envelopeOnlyRoot = temporaryRoot();
    const envelopeOnlyProtector = new TestProtector();
    await createVaultKeyEnvelope(
      {
        envelopePath: envelopePath(envelopeOnlyRoot),
        vaultId: deriveWindowsVaultId(envelopeOnlyRoot),
        protector: envelopeOnlyProtector,
      },
      () => undefined,
    );
    const envelopeBefore = readFileSync(envelopePath(envelopeOnlyRoot));
    await expectManagerError(
      () => openWindowsEncryptedVaultCandidate({
        rootPath: envelopeOnlyRoot,
        provider: new TestEncryptedProvider(),
        protector: envelopeOnlyProtector,
      }),
      "INVENTORY_CONFLICT",
    );
    expect(readFileSync(envelopePath(envelopeOnlyRoot))).toEqual(envelopeBefore);
    expect(existsSync(statePath(envelopeOnlyRoot))).toBe(false);
    expect(existsSync(databasePath(envelopeOnlyRoot))).toBe(false);
  });
});
