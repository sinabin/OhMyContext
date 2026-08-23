import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EncryptedVaultCandidateError,
  importDirectory,
  openEncryptedVaultCandidate,
  searchVault,
  type Vault,
} from "@owncontext/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  EncryptedSqliteProviderError,
  createEncryptedSqliteProvider,
  type EncryptedSqliteProviderRuntime,
} from "../src/electron/encrypted-sqlite-provider.js";

const KEY = Buffer.from(
  "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100",
  "hex",
);
const WRONG_KEY = Buffer.from(
  "ffeeddccbbaa9988776655443322110000112233445566778899aabbccddeeff",
  "hex",
);
const UTF8_CANARY = "OC_UTF8_SECRET_4f143babb6a04932";
const UTF16_CANARY = "OC_UTF16_SECRET_91e07db4c5f64dac";
const SQLITE3MC_IDENTITY_QUERY =
  "SELECT sqlite3mc_version() AS sqlite3mc_version, sqlite_version() AS sqlite_version";
const createdDirectories: string[] = [];
const openVaults: Vault[] = [];

afterEach(() => {
  for (const vault of openVaults.splice(0)) {
    try {
      vault.close();
    } catch {
      // Best-effort test cleanup.
    }
  }
  for (const directory of createdDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup.
    }
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

class FakeCipherDatabase {
  readonly events: string[];
  closeCount = 0;
  hmacCheck: unknown = "1";
  cipher: unknown = "chacha20";
  tempStore: unknown = 2;
  userVersion: unknown = 0;
  sqlite3mcVersion: unknown = "SQLite3 Multiple Ciphers 2.4.0";
  sqliteVersion: unknown = "3.53.4";
  keyedSnapshot?: Buffer;
  keyedReference?: Buffer;
  keyResult = 0;
  throwFromKey?: Error;

  constructor(events: string[] = []) {
    this.events = events;
  }

  close(): void {
    this.events.push("close");
    this.closeCount += 1;
  }

  exec(source: string): void {
    this.events.push(`exec:${source}`);
  }

  key(key: Buffer): number {
    this.events.push("key");
    this.keyedReference = key;
    this.keyedSnapshot = Buffer.from(key);
    if (this.throwFromKey) throw this.throwFromKey;
    return this.keyResult;
  }

  pragma(source: string, options?: { readonly simple?: boolean }): unknown {
    expect(options).toEqual({ simple: true });
    this.events.push(`pragma:${source}`);
    switch (source) {
      case "cipher = 'chacha20'":
        return "chacha20";
      case "hmac_check = 1":
        return "1";
      case "temp_store = MEMORY":
        return undefined;
      case "cipher":
        return this.cipher;
      case "hmac_check":
        return this.hmacCheck;
      case "temp_store":
        return this.tempStore;
      case "user_version":
        return this.userVersion;
      default:
        throw new Error(`unexpected pragma: ${source}`);
    }
  }

  prepare(source: string): {
    all: (...parameters: unknown[]) => unknown[];
    get: (...parameters: unknown[]) => unknown;
    run: (...parameters: unknown[]) => { changes: number; lastInsertRowid: number };
  } {
    if (source === SQLITE3MC_IDENTITY_QUERY) {
      this.events.push("prepare:engine-identity");
      return {
        all: () => [],
        get: () => {
          this.events.push("get:engine-identity");
          return {
            sqlite3mc_version: this.sqlite3mcVersion,
            sqlite_version: this.sqliteVersion,
          };
        },
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    }
    this.events.push(`prepare:${source}`);
    return {
      all: () => [],
      get: () => undefined,
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
  }
}

function fakeRuntime(
  openDatabase: EncryptedSqliteProviderRuntime["openDatabase"],
): EncryptedSqliteProviderRuntime {
  return { platform: "win32", arch: "x64", openDatabase };
}

function expectProviderError(
  operation: () => unknown,
  code: EncryptedSqliteProviderError["code"],
): EncryptedSqliteProviderError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EncryptedSqliteProviderError);
    expect((error as EncryptedSqliteProviderError).code).toBe(code);
    return error as EncryptedSqliteProviderError;
  }
  throw new Error("Expected encrypted SQLite provider failure.");
}

describe("encrypted SQLite provider boundary", () => {
  it("uses binary keying before the first keyed page read and attests exact settings", () => {
    const root = temporaryDirectory("owncontext-cipher-order-");
    const databasePath = join(root, "vault.db");
    const events: string[] = [];
    const fake = new FakeCipherDatabase(events);
    const provider = createEncryptedSqliteProvider(fakeRuntime((location, options) => {
      events.push("open");
      expect(location).toBe(databasePath);
      expect(options).toEqual({ fileMustExist: true });
      return fake;
    }));

    const session = provider.openKeyed({
      location: databasePath,
      key: KEY,
      mode: "create-exclusive",
    });

    expect(events).toEqual([
      "open",
      "pragma:cipher = 'chacha20'",
      "pragma:hmac_check = 1",
      "key",
      "pragma:temp_store = MEMORY",
    ]);
    expect(events).not.toContain("pragma:user_version");
    expect(fake.keyedSnapshot).toEqual(KEY);
    expect(fake.keyedReference).toEqual(Buffer.alloc(32));
    expect(KEY).toEqual(Buffer.from(
      "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100",
      "hex",
    ));

    expect(session.attestCipher()).toEqual({ status: "active" });
    expect(events).toEqual([
      "open",
      "pragma:cipher = 'chacha20'",
      "pragma:hmac_check = 1",
      "key",
      "pragma:temp_store = MEMORY",
      "pragma:cipher",
      "pragma:hmac_check",
      "pragma:temp_store",
      "prepare:engine-identity",
      "get:engine-identity",
    ]);
    expect(session.inspectSchemaVersion()).toBe(0);
    expect(events.indexOf("key")).toBeLessThan(events.indexOf("pragma:user_version"));
    expect(events.indexOf("get:engine-identity"))
      .toBeLessThan(events.indexOf("pragma:user_version"));
    session.connection.close();
    expect(fake.closeCount).toBe(1);
  });

  it("revalidates an intrinsic exact 32-byte Buffer and rejects invalid keys before creation", () => {
    const root = temporaryDirectory("owncontext-cipher-key-");
    const provider = createEncryptedSqliteProvider(fakeRuntime(() =>
      new FakeCipherDatabase()));

    for (const [name, key] of [
      ["short", Buffer.alloc(31)],
      ["long", Buffer.alloc(33)],
      ["view", new Uint8Array(32)],
      ["proxy", new Proxy(Buffer.alloc(32), {})],
    ] as const) {
      const databasePath = join(root, `${name}.db`);
      expectProviderError(() => provider.openKeyed({
        location: databasePath,
        key: key as Buffer,
        mode: "create-exclusive",
      }), "INVALID_REQUEST");
      expect(existsSync(databasePath)).toBe(false);
    }

    const shadowed = Buffer.alloc(32, 0x44);
    Object.defineProperty(shadowed, "byteLength", { value: 1 });
    const databasePath = join(root, "shadowed.db");
    const session = provider.openKeyed({
      location: databasePath,
      key: shadowed,
      mode: "create-exclusive",
    });
    expect(session.attestCipher()).toEqual({ status: "active" });
    expect(session.inspectSchemaVersion()).toBe(0);
    session.connection.close();
  });

  it("is fail-closed outside the explicit Windows x64 runtime", () => {
    const root = temporaryDirectory("owncontext-cipher-platform-");
    const databasePath = join(root, "vault.db");
    const provider = createEncryptedSqliteProvider({
      platform: "darwin",
      arch: "arm64",
      openDatabase: () => new FakeCipherDatabase(),
    });

    expectProviderError(() => provider.openKeyed({
      location: databasePath,
      key: KEY,
      mode: "create-exclusive",
    }), "UNSUPPORTED_RUNTIME");
    expect(existsSync(databasePath)).toBe(false);
  });

  it("requires an absolute canonical path with a real, non-linked parent", () => {
    const root = temporaryDirectory("owncontext-cipher-path-");
    const actualParent = join(root, "actual");
    const linkedParent = join(root, "linked");
    writeFileSync(join(root, "parent-marker"), "marker");
    // A directory junction does not require Windows developer-mode symlink rights.
    symlinkSync(root, linkedParent, "junction");
    const provider = createEncryptedSqliteProvider(fakeRuntime(() =>
      new FakeCipherDatabase()));

    expectProviderError(() => provider.openKeyed({
      location: "relative-vault.db",
      key: KEY,
      mode: "create-exclusive",
    }), "INVALID_REQUEST");
    expectProviderError(() => provider.openKeyed({
      location: join(linkedParent, "vault.db"),
      key: KEY,
      mode: "create-exclusive",
    }), "OPEN_FAILED");
    expect(existsSync(join(root, "vault.db"))).toBe(false);
    expect(existsSync(actualParent)).toBe(false);
  });

  it("never creates a missing open-existing target or overwrites an existing target", () => {
    const root = temporaryDirectory("owncontext-cipher-modes-");
    const missingPath = join(root, "missing.db");
    const existingPath = join(root, "existing.db");
    const marker = Buffer.from("existing-file-must-survive", "utf8");
    writeFileSync(existingPath, marker);
    const provider = createEncryptedSqliteProvider(fakeRuntime(() =>
      new FakeCipherDatabase()));

    expectProviderError(() => provider.openKeyed({
      location: missingPath,
      key: KEY,
      mode: "open-existing",
    }), "OPEN_FAILED");
    expect(existsSync(missingPath)).toBe(false);

    expectProviderError(() => provider.openKeyed({
      location: existingPath,
      key: KEY,
      mode: "create-exclusive",
    }), "OPEN_FAILED");
    expect(readFileSync(existingPath)).toEqual(marker);
  });

  it("rejects hard-linked main files and sidecars and does not unlink a raced alias", () => {
    const root = temporaryDirectory("owncontext-cipher-hardlink-");
    const provider = createEncryptedSqliteProvider(fakeRuntime(() =>
      new FakeCipherDatabase()));

    const originalPath = join(root, "original.db");
    const linkedDatabasePath = join(root, "linked.db");
    const marker = Buffer.from("hardlink-marker", "utf8");
    writeFileSync(originalPath, marker);
    linkSync(originalPath, linkedDatabasePath);
    expectProviderError(() => provider.openKeyed({
      location: linkedDatabasePath,
      key: KEY,
      mode: "open-existing",
    }), "OPEN_FAILED");
    expect(readFileSync(originalPath)).toEqual(marker);
    expect(readFileSync(linkedDatabasePath)).toEqual(marker);

    const sidecarDatabasePath = join(root, "sidecar.db");
    const sidecarSourcePath = join(root, "outside-sidecar");
    writeFileSync(sidecarDatabasePath, marker);
    writeFileSync(sidecarSourcePath, "sidecar-alias");
    linkSync(sidecarSourcePath, `${sidecarDatabasePath}-wal`);
    expectProviderError(() => provider.openKeyed({
      location: sidecarDatabasePath,
      key: KEY,
      mode: "open-existing",
    }), "OPEN_FAILED");
    expect(readFileSync(sidecarSourcePath)).toEqual(Buffer.from("sidecar-alias"));

    const racedDatabasePath = join(root, "raced.db");
    const racedAliasPath = join(root, "raced-alias.db");
    const fake = new FakeCipherDatabase();
    const racedProvider = createEncryptedSqliteProvider(fakeRuntime((location) => {
      linkSync(location, racedAliasPath);
      return fake;
    }));
    expectProviderError(() => racedProvider.openKeyed({
      location: racedDatabasePath,
      key: KEY,
      mode: "create-exclusive",
    }), "OPEN_FAILED");
    expect(fake.closeCount).toBe(1);
    expect(existsSync(racedDatabasePath)).toBe(true);
    expect(existsSync(racedAliasPath)).toBe(true);
  });

  it("publishes the exclusive reservation before a competing creator can open", () => {
    const root = temporaryDirectory("owncontext-cipher-compete-");
    const databasePath = join(root, "vault.db");
    const ordinaryProvider = createEncryptedSqliteProvider(fakeRuntime(() =>
      new FakeCipherDatabase()));
    let competingError: EncryptedSqliteProviderError | undefined;
    const outerProvider = createEncryptedSqliteProvider(fakeRuntime(() => {
      competingError = expectProviderError(() => ordinaryProvider.openKeyed({
        location: databasePath,
        key: WRONG_KEY,
        mode: "create-exclusive",
      }), "OPEN_FAILED");
      return new FakeCipherDatabase();
    }));

    const session = outerProvider.openKeyed({
      location: databasePath,
      key: KEY,
      mode: "create-exclusive",
    });
    expect(competingError?.message).toBe("Encrypted vault storage could not be opened.");
    expect(existsSync(databasePath)).toBe(true);
    session.connection.close();
  });

  it.each(["open-existing", "create-exclusive"] as const)(
    "detects a %s path-identity swap, closes, and preserves the replacement",
    (mode) => {
      const root = temporaryDirectory(`owncontext-cipher-race-${mode}-`);
      const databasePath = join(root, "vault.db");
      if (mode === "open-existing") writeFileSync(databasePath, "original");
      const replacement = Buffer.from(`replacement-${mode}`, "utf8");
      const fake = new FakeCipherDatabase();
      const provider = createEncryptedSqliteProvider(fakeRuntime((location) => {
        unlinkSync(location);
        writeFileSync(location, replacement);
        return fake;
      }));

      const error = expectProviderError(() => provider.openKeyed({
        location: databasePath,
        key: KEY,
        mode,
      }), "OPEN_FAILED");
      expect(error.message).toBe("Encrypted vault storage could not be opened.");
      expect(fake.closeCount).toBe(1);
      expect(readFileSync(databasePath)).toEqual(replacement);
    },
  );

  it("closes when the exact native engine identity changes", () => {
    const root = temporaryDirectory("owncontext-cipher-attest-");
    const databasePath = join(root, "vault.db");
    const fake = new FakeCipherDatabase();
    const provider = createEncryptedSqliteProvider(fakeRuntime(() => fake));
    const session = provider.openKeyed({
      location: databasePath,
      key: KEY,
      mode: "create-exclusive",
    });

    fake.sqlite3mcVersion = "SQLite3 Multiple Ciphers unexpected";
    const error = expectProviderError(
      () => session.attestCipher(),
      "CIPHER_ATTESTATION_FAILED",
    );
    expect(error.message).toBe("Encrypted vault cipher attestation failed.");
    expect(fake.closeCount).toBe(1);
    expect(() => session.connection.prepare("SELECT secret FROM private"))
      .toThrow("Encrypted vault database operation failed.");
  });

  it("bounds native open/key failures and closes acquired connections", () => {
    const root = temporaryDirectory("owncontext-cipher-errors-");
    const databasePath = join(root, "vault.db");
    const fake = new FakeCipherDatabase();
    fake.throwFromKey = new Error(
      `native secret ${databasePath} ${KEY.toString("hex")}`,
    );
    const provider = createEncryptedSqliteProvider(fakeRuntime(() => fake));

    const error = expectProviderError(() => provider.openKeyed({
      location: databasePath,
      key: KEY,
      mode: "create-exclusive",
    }), "OPEN_FAILED");
    expect(error.message).toBe("Encrypted vault storage could not be opened.");
    expect(String(error)).not.toContain(databasePath);
    expect(String(error)).not.toContain(KEY.toString("hex"));
    expect(fake.closeCount).toBe(1);
    expect(existsSync(databasePath)).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32" || process.arch !== "x64")(
  "encrypted SQLite provider native conformance",
  () => {
    it("runs the OwnContext FTS schema in encrypted WAL mode and survives restart", async () => {
      const vaultRoot = temporaryDirectory("owncontext-cipher-native-vault-");
      const inputRoot = temporaryDirectory("owncontext-cipher-native-input-");
      const databasePath = join(vaultRoot, "vault.db");
      writeFileSync(
        join(inputRoot, "private.md"),
        `# Private knowledge\n\n${UTF8_CANARY}\n${UTF16_CANARY}\n`,
        "utf8",
      );
      const provider = createEncryptedSqliteProvider();

      const first = openEncryptedVaultCandidate(databasePath, provider, {
        key: KEY,
        mode: "create-exclusive",
      });
      openVaults.push(first);
      const imported = await importDirectory(first, inputRoot, {
        collection: "encrypted-regression",
        sourceName: "Encrypted regression",
      });
      expect(imported.imported).toBe(1);
      expect(searchVault(first, { query: UTF8_CANARY })).toHaveLength(1);

      const openFiles = readdirSync(vaultRoot).sort();
      expect(openFiles).toContain("vault.db");
      expect(openFiles).toContain("vault.db-wal");
      expectNoPlaintextCanary(vaultRoot);

      first.close();
      openVaults.splice(openVaults.indexOf(first), 1);
      expectNoPlaintextCanary(vaultRoot);

      const second = openEncryptedVaultCandidate(databasePath, provider, {
        key: KEY,
        mode: "open-existing",
      });
      openVaults.push(second);
      const results = searchVault(second, {
        query: UTF16_CANARY,
        collection: "encrypted-regression",
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.snippet).toContain(UTF16_CANARY);
      second.close();
      openVaults.splice(openVaults.indexOf(second), 1);
      expectNoPlaintextCanary(vaultRoot);
    });

    it("rejects a wrong key through keyed user_version inspection and releases the file", () => {
      const root = temporaryDirectory("owncontext-cipher-wrong-key-");
      const databasePath = join(root, "vault.db");
      const provider = createEncryptedSqliteProvider();
      const created = openEncryptedVaultCandidate(databasePath, provider, {
        key: KEY,
        mode: "create-exclusive",
      });
      created.close();
      const before = readFileSync(databasePath);

      const error = expectCoreCandidateError(() => openEncryptedVaultCandidate(
        databasePath,
        provider,
        { key: WRONG_KEY, mode: "open-existing" },
      ), "CIPHER_ATTESTATION_FAILED");
      expect(String(error)).not.toContain(databasePath);
      expect(String(error)).not.toContain(WRONG_KEY.toString("hex"));
      expect(readFileSync(databasePath)).toEqual(before);

      const reopened = openEncryptedVaultCandidate(databasePath, provider, {
        key: KEY,
        mode: "open-existing",
      });
      reopened.close();
      const renamed = join(root, "released.db");
      renameSync(databasePath, renamed);
      expect(existsSync(renamed)).toBe(true);
    });

    it("detects an authenticated-page tamper and closes the failed session", () => {
      const root = temporaryDirectory("owncontext-cipher-tamper-");
      const databasePath = join(root, "vault.db");
      const provider = createEncryptedSqliteProvider();
      const created = openEncryptedVaultCandidate(databasePath, provider, {
        key: KEY,
        mode: "create-exclusive",
      });
      created.close();

      const tampered = readFileSync(databasePath);
      expect(tampered.byteLength).toBeGreaterThan(1024);
      tampered[512] = (tampered[512] ?? 0) ^ 0x80;
      writeFileSync(databasePath, tampered);

      const error = expectCoreCandidateError(() => openEncryptedVaultCandidate(
        databasePath,
        provider,
        { key: KEY, mode: "open-existing" },
      ), "CIPHER_ATTESTATION_FAILED");
      expect(error.message).toBe("Encrypted vault candidate cipher attestation failed.");
      const renamed = join(root, "tampered-released.db");
      renameSync(databasePath, renamed);
      expect(existsSync(renamed)).toBe(true);
    });
  },
);

function expectCoreCandidateError(
  operation: () => unknown,
  code: EncryptedVaultCandidateError["code"],
): EncryptedVaultCandidateError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(EncryptedVaultCandidateError);
    expect((error as EncryptedVaultCandidateError).code).toBe(code);
    return error as EncryptedVaultCandidateError;
  }
  throw new Error("Expected encrypted vault candidate failure.");
}

function expectNoPlaintextCanary(directory: string): void {
  const forbidden = [
    Buffer.from(UTF8_CANARY, "utf8"),
    Buffer.from(UTF8_CANARY, "utf16le"),
    toUtf16BigEndian(UTF8_CANARY),
    Buffer.from(UTF16_CANARY, "utf8"),
    Buffer.from(UTF16_CANARY, "utf16le"),
    toUtf16BigEndian(UTF16_CANARY),
  ];
  const inspected = readdirSync(directory)
    .filter((name) => /^vault\.db(?:-(?:wal|shm|journal))?$/u.test(name));
  expect(inspected).not.toHaveLength(0);
  for (const name of inspected) {
    const bytes = readFileSync(join(directory, name));
    for (const canary of forbidden) {
      expect(bytes.includes(canary), `${name} contains a plaintext canary`).toBe(false);
    }
  }
}

function toUtf16BigEndian(value: string): Buffer {
  const bytes = Buffer.from(value, "utf16le");
  bytes.swap16();
  return bytes;
}
