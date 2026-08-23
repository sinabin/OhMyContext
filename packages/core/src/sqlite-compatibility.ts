import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";

const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");
const WAL_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
const WAL_MAGIC_LITTLE_ENDIAN_CHECKSUM = 0x377f0682;
const WAL_MAGIC_BIG_ENDIAN_CHECKSUM = 0x377f0683;
const WAL_FORMAT_VERSION = 3_007_000;

/**
 * The default SQLite auto-checkpoint is normally far below this. The bound
 * keeps a hostile or abandoned WAL from blocking the Electron main process for
 * an unbounded time while still covering large page sizes and delayed
 * checkpoints in developer fixtures.
 */
export const MAX_SCHEMA_INSPECTION_WAL_BYTES = 256 * 1024 * 1024;

interface OpenRegularFile {
  readonly descriptor: number;
  readonly initial: BigIntStats;
  readonly path: string;
}

interface WalChecksum {
  readonly first: number;
  readonly second: number;
}

interface MainHeader {
  readonly journalMode: "rollback" | "wal";
  readonly pageSize: number;
  readonly schemaVersion: number;
}

export function inspectNodeSqliteSchemaVersion(location: string): number {
  if (location === ":memory:" || !existsSync(location)) return 0;
  if (existsSync(`${location}-journal`)) {
    throw new Error(
      "Vault rollback recovery must complete before schema compatibility can be inspected.",
    );
  }

  const main = openRegularFile(location);
  let wal: OpenRegularFile | undefined;
  try {
    if (main.initial.size === 0n) {
      assertOpenFileStable(main);
      if (existsSync(`${location}-wal`)) {
        throw new Error("Vault storage changed during schema inspection.");
      }
      return 0;
    }
    if (main.initial.size < BigInt(SQLITE_HEADER_BYTES)) {
      throw new Error("Vault database header is invalid.");
    }
    const mainHeader = readExactBuffer(
      main.descriptor,
      SQLITE_HEADER_BYTES,
      0,
      "Vault database header is incomplete.",
    );
    const parsedMain = parseMainHeader(mainHeader);
    const walPath = `${location}-wal`;
    if (!existsSync(walPath)) {
      assertOpenFileStable(main, mainHeader);
      if (existsSync(walPath)) {
        throw new Error("Vault storage changed during schema inspection.");
      }
      return parsedMain.schemaVersion;
    }
    if (parsedMain.journalMode !== "wal") {
      throw new Error(
        "Vault WAL does not match the database journal mode; recovery is required before opening it.",
      );
    }

    wal = openRegularFile(walPath);
    // SQLite can create a legitimate zero-byte WAL while a read connection is
    // open after a successful truncating checkpoint. It contains no frames, so
    // the committed schema version still comes from the main header. Accept it
    // only after the same identity/state checks used for populated sidecars.
    if (wal.initial.size === 0n) {
      assertOpenFileStable(wal);
      assertOpenFileStable(main, mainHeader);
      if (existsSync(`${location}-journal`)) {
        throw new Error("Vault storage changed during schema inspection.");
      }
      return parsedMain.schemaVersion;
    }
    if (
      wal.initial.size < BigInt(WAL_HEADER_BYTES) ||
      wal.initial.size > BigInt(MAX_SCHEMA_INSPECTION_WAL_BYTES)
    ) {
      throw new Error("Vault WAL is outside the schema-inspection bound.");
    }
    const walVersion = inspectWalSchemaVersion(
      wal,
      parsedMain.pageSize,
      parsedMain.schemaVersion,
    );
    assertOpenFileStable(wal);
    assertOpenFileStable(main, mainHeader);
    if (existsSync(`${location}-journal`)) {
      throw new Error("Vault storage changed during schema inspection.");
    }
    return walVersion;
  } finally {
    if (wal) closeSync(wal.descriptor);
    closeSync(main.descriptor);
  }
}

function inspectWalSchemaVersion(
  wal: OpenRegularFile,
  databasePageSize: number,
  mainVersion: number,
): number {
  const header = readExactBuffer(
    wal.descriptor,
    WAL_HEADER_BYTES,
    0,
    "Vault WAL header is incomplete.",
  );
  const magic = header.readUInt32BE(0);
  if (
    magic !== WAL_MAGIC_LITTLE_ENDIAN_CHECKSUM &&
    magic !== WAL_MAGIC_BIG_ENDIAN_CHECKSUM
  ) {
    throw new Error("Vault WAL header is invalid.");
  }
  if (header.readUInt32BE(4) !== WAL_FORMAT_VERSION) {
    throw new Error("Vault WAL format is unsupported.");
  }
  const pageSize = header.readUInt32BE(8);
  if (!isSqlitePageSize(pageSize) || pageSize !== databasePageSize) {
    throw new Error("Vault WAL page size is invalid.");
  }
  const checksumByteOrder =
    magic === WAL_MAGIC_BIG_ENDIAN_CHECKSUM ? "big" : "little";
  let checksum = updateWalChecksum(
    { first: 0, second: 0 },
    header,
    0,
    24,
    checksumByteOrder,
  );
  if (
    checksum.first !== header.readUInt32BE(24) ||
    checksum.second !== header.readUInt32BE(28)
  ) {
    throw new Error("Vault WAL header checksum is invalid.");
  }

  const frameBytes = WAL_FRAME_HEADER_BYTES + pageSize;
  const completeFrames = Number(
    (wal.initial.size - BigInt(WAL_HEADER_BYTES)) / BigInt(frameBytes),
  );
  const frame = Buffer.allocUnsafe(frameBytes);
  const saltOne = header.readUInt32BE(16);
  const saltTwo = header.readUInt32BE(20);
  let committedVersion = mainVersion;
  let pendingPageOneVersion: number | undefined;

  try {
    for (let index = 0; index < completeFrames; index += 1) {
      const position = WAL_HEADER_BYTES + index * frameBytes;
      if (!readExactly(wal.descriptor, frame, 0, frameBytes, position)) {
        throw new Error("Vault WAL changed during schema inspection.");
      }
      if (
        frame.readUInt32BE(0) === 0 ||
        frame.readUInt32BE(8) !== saltOne ||
        frame.readUInt32BE(12) !== saltTwo
      ) {
        break;
      }

      let candidate = updateWalChecksum(
        checksum,
        frame,
        0,
        8,
        checksumByteOrder,
      );
      candidate = updateWalChecksum(
        candidate,
        frame,
        WAL_FRAME_HEADER_BYTES,
        pageSize,
        checksumByteOrder,
      );
      if (
        candidate.first !== frame.readUInt32BE(16) ||
        candidate.second !== frame.readUInt32BE(20)
      ) {
        break;
      }
      checksum = candidate;

      if (frame.readUInt32BE(0) === 1) {
        pendingPageOneVersion = frame.readUInt32BE(
          WAL_FRAME_HEADER_BYTES + 60,
        );
      }
      if (frame.readUInt32BE(4) !== 0) {
        if (pendingPageOneVersion !== undefined) {
          committedVersion = pendingPageOneVersion;
        }
        pendingPageOneVersion = undefined;
      }
    }
    const finalHeader = readExactBuffer(
      wal.descriptor,
      WAL_HEADER_BYTES,
      0,
      "Vault WAL header is incomplete.",
    );
    if (!finalHeader.equals(header)) {
      throw new Error("Vault WAL changed during schema inspection.");
    }
    return committedVersion;
  } finally {
    frame.fill(0);
  }
}

function parseMainHeader(header: Buffer): MainHeader {
  if (!header.subarray(0, SQLITE_MAGIC.byteLength).equals(SQLITE_MAGIC)) {
    throw new Error("Vault database header is invalid.");
  }
  const pageSize = parseSqlitePageSize(header);
  if (header[18] !== header[19] || (header[18] !== 1 && header[18] !== 2)) {
    throw new Error("Vault database format is unsupported.");
  }
  return {
    journalMode: header[18] === 2 ? "wal" : "rollback",
    pageSize,
    schemaVersion: header.readUInt32BE(60),
  };
}

function parseSqlitePageSize(header: Buffer): number {
  const encoded = header.readUInt16BE(16);
  const pageSize = encoded === 1 ? 65_536 : encoded;
  if (!isSqlitePageSize(pageSize)) {
    throw new Error("Vault database page size is invalid.");
  }
  return pageSize;
}

function isSqlitePageSize(value: number): boolean {
  return value >= 512 && value <= 65_536 && (value & (value - 1)) === 0;
}

function updateWalChecksum(
  initial: WalChecksum,
  bytes: Buffer,
  offset: number,
  length: number,
  byteOrder: "big" | "little",
): WalChecksum {
  if (length % 8 !== 0) throw new Error("Vault WAL checksum input is invalid.");
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

function openRegularFile(path: string): OpenRegularFile {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Vault storage must be a regular file.");
  }
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error("Vault storage changed during schema inspection.");
    }
    return { descriptor, initial: opened, path };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertOpenFileStable(file: OpenRegularFile, expectedPrefix?: Buffer): void {
  const opened = fstatSync(file.descriptor, { bigint: true });
  const current = lstatSync(file.path, { bigint: true });
  if (
    !opened.isFile() ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameFileState(file.initial, opened) ||
    !sameFileIdentity(opened, current)
  ) {
    throw new Error("Vault storage changed during schema inspection.");
  }
  if (expectedPrefix) {
    const currentPrefix = readExactBuffer(
      file.descriptor,
      expectedPrefix.byteLength,
      0,
      "Vault database header is incomplete.",
    );
    if (!currentPrefix.equals(expectedPrefix)) {
      throw new Error("Vault storage changed during schema inspection.");
    }
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function readExactBuffer(
  descriptor: number,
  length: number,
  position: number,
  message: string,
): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  if (!readExactly(descriptor, bytes, 0, length, position)) {
    throw new Error(message);
  }
  return bytes;
}

function readExactly(
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): boolean {
  let total = 0;
  while (total < length) {
    const read = readSync(
      descriptor,
      buffer,
      offset + total,
      length - total,
      position + total,
    );
    if (read === 0) return false;
    total += read;
  }
  return true;
}
