import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KeyStorageSmokeError,
  prepareKeyStorageSmoke,
  runKeyStorageSmoke,
} from "../src/electron/key-storage-smoke.js";
import type { SafeStorageLike } from "../src/electron/vault-key-envelope.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "owncontext-key-storage-smoke-"));
  roots.push(root);
  return root;
}

function preparation(root: string, nonce = randomUUID()) {
  return prepareKeyStorageSmoke({
    argv: ["OwnContext.exe", "--owncontext-key-storage-smoke"],
    environment: {
      OWNCONTEXT_KEY_STORAGE_SMOKE_ROOT: root,
      OWNCONTEXT_KEY_STORAGE_SMOKE_NONCE: nonce,
    },
    platform: "win32",
    architecture: "x64",
    temporaryDirectory: tmpdir(),
  });
}

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    async isAsyncEncryptionAvailable() {
      return available;
    },
    async encryptStringAsync(plainText) {
      const source = Buffer.from(plainText, "utf8");
      const encrypted = Buffer.alloc(source.byteLength);
      for (let index = 0; index < source.byteLength; index += 1) {
        encrypted[index] = (source[index] ?? 0) ^ 0xa5;
      }
      return encrypted;
    },
    async decryptStringAsync(encrypted) {
      const decrypted = Buffer.alloc(encrypted.byteLength);
      for (let index = 0; index < encrypted.byteLength; index += 1) {
        decrypted[index] = (encrypted[index] ?? 0) ^ 0xa5;
      }
      const result = decrypted.toString("utf8");
      return { result, shouldReEncrypt: true };
    },
  };
}

function noOpSafeStorage(): SafeStorageLike {
  return {
    async isAsyncEncryptionAvailable() {
      return true;
    },
    async encryptStringAsync(plainText) {
      return Buffer.from(plainText, "utf8");
    },
    async decryptStringAsync(encrypted) {
      return { result: encrypted.toString("utf8"), shouldReEncrypt: false };
    },
  };
}

function utf16NoOpSafeStorage(): SafeStorageLike {
  return {
    async isAsyncEncryptionAvailable() {
      return true;
    },
    async encryptStringAsync(plainText) {
      return Buffer.from(plainText, "utf16le");
    },
    async decryptStringAsync(encrypted) {
      return { result: encrypted.toString("utf16le"), shouldReEncrypt: false };
    },
  };
}

describe("packaged Windows key-storage smoke", () => {
  it("is dormant unless the dedicated argument is present", () => {
    expect(prepareKeyStorageSmoke({
      argv: ["OwnContext.exe"],
      environment: {},
      platform: "win32",
      architecture: "x64",
    })).toBeNull();
  });

  it("rejects invocations outside the bounded Windows x64 temporary root", () => {
    const root = temporaryRoot();
    for (const change of [
      { platform: "linux" as const },
      { architecture: "arm64" },
      { nonce: "not-a-nonce" },
      { requestedRoot: "relative-root" },
    ]) {
      expect(() => prepareKeyStorageSmoke({
        argv: ["OwnContext.exe", "--owncontext-key-storage-smoke"],
        environment: {
          OWNCONTEXT_KEY_STORAGE_SMOKE_ROOT: change.requestedRoot ?? root,
          OWNCONTEXT_KEY_STORAGE_SMOKE_NONCE: change.nonce ?? randomUUID(),
        },
        platform: change.platform ?? "win32",
        architecture: change.architecture ?? "x64",
        temporaryDirectory: tmpdir(),
      })).toThrow(KeyStorageSmokeError);
    }
  });

  it("round-trips a random key without writing plaintext or key material to evidence", async () => {
    const root = temporaryRoot();
    const nonce = randomUUID();
    const context = preparation(root, nonce);
    if (!context) throw new Error("Expected smoke context.");

    const result = await runKeyStorageSmoke(context, fakeSafeStorage(), true);
    expect(result).toEqual({
      schemaVersion: 2,
      status: "windows-key-envelope-round-trip-complete",
      nonce,
      platform: "win32",
      architecture: "x64",
      isPackaged: true,
      providerId: "electron-safe-storage",
      safeStorageAsyncAvailable: true,
      keyBytes: 32,
      envelopeSchemaVersion: 1,
      envelopePersisted: true,
      knownPlaintextEncodingsAbsent: true,
      roundTripMatched: true,
      shouldReEncrypt: true,
    });
    expect(JSON.parse(readFileSync(context.resultPath, "utf8"))).toEqual(result);
    const envelope = readFileSync(context.envelopePath, "utf8");
    expect(envelope).not.toContain(nonce);
    expect(envelope).not.toMatch(/plaintext|sha256|digest/iu);
  });

  it("fails closed without creating success evidence when safeStorage is unavailable", async () => {
    const root = temporaryRoot();
    const context = preparation(root);
    if (!context) throw new Error("Expected smoke context.");

    await expect(
      runKeyStorageSmoke(context, fakeSafeStorage(false), true),
    ).rejects.toThrow(KeyStorageSmokeError);
    expect(existsSync(context.resultPath)).toBe(false);
  });

  it("rejects a no-op wrapper whose outer base64 hides recoverable key bytes", async () => {
    const root = temporaryRoot();
    const context = preparation(root);
    if (!context) throw new Error("Expected smoke context.");

    await expect(
      runKeyStorageSmoke(context, noOpSafeStorage(), true),
    ).rejects.toThrow(KeyStorageSmokeError);
    expect(existsSync(context.resultPath)).toBe(false);
  });

  it("rejects a no-op wrapper that stores the key string as UTF-16 plaintext", async () => {
    const root = temporaryRoot();
    const context = preparation(root);
    if (!context) throw new Error("Expected smoke context.");

    await expect(
      runKeyStorageSmoke(context, utf16NoOpSafeStorage(), true),
    ).rejects.toThrow(KeyStorageSmokeError);
    expect(existsSync(context.resultPath)).toBe(false);
  });
});
