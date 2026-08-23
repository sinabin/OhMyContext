import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ElectronSafeStorageKeyProtector,
  MAX_VAULT_KEY_ENVELOPE_BYTES,
  VAULT_KEY_BYTES,
  VAULT_KEY_ENVELOPE_SCHEMA_VERSION,
  VAULT_KEY_PROVIDER_ID,
  createVaultKeyEnvelope,
  withVaultKeyFromEnvelope,
  type SafeStorageLike,
} from "./vault-key-envelope.js";

const KEY_STORAGE_SMOKE_ARGUMENT = "--owncontext-key-storage-smoke";
const ROOT_ENVIRONMENT_NAME = "OWNCONTEXT_KEY_STORAGE_SMOKE_ROOT";
const NONCE_ENVIRONMENT_NAME = "OWNCONTEXT_KEY_STORAGE_SMOKE_NONCE";
const RESULT_FILE_NAME = "key-storage-smoke.json";
const ENVELOPE_FILE_NAME = "vault-key-envelope.v1.json";
const MAX_RESULT_BYTES = 16 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface KeyStorageSmokeContext {
  readonly rootPath: string;
  readonly userDataPath: string;
  readonly envelopeDirectoryPath: string;
  readonly envelopePath: string;
  readonly resultPath: string;
  readonly nonce: string;
}

export interface KeyStorageSmokeResult {
  readonly schemaVersion: 2;
  readonly status: "windows-key-envelope-round-trip-complete";
  readonly nonce: string;
  readonly platform: "win32";
  readonly architecture: "x64";
  readonly isPackaged: boolean;
  readonly providerId: typeof VAULT_KEY_PROVIDER_ID;
  readonly safeStorageAsyncAvailable: true;
  readonly keyBytes: typeof VAULT_KEY_BYTES;
  readonly envelopeSchemaVersion: typeof VAULT_KEY_ENVELOPE_SCHEMA_VERSION;
  readonly envelopePersisted: true;
  readonly knownPlaintextEncodingsAbsent: true;
  readonly roundTripMatched: true;
  readonly shouldReEncrypt: boolean;
}

export interface PrepareKeyStorageSmokeOptions {
  argv?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  architecture?: string;
  temporaryDirectory?: string;
}

export class KeyStorageSmokeError extends Error {
  public constructor() {
    super("OwnContext packaged key-storage verification failed.");
    this.name = "KeyStorageSmokeError";
  }
}

export function prepareKeyStorageSmoke(
  options: PrepareKeyStorageSmokeOptions = {},
): KeyStorageSmokeContext | null {
  const argv = options.argv ?? process.argv;
  const occurrences = argv.filter(
    (argument) => argument === KEY_STORAGE_SMOKE_ARGUMENT,
  ).length;
  if (occurrences === 0) return null;

  try {
    if (
      occurrences !== 1 ||
      (options.platform ?? process.platform) !== "win32" ||
      (options.architecture ?? process.arch) !== "x64"
    ) {
      throw new Error("Unsupported smoke invocation.");
    }
    const environment = options.environment ?? process.env;
    const requestedRoot = environment[ROOT_ENVIRONMENT_NAME];
    const nonce = environment[NONCE_ENVIRONMENT_NAME];
    if (
      typeof requestedRoot !== "string" ||
      !isAbsolute(requestedRoot) ||
      typeof nonce !== "string" ||
      !UUID_PATTERN.test(nonce)
    ) {
      throw new Error("Invalid smoke boundary.");
    }

    const rootPath = resolve(requestedRoot);
    const temporaryRoot = realpathSync.native(
      resolve(options.temporaryDirectory ?? tmpdir()),
    );
    const rootMetadata = lstatSync(rootPath);
    if (
      rootMetadata.isSymbolicLink() ||
      !rootMetadata.isDirectory() ||
      normalizePath(realpathSync.native(rootPath)) !== normalizePath(rootPath) ||
      !isStrictDescendant(temporaryRoot, rootPath)
    ) {
      throw new Error("Invalid smoke root.");
    }

    const userDataPath = join(rootPath, "electron-user-data");
    const envelopeDirectoryPath = join(rootPath, "key-envelope-spike");
    mkdirSync(userDataPath, { mode: 0o700 });
    return Object.freeze({
      rootPath,
      userDataPath,
      envelopeDirectoryPath,
      envelopePath: join(envelopeDirectoryPath, ENVELOPE_FILE_NAME),
      resultPath: join(rootPath, RESULT_FILE_NAME),
      nonce,
    });
  } catch {
    throw new KeyStorageSmokeError();
  }
}

export async function runKeyStorageSmoke(
  context: KeyStorageSmokeContext,
  safeStorage: SafeStorageLike,
  isPackaged: boolean,
): Promise<KeyStorageSmokeResult> {
  let encodedKey: string | undefined;
  let createdDigest: Buffer | undefined;
  let openedDigest: Buffer | undefined;
  let vaultIdBytes: Buffer | undefined;
  const knownPlaintextRepresentations: Buffer[] = [];
  let wrappedKeyBytes: Buffer | undefined;
  try {
    mkdirSync(context.envelopeDirectoryPath, { mode: 0o700 });
    const protector = new ElectronSafeStorageKeyProtector(safeStorage);
    vaultIdBytes = randomBytes(32);
    const vaultId = vaultIdBytes.toString("hex");
    vaultIdBytes.fill(0);
    vaultIdBytes = undefined;

    const created = await createVaultKeyEnvelope(
      {
        envelopePath: context.envelopePath,
        vaultId,
        protector,
      },
      ({ key }) => {
        encodedKey = key.toString("base64");
        createdDigest = createHash("sha256").update(key).digest();
        return createdDigest;
      },
    );

    const envelopeText = await readBoundedFile(
      context.envelopePath,
      MAX_VAULT_KEY_ENVELOPE_BYTES,
    );
    if (!encodedKey || envelopeText.includes(encodedKey)) {
      throw new Error("Plaintext key appeared in the envelope.");
    }
    const envelope = JSON.parse(envelopeText) as unknown;
    if (
      !isObject(envelope) ||
      typeof envelope.wrappedKey !== "string" ||
      !isCanonicalBase64(envelope.wrappedKey)
    ) {
      throw new Error("Wrapped key evidence is invalid.");
    }
    knownPlaintextRepresentations.push(
      Buffer.from(encodedKey, "base64"),
      Buffer.from(encodedKey, "utf8"),
      Buffer.from(encodedKey, "utf16le"),
      encodeUtf16BigEndian(encodedKey),
      encodeUtf32(encodedKey, "little"),
      encodeUtf32(encodedKey, "big"),
    );
    wrappedKeyBytes = Buffer.from(envelope.wrappedKey, "base64");
    if (knownPlaintextRepresentations.some((value) => wrappedKeyBytes?.includes(value))) {
      throw new Error("Unprotected key material appeared in the envelope.");
    }

    const opened = await withVaultKeyFromEnvelope(
      {
        envelopePath: context.envelopePath,
        vaultId,
        protector,
      },
      ({ key, keyId }) => {
        if (keyId !== created.keyId) throw new Error("Key identity changed.");
        openedDigest = createHash("sha256").update(key).digest();
        return openedDigest;
      },
    );
    if (
      !createdDigest ||
      !openedDigest ||
      createdDigest.byteLength !== openedDigest.byteLength ||
      !timingSafeEqual(createdDigest, openedDigest)
    ) {
      throw new Error("Recovered key did not match.");
    }

    const result: KeyStorageSmokeResult = Object.freeze({
      schemaVersion: 2,
      status: "windows-key-envelope-round-trip-complete",
      nonce: context.nonce,
      platform: "win32",
      architecture: "x64",
      isPackaged,
      providerId: VAULT_KEY_PROVIDER_ID,
      safeStorageAsyncAvailable: true,
      keyBytes: VAULT_KEY_BYTES,
      envelopeSchemaVersion: VAULT_KEY_ENVELOPE_SCHEMA_VERSION,
      envelopePersisted: true,
      knownPlaintextEncodingsAbsent: true,
      roundTripMatched: true,
      shouldReEncrypt: opened.shouldReEncrypt,
    });
    await writeExclusiveResult(context.resultPath, result);
    return result;
  } catch {
    throw new KeyStorageSmokeError();
  } finally {
    vaultIdBytes?.fill(0);
    createdDigest?.fill(0);
    openedDigest?.fill(0);
    for (const representation of knownPlaintextRepresentations) {
      representation.fill(0);
    }
    wrappedKeyBytes?.fill(0);
    // Electron safeStorage accepts a JavaScript string. Clearing our reference
    // is best effort; the engine cannot guarantee deterministic string erasure.
    encodedKey = undefined;
  }
}

function encodeUtf16BigEndian(value: string): Buffer {
  const bytes = Buffer.from(value, "utf16le");
  return bytes.swap16();
}

function encodeUtf32(value: string, byteOrder: "little" | "big"): Buffer {
  const bytes = Buffer.allocUnsafe(value.length * 4);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (byteOrder === "little") bytes.writeUInt32LE(codeUnit, index * 4);
    else bytes.writeUInt32BE(codeUnit, index * 4);
  }
  return bytes;
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error("Smoke file is outside its bound.");
  }
  return bytes.toString("utf8");
}

async function writeExclusiveResult(
  path: string,
  result: KeyStorageSmokeResult,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new Error("Smoke result is outside its bound.");
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isStrictDescendant(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference);
}

function normalizePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
