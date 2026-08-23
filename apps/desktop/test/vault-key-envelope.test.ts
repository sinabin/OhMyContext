import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ElectronSafeStorageKeyProtector,
  MAX_VAULT_KEY_ENVELOPE_BYTES,
  VAULT_KEY_PROVIDER_ID,
  VaultKeyEnvelopeError,
  VaultKeyProtector,
  createVaultKeyEnvelope,
  withVaultKeyFromEnvelope,
  type SafeStorageLike,
  type UnprotectedVaultKey,
} from "../src/electron/vault-key-envelope.js";

const VAULT_ID = "11".repeat(32);
const CREATED_AT = new Date("2026-08-23T12:34:56.789Z");
const createdDirectories: string[] = [];

class FakeProtector extends VaultKeyProtector {
  readonly providerId = VAULT_KEY_PROVIDER_ID;
  available = true;
  failProtect = false;
  failUnprotect = false;
  shouldReEncrypt = false;
  protectedKey?: Buffer;
  seenProtectKey?: Buffer;
  unprotectedKey?: Buffer;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async protect(key: Buffer): Promise<Buffer> {
    this.seenProtectKey = key;
    if (this.failProtect) throw new Error(`secret:${key.toString("hex")}`);
    this.protectedKey = Buffer.from(key);
    return Buffer.concat([Buffer.from("wrapped:"), key]);
  }

  async unprotect(wrappedKey: Buffer): Promise<UnprotectedVaultKey> {
    if (this.failUnprotect) throw new Error(`secret:${wrappedKey.toString("hex")}`);
    this.unprotectedKey = Buffer.from(wrappedKey.subarray("wrapped:".length));
    return { key: this.unprotectedKey, shouldReEncrypt: this.shouldReEncrypt };
  }
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best-effort test cleanup preparation only.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixturePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "owncontext-key-envelope-"));
  createdDirectories.push(directory);
  return join(directory, "vault.key.json");
}

function deterministicRandom(): (size: number) => Buffer {
  let call = 0;
  return (size) => Buffer.alloc(size, ++call);
}

async function createFixture(path: string, protector = new FakeProtector()): Promise<FakeProtector> {
  await createVaultKeyEnvelope(
    {
      envelopePath: path,
      vaultId: VAULT_ID,
      protector,
      now: () => CREATED_AT,
      randomBytes: deterministicRandom(),
    },
    () => undefined,
  );
  return protector;
}

function expectCode(error: unknown, code: VaultKeyEnvelopeError["code"]): void {
  expect(error).toBeInstanceOf(VaultKeyEnvelopeError);
  expect((error as VaultKeyEnvelopeError).code).toBe(code);
  expect((error as Error).message).not.toMatch(/11{8}|secret:|vault\.key|wrapped:/iu);
}

describe("vault key envelope", () => {
  it("creates a strict canonical v1 envelope and zeroizes the callback key", async () => {
    const path = fixturePath();
    const protector = new FakeProtector();
    let callbackKey: Buffer | undefined;

    const result = await createVaultKeyEnvelope(
      {
        envelopePath: path,
        vaultId: VAULT_ID,
        protector,
        now: () => CREATED_AT,
        randomBytes: deterministicRandom(),
      },
      async ({ key, keyId }) => {
        callbackKey = key;
        expect(key).toEqual(Buffer.alloc(32, 1));
        expect(keyId).toBe("02".repeat(32));
        await Promise.resolve();
        return "opened";
      },
    );

    expect(result).toEqual({ keyId: "02".repeat(32), value: "opened" });
    expect(callbackKey).toEqual(Buffer.alloc(32));
    expect(protector.protectedKey).toEqual(Buffer.alloc(32, 1));
    expect(readFileSync(path, "utf8")).toBe(
      JSON.stringify({
        schemaVersion: 1,
        vaultId: VAULT_ID,
        keyId: "02".repeat(32),
        provider: VAULT_KEY_PROVIDER_ID,
        wrappedKey: Buffer.concat([Buffer.from("wrapped:"), Buffer.alloc(32, 1)]).toString("base64"),
        createdAt: CREATED_AT.toISOString(),
      }),
    );
  });

  it("opens only through a callback, reports re-encryption, and never rewrites", async () => {
    const path = fixturePath();
    const protector = await createFixture(path);
    protector.shouldReEncrypt = true;
    const before = readFileSync(path);
    let callbackKey: Buffer | undefined;

    const result = await withVaultKeyFromEnvelope(
      { envelopePath: path, vaultId: VAULT_ID, protector },
      async ({ key, keyId }) => {
        callbackKey = key;
        expect(key).toEqual(Buffer.alloc(32, 1));
        expect(keyId).toBe("02".repeat(32));
        return 42;
      },
    );

    expect(result).toEqual({
      createdAt: CREATED_AT.toISOString(),
      keyId: "02".repeat(32),
      shouldReEncrypt: true,
      value: 42,
    });
    expect(callbackKey).toEqual(Buffer.alloc(32));
    expect(protector.unprotectedKey).toEqual(Buffer.alloc(32));
    expect(readFileSync(path)).toEqual(before);
  });

  it("zeroizes keys when async callbacks reject", async () => {
    const createPath = fixturePath();
    let createdKey: Buffer | undefined;
    await expect(
      createVaultKeyEnvelope(
        {
          envelopePath: createPath,
          vaultId: VAULT_ID,
          protector: new FakeProtector(),
          randomBytes: deterministicRandom(),
        },
        async ({ key }) => {
          createdKey = key;
          throw new Error("callback failed");
        },
      ),
    ).rejects.toThrow("callback failed");
    expect(createdKey).toEqual(Buffer.alloc(32));

    // Persistence precedes key use. A consumer failure must not delete the
    // only wrapped key or leave later code free to create a replacement vault.
    expect(() => JSON.parse(readFileSync(createPath, "utf8"))).not.toThrow();

    const protector = new FakeProtector();
    let openedKey: Buffer | undefined;
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: createPath, vaultId: VAULT_ID, protector },
        async ({ key }) => {
          openedKey = key;
          throw new Error("callback failed");
        },
      ),
    ).rejects.toThrow("callback failed");
    expect(openedKey).toEqual(Buffer.alloc(32));
    expect(protector.unprotectedKey).toEqual(Buffer.alloc(32));
  });

  it("refuses to overwrite an existing canonical envelope", async () => {
    const path = fixturePath();
    await createFixture(path);
    const before = readFileSync(path);

    await expect(
      createVaultKeyEnvelope(
        {
          envelopePath: path,
          vaultId: VAULT_ID,
          protector: new FakeProtector(),
          randomBytes: deterministicRandom(),
        },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "ALREADY_EXISTS");
      return true;
    });
    expect(readFileSync(path)).toEqual(before);
  });

  it("publishes exclusively when two creators race", async () => {
    const path = fixturePath();
    let callbackCount = 0;
    const create = () => createVaultKeyEnvelope(
      {
        envelopePath: path,
        vaultId: VAULT_ID,
        protector: new FakeProtector(),
        now: () => CREATED_AT,
        randomBytes: deterministicRandom(),
      },
      () => ++callbackCount,
    );

    const outcomes = await Promise.allSettled([create(), create()]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expectCode(rejected.reason, "ALREADY_EXISTS");
    expect(callbackCount).toBe(1);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  it.each([
    ["non-JSON", "not-json"],
    ["non-canonical whitespace", JSON.stringify({
      schemaVersion: 1,
      vaultId: VAULT_ID,
      keyId: "22".repeat(32),
      provider: VAULT_KEY_PROVIDER_ID,
      wrappedKey: "YQ==",
      createdAt: CREATED_AT.toISOString(),
    }, undefined, 2)],
    ["non-canonical base64", JSON.stringify({
      schemaVersion: 1,
      vaultId: VAULT_ID,
      keyId: "22".repeat(32),
      provider: VAULT_KEY_PROVIDER_ID,
      wrappedKey: "YR==",
      createdAt: CREATED_AT.toISOString(),
    })],
    ["extra member", JSON.stringify({
      schemaVersion: 1,
      vaultId: VAULT_ID,
      keyId: "22".repeat(32),
      provider: VAULT_KEY_PROVIDER_ID,
      wrappedKey: "YQ==",
      createdAt: CREATED_AT.toISOString(),
      extra: true,
    })],
  ])("rejects corrupt input: %s", async (_name, contents) => {
    const path = fixturePath();
    writeFileSync(path, contents);
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: path, vaultId: VAULT_ID, protector: new FakeProtector() },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "CORRUPT");
      return true;
    });
  });

  it.each([
    ["schema", { schemaVersion: 2 }],
    ["provider", { provider: "some-other-provider" }],
  ])("rejects an unknown %s without unprotecting", async (_name, change) => {
    const path = fixturePath();
    const canonical = {
      schemaVersion: 1,
      vaultId: VAULT_ID,
      keyId: "22".repeat(32),
      provider: VAULT_KEY_PROVIDER_ID,
      wrappedKey: "YQ==",
      createdAt: CREATED_AT.toISOString(),
      ...change,
    };
    writeFileSync(path, JSON.stringify(canonical));
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: path, vaultId: VAULT_ID, protector: new FakeProtector() },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "UNKNOWN_ENVELOPE");
      return true;
    });
  });

  it("bounds reads before parsing", async () => {
    const path = fixturePath();
    writeFileSync(path, Buffer.alloc(MAX_VAULT_KEY_ENVELOPE_BYTES + 1, 0x61));
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: path, vaultId: VAULT_ID, protector: new FakeProtector() },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "OVERSIZE");
      return true;
    });
  });

  it("fails closed for missing, directory, and symlink targets", async () => {
    const missing = fixturePath();
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: missing, vaultId: VAULT_ID, protector: new FakeProtector() },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "MISSING");
      return true;
    });

    const directoryTarget = fixturePath();
    mkdirSync(directoryTarget);
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: directoryTarget, vaultId: VAULT_ID, protector: new FakeProtector() },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "CORRUPT");
      return true;
    });

    const source = fixturePath();
    await createFixture(source);
    const symlink = fixturePath();
    symlinkSync(dirname(source), symlink, process.platform === "win32" ? "junction" : "dir");
    await expect(
      withVaultKeyFromEnvelope(
        {
          envelopePath: join(symlink, "vault.key.json"),
          vaultId: VAULT_ID,
          protector: new FakeProtector(),
        },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "CORRUPT");
      return true;
    });
  });

  it("fails closed with content-free unavailable/protect/unprotect errors", async () => {
    const unavailablePath = fixturePath();
    const unavailable = new FakeProtector();
    unavailable.available = false;
    await expect(
      createVaultKeyEnvelope(
        {
          envelopePath: unavailablePath,
          vaultId: VAULT_ID,
          protector: unavailable,
          randomBytes: deterministicRandom(),
        },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "PROTECTOR_UNAVAILABLE");
      return true;
    });

    const protectPath = fixturePath();
    const protectFailure = new FakeProtector();
    protectFailure.failProtect = true;
    await expect(
      createVaultKeyEnvelope(
        {
          envelopePath: protectPath,
          vaultId: VAULT_ID,
          protector: protectFailure,
          randomBytes: deterministicRandom(),
        },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "PROTECT_FAILED");
      return true;
    });
    expect(protectFailure.seenProtectKey).toEqual(Buffer.alloc(32));

    const unprotectPath = fixturePath();
    const unprotectFailure = await createFixture(unprotectPath);
    unprotectFailure.failUnprotect = true;
    await expect(
      withVaultKeyFromEnvelope(
        { envelopePath: unprotectPath, vaultId: VAULT_ID, protector: unprotectFailure },
        () => undefined,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, "UNPROTECT_FAILED");
      return true;
    });
  });
});

describe("Electron safeStorage adapter", () => {
  it("uses only async APIs and preserves shouldReEncrypt", async () => {
    const calls: string[] = [];
    const safeStorage: SafeStorageLike = {
      async isAsyncEncryptionAvailable() {
        calls.push("available");
        return true;
      },
      async encryptStringAsync(value) {
        calls.push(`encrypt:${value}`);
        return Buffer.from(value, "utf8");
      },
      async decryptStringAsync(value) {
        calls.push(`decrypt:${value.toString("utf8")}`);
        return { result: Buffer.alloc(32, 7).toString("base64"), shouldReEncrypt: true };
      },
    };
    const adapter = new ElectronSafeStorageKeyProtector(safeStorage);

    expect(await adapter.isAvailable()).toBe(true);
    const wrapped = await adapter.protect(Buffer.alloc(32, 7));
    const unprotected = await adapter.unprotect(wrapped);
    expect(unprotected).toEqual({ key: Buffer.alloc(32, 7), shouldReEncrypt: true });
    expect(calls).toEqual([
      "available",
      `encrypt:${Buffer.alloc(32, 7).toString("base64")}`,
      `decrypt:${Buffer.alloc(32, 7).toString("base64")}`,
    ]);
    unprotected.key.fill(0);
  });
});
