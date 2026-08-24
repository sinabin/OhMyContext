import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { ENCRYPTED_SQLITE_ENGINE_IDENTITY } from
  "../src/electron/encrypted-sqlite-provider.js";
import {
  ENCRYPTED_VAULT_SMOKE_ARGUMENT,
  ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE,
  ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES,
  ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME,
  ENCRYPTED_VAULT_SMOKE_PROVIDER_ID,
  ENCRYPTED_VAULT_SMOKE_RELEASE_BOUNDARY,
  ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME,
  ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME,
  ENCRYPTED_VAULT_SMOKE_STATUS,
  EncryptedVaultSmokeError,
  isEncryptedVaultSmokeResult,
  prepareEncryptedVaultSmoke,
  runEncryptedVaultSmoke,
  type EncryptedVaultSmokeContext,
} from "../src/electron/encrypted-vault-smoke.js";
import {
  VAULT_KEY_PROVIDER_ID,
  type SafeStorageLike,
} from "../src/electron/vault-key-envelope.js";
import {
  WINDOWS_ENCRYPTED_VAULT_FILE_NAME,
  WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME,
  WINDOWS_VAULT_STATE_FILE_NAME,
} from "../src/electron/vault-key-manager.js";

const smokeRoots: string[] = [];
let stagedResourcesRoot: string | undefined;

beforeAll(() => {
  if (process.platform !== "win32" || process.arch !== "x64") return;
  const stagingRoot = mkdtempSync(join(tmpdir(), "owncontext-smoke-runtime-"));
  stagedResourcesRoot = stagingRoot;
  const runtimeLibrary = join(
    stagingRoot,
    "encrypted-sqlite-runtime",
    "lib",
  );
  mkdirSync(runtimeLibrary, { recursive: true });

  // The test entry delegates to the installed win32-x64 package entry so the
  // actual native engine is exercised without copying a loaded .node file that
  // Windows would keep locked. This test-only wrapper is not packaged evidence.
  const requireFromTest = createRequire(import.meta.url);
  const installedEntry = requireFromTest.resolve(
    "better-sqlite3-multiple-ciphers/win32-x64",
  );
  writeFileSync(
    join(runtimeLibrary, "win32-x64.js"),
    `'use strict';\nmodule.exports = require(${JSON.stringify(installedEntry)});\n`,
    { encoding: "utf8", flag: "wx" },
  );
});

afterEach(() => {
  for (const root of smokeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (stagedResourcesRoot) {
    rmSync(stagedResourcesRoot, { recursive: true, force: true });
    stagedResourcesRoot = undefined;
  }
});

function temporaryRoot(prefix = "owncontext-encrypted-vault-smoke-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  smokeRoots.push(root);
  return root;
}

function preparation(
  root: string,
  nonce = randomUUID(),
): EncryptedVaultSmokeContext {
  const context = prepareEncryptedVaultSmoke({
    argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
    environment: {
      [ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME]: root,
      [ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME]: nonce,
    },
    platform: "win32",
    architecture: "x64",
    temporaryDirectory: tmpdir(),
  });
  if (!context) throw new Error("Expected encrypted-vault smoke context.");
  return context;
}

interface ReversibleSafeStorageOptions {
  readonly availability?: (call: number) => boolean;
  readonly onAvailability?: (call: number) => void;
  readonly onDecrypt?: () => void;
}

function reversibleTestSafeStorage(
  options: ReversibleSafeStorageOptions = {},
): SafeStorageLike & { readonly availabilityCalls: number } {
  let availabilityCalls = 0;
  const fake = {
    get availabilityCalls() {
      return availabilityCalls;
    },
    async isAsyncEncryptionAvailable() {
      availabilityCalls += 1;
      options.onAvailability?.(availabilityCalls);
      return options.availability?.(availabilityCalls) ?? true;
    },
    async encryptStringAsync(plainText: string) {
      const source = Buffer.from(plainText, "utf8");
      const encrypted = Buffer.allocUnsafe(source.byteLength + 4);
      encrypted.set([0x4f, 0x43, 0x54, 0x53]);
      for (let index = 0; index < source.byteLength; index += 1) {
        encrypted[index + 4] = (source[source.byteLength - 1 - index] ?? 0) ^ 0xa5;
      }
      source.fill(0);
      return encrypted;
    },
    async decryptStringAsync(encrypted: Buffer) {
      options.onDecrypt?.();
      if (
        encrypted.byteLength < 5 ||
        encrypted[0] !== 0x4f ||
        encrypted[1] !== 0x43 ||
        encrypted[2] !== 0x54 ||
        encrypted[3] !== 0x53
      ) {
        throw new Error("Invalid test ciphertext.");
      }
      const decrypted = Buffer.allocUnsafe(encrypted.byteLength - 4);
      for (let index = 0; index < decrypted.byteLength; index += 1) {
        decrypted[index] =
          (encrypted[encrypted.byteLength - 1 - index] ?? 0) ^ 0xa5;
      }
      const result = decrypted.toString("utf8");
      decrypted.fill(0);
      return { result, shouldReEncrypt: false };
    },
  };
  return fake;
}

function resourcesPath(): string {
  if (!stagedResourcesRoot) throw new Error("Native test runtime was not staged.");
  return stagedResourcesRoot;
}

function expectFixedFailure(error: unknown, context?: EncryptedVaultSmokeContext): void {
  expect(error).toBeInstanceOf(EncryptedVaultSmokeError);
  expect((error as Error).message).toBe(
    "OhMyContext packaged encrypted-vault verification failed.",
  );
  if (context) {
    expect(String(error)).not.toContain(context.rootPath);
    expect(String(error)).not.toContain(context.nonce);
    expect(existsSync(context.resultPath)).toBe(false);
  }
}

function readSmokeCanary(context: EncryptedVaultSmokeContext): string {
  const fixture = readFileSync(context.fixturePath, "utf8");
  const match = fixture.match(/owncontextencryptedvaultsmoke[0-9a-f]{64}/u);
  if (!match) throw new Error("Smoke canary was not written.");
  return match[0];
}

const plaintextEncodings = [
  {
    name: "UTF-8",
    encode: (value: string) => Buffer.from(value, "utf8"),
  },
  {
    name: "UTF-16LE",
    encode: (value: string) => Buffer.from(value, "utf16le"),
  },
  {
    name: "UTF-16BE",
    encode: (value: string) => Buffer.from(value, "utf16le").swap16(),
  },
  {
    name: "UTF-32LE",
    encode: (value: string) => encodeUtf32(value, "little"),
  },
  {
    name: "UTF-32BE",
    encode: (value: string) => encodeUtf32(value, "big"),
  },
] as const;

function encodeUtf32(value: string, byteOrder: "little" | "big"): Buffer {
  const bytes = Buffer.allocUnsafe(value.length * 4);
  for (let index = 0; index < value.length; index += 1) {
    if (byteOrder === "little") {
      bytes.writeUInt32LE(value.charCodeAt(index), index * 4);
    } else {
      bytes.writeUInt32BE(value.charCodeAt(index), index * 4);
    }
  }
  return bytes;
}

describe("packaged Windows encrypted-vault smoke preparation", () => {
  it("is dormant without the exact dedicated argument", () => {
    expect(prepareEncryptedVaultSmoke({
      argv: ["OwnContext.exe"],
      environment: {},
      platform: "linux",
      architecture: "arm64",
    })).toBeNull();
  });

  it("creates separated userData, vault, fixture, and evidence boundaries", () => {
    const root = temporaryRoot();
    const context = preparation(root);
    expect(context.userDataPath).toBe(join(root, "electron-user-data"));
    expect(context.vaultDirectoryPath).toBe(join(root, "encrypted-vault"));
    expect(context.fixtureDirectoryPath).toBe(join(root, "fixture-source"));
    expect(context.fixturePath).toBe(
      join(root, "fixture-source", "encrypted-vault-smoke.md"),
    );
    expect(context.resultPath).toBe(join(root, ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME));
    expect(new Set([
      context.userDataPath,
      context.vaultDirectoryPath,
      context.fixtureDirectoryPath,
      context.resultPath,
    ]).size).toBe(4);
    expect(existsSync(context.userDataPath)).toBe(true);
    expect(existsSync(context.vaultDirectoryPath)).toBe(false);
    expect(existsSync(context.fixtureDirectoryPath)).toBe(false);
  });

  it("rejects duplicate, non-Windows-x64, invalid UUID, and non-canonical roots", () => {
    const cases = [
      {
        root: temporaryRoot(),
        argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT, ENCRYPTED_VAULT_SMOKE_ARGUMENT],
        nonce: randomUUID(),
        platform: "win32" as NodeJS.Platform,
        architecture: "x64",
      },
      {
        root: temporaryRoot(),
        argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
        nonce: randomUUID(),
        platform: "linux" as NodeJS.Platform,
        architecture: "x64",
      },
      {
        root: temporaryRoot(),
        argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
        nonce: "00000000-0000-1000-8000-000000000000",
        platform: "win32" as NodeJS.Platform,
        architecture: "x64",
      },
      {
        root: temporaryRoot(),
        argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
        nonce: randomUUID(),
        platform: "win32" as NodeJS.Platform,
        architecture: "arm64",
      },
    ];
    for (const candidate of cases) {
      let observed: unknown;
      try {
        prepareEncryptedVaultSmoke({
          argv: candidate.argv,
          environment: {
            [ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME]: candidate.root,
            [ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME]: candidate.nonce,
          },
          platform: candidate.platform,
          architecture: candidate.architecture,
          temporaryDirectory: tmpdir(),
        });
      } catch (error) {
        observed = error;
      }
      expectFixedFailure(observed);
    }

    const canonicalRoot = temporaryRoot();
    const nonCanonicalRoot = `${canonicalRoot}${sep}.`;
    expect(() => prepareEncryptedVaultSmoke({
      argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
      environment: {
        [ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME]: nonCanonicalRoot,
        [ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME]: randomUUID(),
      },
      platform: "win32",
      architecture: "x64",
      temporaryDirectory: tmpdir(),
    })).toThrow(EncryptedVaultSmokeError);
  });

  it("rejects a root outside the declared temporary boundary", () => {
    const root = temporaryRoot("owncontext-encrypted-outside-");
    const otherBoundary = temporaryRoot("owncontext-encrypted-boundary-");
    expect(() => prepareEncryptedVaultSmoke({
      argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
      environment: {
        [ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME]: root,
        [ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME]: randomUUID(),
      },
      platform: "win32",
      architecture: "x64",
      temporaryDirectory: otherBoundary,
    })).toThrow(EncryptedVaultSmokeError);
  });

  it("rejects a smoke root reached through a junction ancestor", () => {
    const parent = temporaryRoot("owncontext-encrypted-junction-parent-");
    const target = temporaryRoot("owncontext-encrypted-junction-target-");
    const targetLeaf = join(target, "leaf");
    mkdirSync(targetLeaf);
    const junction = join(parent, "junction");
    symlinkSync(target, junction, "junction");
    const linkedLeaf = join(junction, "leaf");

    expect(() => prepareEncryptedVaultSmoke({
      argv: ["OwnContext.exe", ENCRYPTED_VAULT_SMOKE_ARGUMENT],
      environment: {
        [ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME]: linkedLeaf,
        [ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME]: randomUUID(),
      },
      platform: "win32",
      architecture: "x64",
      temporaryDirectory: tmpdir(),
    })).toThrow(EncryptedVaultSmokeError);
    expect(existsSync(join(targetLeaf, "electron-user-data"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "packaged Windows encrypted-vault native journey",
  () => {
    it("imports, searches, fetches, closes, and reopens through the actual native provider", async () => {
      const root = temporaryRoot();
      const nonce = randomUUID();
      const context = preparation(root, nonce);

      // This reversible fake exercises the ElectronSafeStorage adapter contract.
      // It is intentionally not evidence of DPAPI or any OS protection claim.
      const result = await runEncryptedVaultSmoke(
        context,
        reversibleTestSafeStorage(),
        true,
        resourcesPath(),
      );
      expect(result).toEqual({
        schemaVersion: 1,
        status: ENCRYPTED_VAULT_SMOKE_STATUS,
        nonce,
        platform: "win32",
        architecture: "x64",
        isPackaged: true,
        releaseBoundary: ENCRYPTED_VAULT_SMOKE_RELEASE_BOUNDARY,
        publicReleaseApproved: false,
        doesNotProve: ENCRYPTED_VAULT_SMOKE_DOES_NOT_PROVE,
        providerId: ENCRYPTED_VAULT_SMOKE_PROVIDER_ID,
        keyProtectorProviderId: VAULT_KEY_PROVIDER_ID,
        engineIdentity: ENCRYPTED_SQLITE_ENGINE_IDENTITY,
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
      expect(isEncryptedVaultSmokeResult(result, nonce)).toBe(true);

      const evidence = readFileSync(context.resultPath, "utf8");
      expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(
        ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES,
      );
      expect(evidence).toBe(`${JSON.stringify(result)}\n`);
      expect(isEncryptedVaultSmokeResult(JSON.parse(evidence), nonce)).toBe(true);

      const state = JSON.parse(
        readFileSync(join(context.vaultDirectoryPath, WINDOWS_VAULT_STATE_FILE_NAME), "utf8"),
      ) as Record<string, unknown>;
      expect(state.status).toBe("ready");
      expect(evidence).not.toContain(context.rootPath);
      expect(evidence).not.toContain(context.fixturePath);
      const canary = readSmokeCanary(context);
      expect(canary).not.toContain(nonce.replaceAll("-", ""));
      expect(evidence).not.toContain(canary);
      expect(evidence).not.toContain(String(state.vaultId));
      expect(evidence).not.toContain(String(state.keyId));

      expect(isEncryptedVaultSmokeResult({
        ...result,
        publicReleaseApproved: true,
      }, nonce)).toBe(false);
      expect(isEncryptedVaultSmokeResult({
        ...result,
        doesNotProve: [],
      }, nonce)).toBe(false);
    });

    it("fails closed when async safeStorage becomes unavailable at reopen", async () => {
      const context = preparation(temporaryRoot());
      const safeStorage = reversibleTestSafeStorage({
        availability: (call) => call === 1,
      });
      let observed: unknown;
      try {
        await runEncryptedVaultSmoke(context, safeStorage, true, resourcesPath());
      } catch (error) {
        observed = error;
      }
      expect(safeStorage.availabilityCalls).toBe(2);
      expectFixedFailure(observed, context);
    });

    it("fails closed when an authenticated database page is tampered before reopen", async () => {
      const context = preparation(temporaryRoot());
      const databasePath = join(
        context.vaultDirectoryPath,
        WINDOWS_ENCRYPTED_VAULT_FILE_NAME,
      );
      const safeStorage = reversibleTestSafeStorage({
        onAvailability(call) {
          if (call !== 2) return;
          const bytes = readFileSync(databasePath);
          expect(bytes.byteLength).toBeGreaterThan(1024);
          bytes[512] = (bytes[512] ?? 0) ^ 0x80;
          writeFileSync(databasePath, bytes);
        },
      });
      let observed: unknown;
      try {
        await runEncryptedVaultSmoke(context, safeStorage, true, resourcesPath());
      } catch (error) {
        observed = error;
      }
      expectFixedFailure(observed, context);
    });

    it.each(plaintextEncodings)(
      "fails closed when fixture plaintext leaks into the envelope as $name",
      async ({ encode }) => {
        const nonce = randomUUID();
        const context = preparation(temporaryRoot(), nonce);
        const safeStorage = reversibleTestSafeStorage({
          onDecrypt() {
            appendFileSync(
              join(
                context.vaultDirectoryPath,
                WINDOWS_VAULT_KEY_ENVELOPE_FILE_NAME,
              ),
              encode(readSmokeCanary(context)),
            );
          },
        });
        let observed: unknown;
        try {
          await runEncryptedVaultSmoke(context, safeStorage, true, resourcesPath());
        } catch (error) {
          observed = error;
        }
        expectFixedFailure(observed, context);
      },
    );

    it("rejects non-packaged execution and pre-existing evidence without success output", async () => {
      const unpackaged = preparation(temporaryRoot());
      await expect(runEncryptedVaultSmoke(
        unpackaged,
        reversibleTestSafeStorage(),
        false,
        resourcesPath(),
      )).rejects.toThrow(EncryptedVaultSmokeError);
      expect(existsSync(unpackaged.resultPath)).toBe(false);

      const occupied = preparation(temporaryRoot());
      writeFileSync(occupied.resultPath, "not-evidence", { flag: "wx" });
      let observed: unknown;
      try {
        await runEncryptedVaultSmoke(
          occupied,
          reversibleTestSafeStorage(),
          true,
          resourcesPath(),
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(EncryptedVaultSmokeError);
      expect(readFileSync(occupied.resultPath, "utf8")).toBe("not-evidence");
    });
  },
);
