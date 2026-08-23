import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeSqliteDevelopmentStorageProvider,
  openVault,
} from "../src/index.js";
import {
  MAX_SCHEMA_INSPECTION_WAL_BYTES,
  inspectNodeSqliteSchemaVersion,
} from "../src/sqlite-compatibility.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

interface VaultFilesSnapshot {
  inventory: string[];
  main: Buffer | null;
  wal: Buffer | null;
  shm: Buffer | null;
}

interface TestWalChecksum {
  first: number;
  second: number;
}

function updateTestWalChecksum(
  initial: TestWalChecksum,
  bytes: Buffer,
  offset: number,
  length: number,
  byteOrder: "big" | "little",
): TestWalChecksum {
  const readWord = byteOrder === "big"
    ? (position: number) => bytes.readUInt32BE(position)
    : (position: number) => bytes.readUInt32LE(position);
  let first = initial.first;
  let second = initial.second;
  for (let index = offset; index < offset + length; index += 8) {
    first = (first + readWord(index) + second) >>> 0;
    second = (second + readWord(index + 4) + first) >>> 0;
  }
  return { first, second };
}

function invalidateCommitFrameWithZeroPageNumber(wal: Buffer): void {
  const pageSize = wal.readUInt32BE(8);
  const frameBytes = 24 + pageSize;
  const frameCount = Math.floor((wal.byteLength - 32) / frameBytes);
  let pendingPageOne = false;
  let targetFrame = -1;
  for (let index = 0; index < frameCount; index += 1) {
    const position = 32 + index * frameBytes;
    if (wal.readUInt32BE(position) === 1 && wal.readUInt32BE(position + 4) === 0) {
      pendingPageOne = true;
    }
    if (pendingPageOne && wal.readUInt32BE(position + 4) !== 0) {
      targetFrame = index;
      break;
    }
  }
  if (targetFrame < 0) {
    throw new Error("Fixture does not contain a page-one frame followed by a commit frame.");
  }

  wal.writeUInt32BE(0, 32 + targetFrame * frameBytes);
  const byteOrder = wal.readUInt32BE(0) === 0x377f0683 ? "big" : "little";
  let checksum = updateTestWalChecksum({ first: 0, second: 0 }, wal, 0, 24, byteOrder);
  for (let index = 0; index < frameCount; index += 1) {
    const position = 32 + index * frameBytes;
    checksum = updateTestWalChecksum(checksum, wal, position, 8, byteOrder);
    checksum = updateTestWalChecksum(checksum, wal, position + 24, pageSize, byteOrder);
    wal.writeUInt32BE(checksum.first, position + 16);
    wal.writeUInt32BE(checksum.second, position + 20);
  }
}

async function snapshotVaultFiles(
  root: string,
  databasePath: string,
): Promise<VaultFilesSnapshot> {
  return {
    inventory: (await readdir(root)).sort(),
    main: await readIfPresent(databasePath),
    wal: await readIfPresent(`${databasePath}-wal`),
    shm: await readIfPresent(`${databasePath}-shm`),
  };
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  return existsSync(path) ? readFile(path) : null;
}

function expectIdenticalBytes(actual: Buffer | null, expected: Buffer | null): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual?.byteLength).toBe(expected.byteLength);
  expect(actual?.equals(expected)).toBe(true);
}

async function createCrashStyleFutureVault(
  root: string,
  pageSize = 4_096,
): Promise<string> {
  const stagingRoot = join(root, "staging");
  const stagingPath = join(stagingRoot, "writer.sqlite");
  const databasePath = join(root, "future.sqlite");
  await mkdir(stagingRoot);

  const writer = new DatabaseSync(stagingPath);
  try {
    writer.exec(`
      PRAGMA page_size = ${pageSize};
      VACUUM;
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE stable(value TEXT) STRICT;
      PRAGMA user_version = 2;
    `);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec(`
      BEGIN IMMEDIATE;
      PRAGMA user_version = 99;
      INSERT INTO stable(value) VALUES ('future-only data');
      COMMIT;
    `);

    // Copy the durable database and WAL while the writer is alive, but omit
    // its transient shared-memory index. This is the state left by a process
    // crash after the WAL commit and before a final checkpoint.
    await copyFile(stagingPath, databasePath);
    await copyFile(`${stagingPath}-wal`, `${databasePath}-wal`);
  } finally {
    writer.close();
  }

  await rm(stagingRoot, { recursive: true, force: true });
  return databasePath;
}

async function createCommittedVersionTwoWal(root: string): Promise<string> {
  const sourceRoot = join(root, "wal-source");
  const sourcePath = join(sourceRoot, "source.sqlite");
  const copiedWalPath = join(root, "version-two.wal");
  await mkdir(sourceRoot);

  const writer = new DatabaseSync(sourcePath);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE stable(value TEXT) STRICT;
      PRAGMA user_version = 1;
    `);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec(`
      BEGIN IMMEDIATE;
      PRAGMA user_version = 2;
      INSERT INTO stable(value) VALUES ('stale sidecar data');
      COMMIT;
    `);
    await copyFile(`${sourcePath}-wal`, copiedWalPath);
  } finally {
    writer.close();
  }
  return copiedWalPath;
}

describe("future-schema compatibility in a crash-style WAL", () => {
  it.each([512, 4_096, 65_536])(
    "reads the latest committed page-one version from a checksum-valid %i-byte WAL",
    async (pageSize) => {
      const root = await mkdtemp(join(tmpdir(), "owncontext-wal-page-size-"));
      temporaryPaths.push(root);
      const databasePath = await createCrashStyleFutureVault(root, pageSize);

      expect(inspectNodeSqliteSchemaVersion(databasePath)).toBe(99);
      expect((await readFile(databasePath)).readUInt16BE(16)).toBe(
        pageSize === 65_536 ? 1 : pageSize,
      );
    },
  );

  it("rejects without changing main, WAL, SHM, or file existence", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-wal-compatibility-"));
    temporaryPaths.push(root);
    const databasePath = await createCrashStyleFutureVault(root);
    const before = await snapshotVaultFiles(root, databasePath);

    expect(before.inventory).toEqual(["future.sqlite", "future.sqlite-wal"]);
    expect(before.main?.readUInt32BE(60)).toBe(2);
    expect(before.wal?.byteLength).toBeGreaterThan(32);
    expect(before.shm).toBeNull();

    expect(() => openVault(
      databasePath,
      createNodeSqliteDevelopmentStorageProvider(),
    )).toThrow("Vault schema version 99 is newer than supported version 2");

    const after = await snapshotVaultFiles(root, databasePath);
    expect(after.inventory).toEqual(before.inventory);
    expectIdenticalBytes(after.main, before.main);
    expectIdenticalBytes(after.wal, before.wal);
    expectIdenticalBytes(after.shm, before.shm);
  });

  it("never applies a stale WAL to a rollback-mode future database", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-stale-wal-"));
    temporaryPaths.push(root);
    const staleWalPath = await createCommittedVersionTwoWal(root);
    const targetRoot = join(root, "target");
    const databasePath = join(targetRoot, "future.sqlite");
    await mkdir(targetRoot);
    const target = new DatabaseSync(databasePath);
    target.exec("PRAGMA user_version = 99");
    target.close();
    await copyFile(staleWalPath, `${databasePath}-wal`);
    const before = await snapshotVaultFiles(targetRoot, databasePath);

    expect(before.main?.subarray(18, 20)).toEqual(Buffer.from([1, 1]));
    expect(() => inspectNodeSqliteSchemaVersion(databasePath)).toThrow(
      "Vault WAL does not match the database journal mode",
    );
    expect(() => openVault(
      databasePath,
      createNodeSqliteDevelopmentStorageProvider(),
    )).toThrow("Vault WAL does not match the database journal mode");

    const after = await snapshotVaultFiles(targetRoot, databasePath);
    expect(after.inventory).toEqual(before.inventory);
    expectIdenticalBytes(after.main, before.main);
    expectIdenticalBytes(after.wal, before.wal);
    expectIdenticalBytes(after.shm, before.shm);
  });

  it("ignores a checksum-valid commit frame whose page number is zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-zero-page-wal-"));
    temporaryPaths.push(root);
    const databasePath = await createCrashStyleFutureVault(root);
    const walPath = `${databasePath}-wal`;
    const wal = await readFile(walPath);
    invalidateCommitFrameWithZeroPageNumber(wal);
    await writeFile(walPath, wal);

    expect(inspectNodeSqliteSchemaVersion(databasePath)).toBe(2);
  });

  it("fails closed on rollback recovery without changing the journal or main file", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-rollback-compatibility-"));
    temporaryPaths.push(root);
    const databasePath = join(root, "rollback.sqlite");
    const setup = new DatabaseSync(databasePath);
    setup.exec("PRAGMA user_version = 2");
    setup.close();
    const journalPath = `${databasePath}-journal`;
    await writeFile(journalPath, Buffer.from("hot-journal-fixture", "utf8"));
    const beforeMain = await readFile(databasePath);
    const beforeJournal = await readFile(journalPath);
    const beforeInventory = (await readdir(root)).sort();

    expect(() => openVault(
      databasePath,
      createNodeSqliteDevelopmentStorageProvider(),
    )).toThrow("Vault rollback recovery must complete");

    expect((await readdir(root)).sort()).toEqual(beforeInventory);
    expect(await readFile(databasePath)).toEqual(beforeMain);
    expect(await readFile(journalPath)).toEqual(beforeJournal);
  });

  it("bounds WAL inspection before reading an oversized sparse sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-wal-bound-"));
    temporaryPaths.push(root);
    const databasePath = join(root, "bounded.sqlite");
    const setup = new DatabaseSync(databasePath);
    setup.exec("PRAGMA journal_mode = WAL; PRAGMA user_version = 2");
    setup.close();
    const walPath = `${databasePath}-wal`;
    const wal = await open(walPath, "w");
    try {
      await wal.truncate(MAX_SCHEMA_INSPECTION_WAL_BYTES + 1);
    } finally {
      await wal.close();
    }
    const beforeMain = await readFile(databasePath);

    expect(() => openVault(
      databasePath,
      createNodeSqliteDevelopmentStorageProvider(),
    )).toThrow("Vault WAL is outside the schema-inspection bound");

    expect(await readFile(databasePath)).toEqual(beforeMain);
    expect((await stat(walPath)).size).toBe(MAX_SCHEMA_INSPECTION_WAL_BYTES + 1);
  });
});
