import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const VAULT_KEY_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const VAULT_KEY_PROVIDER_ID = "electron-safe-storage" as const;
export const VAULT_KEY_BYTES = 32 as const;
export const MAX_VAULT_KEY_ENVELOPE_BYTES = 16 * 1024;

const MAX_WRAPPED_KEY_BYTES = 8 * 1024;
const HEX_256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
let temporaryFileCounter = 0;

export type VaultKeyEnvelopeErrorCode =
  | "ALREADY_EXISTS"
  | "CORRUPT"
  | "MISSING"
  | "OVERSIZE"
  | "PERSIST_FAILED"
  | "PROTECT_FAILED"
  | "PROTECTOR_UNAVAILABLE"
  | "UNKNOWN_ENVELOPE"
  | "UNPROTECT_FAILED";

const ERROR_MESSAGES: Readonly<Record<VaultKeyEnvelopeErrorCode, string>> = {
  ALREADY_EXISTS: "Vault key envelope already exists.",
  CORRUPT: "Vault key envelope is invalid.",
  MISSING: "Vault key envelope is missing.",
  OVERSIZE: "Vault key envelope exceeds the size limit.",
  PERSIST_FAILED: "Vault key envelope could not be persisted.",
  PROTECT_FAILED: "Vault key protection failed.",
  PROTECTOR_UNAVAILABLE: "Vault key protection is unavailable.",
  UNKNOWN_ENVELOPE: "Vault key envelope is not supported.",
  UNPROTECT_FAILED: "Vault key recovery failed.",
};

export class VaultKeyEnvelopeError extends Error {
  readonly code: VaultKeyEnvelopeErrorCode;

  constructor(code: VaultKeyEnvelopeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "VaultKeyEnvelopeError";
    this.code = code;
  }
}

export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }>;
}

export interface UnprotectedVaultKey {
  key: Buffer;
  shouldReEncrypt: boolean;
}

export abstract class VaultKeyProtector {
  abstract readonly providerId: typeof VAULT_KEY_PROVIDER_ID;
  abstract isAvailable(): Promise<boolean>;
  abstract protect(key: Buffer): Promise<Buffer>;
  abstract unprotect(wrappedKey: Buffer): Promise<UnprotectedVaultKey>;
}

/**
 * Main-process adapter for Electron's async safeStorage API.
 *
 * The safeStorage object is injected so this module cannot import Electron and
 * can be tested without loading an Electron process.
 */
export class ElectronSafeStorageKeyProtector extends VaultKeyProtector {
  readonly providerId = VAULT_KEY_PROVIDER_ID;

  constructor(private readonly safeStorage: SafeStorageLike) {
    super();
  }

  async isAvailable(): Promise<boolean> {
    return this.safeStorage.isAsyncEncryptionAvailable();
  }

  async protect(key: Buffer): Promise<Buffer> {
    if (!Buffer.isBuffer(key) || key.byteLength !== VAULT_KEY_BYTES) {
      throw new Error("Invalid key.");
    }

    // safeStorage accepts strings. The Buffer is still zeroized by the caller;
    // the transient JavaScript string cannot be deterministically zeroized.
    return this.safeStorage.encryptStringAsync(key.toString("base64"));
  }

  async unprotect(wrappedKey: Buffer): Promise<UnprotectedVaultKey> {
    const decrypted = await this.safeStorage.decryptStringAsync(wrappedKey);
    if (
      typeof decrypted !== "object" ||
      decrypted === null ||
      typeof decrypted.result !== "string" ||
      typeof decrypted.shouldReEncrypt !== "boolean" ||
      !isCanonicalBase64(decrypted.result)
    ) {
      throw new Error("Invalid protected key.");
    }

    const key = Buffer.from(decrypted.result, "base64");
    if (key.byteLength !== VAULT_KEY_BYTES) {
      key.fill(0);
      throw new Error("Invalid protected key.");
    }

    return { key, shouldReEncrypt: decrypted.shouldReEncrypt };
  }
}

export interface VaultKeyCallbackValue {
  /** This Buffer is zeroized as soon as the callback settles. */
  key: Buffer;
  keyId: string;
}

export interface CreateVaultKeyEnvelopeOptions {
  envelopePath: string;
  vaultId: string;
  protector: VaultKeyProtector;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export interface CreateVaultKeyEnvelopeResult<T> {
  keyId: string;
  value: T;
}

export interface OpenVaultKeyEnvelopeOptions {
  envelopePath: string;
  vaultId: string;
  protector: VaultKeyProtector;
}

export interface OpenVaultKeyEnvelopeResult<T> {
  createdAt: string;
  keyId: string;
  shouldReEncrypt: boolean;
  value: T;
}

interface VaultKeyEnvelopeV1 {
  schemaVersion: typeof VAULT_KEY_ENVELOPE_SCHEMA_VERSION;
  vaultId: string;
  keyId: string;
  provider: typeof VAULT_KEY_PROVIDER_ID;
  wrappedKey: string;
  createdAt: string;
}

export async function createVaultKeyEnvelope<T>(
  options: CreateVaultKeyEnvelopeOptions,
  useKey: (value: VaultKeyCallbackValue) => T | Promise<T>,
): Promise<CreateVaultKeyEnvelopeResult<T>> {
  assertCanonicalIdentifier(options.vaultId);
  assertProtectorProvider(options.protector);
  assertNewEnvelopeTarget(options.envelopePath);
  await assertProtectorAvailable(options.protector);

  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  let key: Buffer | undefined;
  let keyIdBytes: Buffer | undefined;

  try {
    let generatedKey: Buffer;
    try {
      generatedKey = randomBytes(VAULT_KEY_BYTES);
    } catch {
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }
    if (!Buffer.isBuffer(generatedKey) || generatedKey.byteLength !== VAULT_KEY_BYTES) {
      if (Buffer.isBuffer(generatedKey)) generatedKey.fill(0);
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }
    key = generatedKey;

    try {
      keyIdBytes = randomBytes(VAULT_KEY_BYTES);
    } catch {
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }
    if (!Buffer.isBuffer(keyIdBytes) || keyIdBytes.byteLength !== VAULT_KEY_BYTES) {
      if (Buffer.isBuffer(keyIdBytes)) keyIdBytes.fill(0);
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }
    const keyId = keyIdBytes.toString("hex");

    let wrappedKey: Buffer;
    try {
      wrappedKey = await options.protector.protect(key);
    } catch {
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }
    if (
      !Buffer.isBuffer(wrappedKey) ||
      wrappedKey.byteLength === 0 ||
      wrappedKey.byteLength > MAX_WRAPPED_KEY_BYTES
    ) {
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }

    let createdAt: string;
    try {
      createdAt = canonicalTimestamp(options.now?.() ?? new Date());
    } catch {
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }
    const envelope: VaultKeyEnvelopeV1 = {
      schemaVersion: VAULT_KEY_ENVELOPE_SCHEMA_VERSION,
      vaultId: options.vaultId,
      keyId,
      provider: VAULT_KEY_PROVIDER_ID,
      wrappedKey: wrappedKey.toString("base64"),
      createdAt,
    };
    const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
    if (serialized.byteLength > MAX_VAULT_KEY_ENVELOPE_BYTES) {
      throw new VaultKeyEnvelopeError("PROTECT_FAILED");
    }

    persistExclusiveAtomic(options.envelopePath, serialized);
    const value = await useKey({ key, keyId });
    return { keyId, value };
  } finally {
    key?.fill(0);
    keyIdBytes?.fill(0);
  }
}

export async function withVaultKeyFromEnvelope<T>(
  options: OpenVaultKeyEnvelopeOptions,
  useKey: (value: VaultKeyCallbackValue) => T | Promise<T>,
): Promise<OpenVaultKeyEnvelopeResult<T>> {
  assertCanonicalIdentifier(options.vaultId);
  assertProtectorProvider(options.protector);
  const envelope = readCanonicalEnvelope(options.envelopePath);
  if (envelope.vaultId !== options.vaultId) {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }
  await assertProtectorAvailable(options.protector);

  const wrappedKey = Buffer.from(envelope.wrappedKey, "base64");
  let unprotected: UnprotectedVaultKey | undefined;
  try {
    try {
      unprotected = await options.protector.unprotect(wrappedKey);
      if (
        typeof unprotected !== "object" ||
        unprotected === null ||
        !Buffer.isBuffer(unprotected.key) ||
        unprotected.key.byteLength !== VAULT_KEY_BYTES ||
        typeof unprotected.shouldReEncrypt !== "boolean"
      ) {
        throw new Error("Invalid recovered key.");
      }
    } catch {
      if (Buffer.isBuffer(unprotected?.key)) unprotected.key.fill(0);
      throw new VaultKeyEnvelopeError("UNPROTECT_FAILED");
    }

    const value = await useKey({ key: unprotected.key, keyId: envelope.keyId });
    return {
      createdAt: envelope.createdAt,
      keyId: envelope.keyId,
      shouldReEncrypt: unprotected.shouldReEncrypt,
      value,
    };
  } finally {
    if (Buffer.isBuffer(unprotected?.key)) unprotected.key.fill(0);
  }
}

function assertCanonicalIdentifier(value: string): void {
  if (typeof value !== "string" || !HEX_256_PATTERN.test(value)) {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }
}

function assertProtectorProvider(protector: VaultKeyProtector): void {
  if (protector?.providerId !== VAULT_KEY_PROVIDER_ID) {
    throw new VaultKeyEnvelopeError("UNKNOWN_ENVELOPE");
  }
}

async function assertProtectorAvailable(protector: VaultKeyProtector): Promise<void> {
  let available = false;
  try {
    available = (await protector.isAvailable()) === true;
  } catch {
    // The outward error deliberately carries no provider or platform details.
  }
  if (!available) {
    throw new VaultKeyEnvelopeError("PROTECTOR_UNAVAILABLE");
  }
}

function canonicalTimestamp(value: Date): string {
  try {
    const timestamp = value.toISOString();
    if (new Date(timestamp).toISOString() !== timestamp) throw new Error("Invalid date.");
    return timestamp;
  } catch {
    throw new VaultKeyEnvelopeError("PROTECT_FAILED");
  }
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_WRAPPED_KEY_BYTES / 3) * 4 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength <= MAX_WRAPPED_KEY_BYTES && decoded.toString("base64") === value;
}

function readCanonicalEnvelope(envelopePath: string): VaultKeyEnvelopeV1 {
  const absolutePath = checkedAbsolutePath(envelopePath);
  const parent = dirname(absolutePath);
  assertRealDirectory(parent, "CORRUPT");

  let descriptor: number | undefined;
  try {
    let pathStat;
    try {
      pathStat = lstatSync(absolutePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) throw new VaultKeyEnvelopeError("MISSING");
      throw new VaultKeyEnvelopeError("CORRUPT");
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new VaultKeyEnvelopeError("CORRUPT");
    }
    if (pathStat.size > MAX_VAULT_KEY_ENVELOPE_BYTES) {
      throw new VaultKeyEnvelopeError("OVERSIZE");
    }

    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.size !== pathStat.size ||
      (pathStat.ino !== 0 && openedStat.ino !== pathStat.ino) ||
      (pathStat.dev !== 0 && openedStat.dev !== pathStat.dev)
    ) {
      throw new VaultKeyEnvelopeError("CORRUPT");
    }
    if (openedStat.size > MAX_VAULT_KEY_ENVELOPE_BYTES) {
      throw new VaultKeyEnvelopeError("OVERSIZE");
    }

    const bytes = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new VaultKeyEnvelopeError("CORRUPT");
      offset += count;
    }
    if (fstatSync(descriptor).size !== openedStat.size) {
      throw new VaultKeyEnvelopeError("CORRUPT");
    }
    return parseCanonicalEnvelope(bytes);
  } catch (error) {
    if (error instanceof VaultKeyEnvelopeError) throw error;
    throw new VaultKeyEnvelopeError("CORRUPT");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Never replace the bounded outward result with a filesystem detail.
      }
    }
  }
}

function parseCanonicalEnvelope(bytes: Buffer): VaultKeyEnvelopeV1 {
  let text: string;
  let parsed: unknown;
  try {
    text = utf8Decoder.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== VAULT_KEY_ENVELOPE_SCHEMA_VERSION) {
    throw new VaultKeyEnvelopeError("UNKNOWN_ENVELOPE");
  }
  if (candidate.provider !== VAULT_KEY_PROVIDER_ID) {
    throw new VaultKeyEnvelopeError("UNKNOWN_ENVELOPE");
  }
  if (
    typeof candidate.vaultId !== "string" ||
    typeof candidate.keyId !== "string" ||
    typeof candidate.wrappedKey !== "string" ||
    typeof candidate.createdAt !== "string" ||
    !HEX_256_PATTERN.test(candidate.vaultId) ||
    !HEX_256_PATTERN.test(candidate.keyId) ||
    !isCanonicalBase64(candidate.wrappedKey) ||
    !isCanonicalIsoTimestamp(candidate.createdAt)
  ) {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }

  const canonical: VaultKeyEnvelopeV1 = {
    schemaVersion: VAULT_KEY_ENVELOPE_SCHEMA_VERSION,
    vaultId: candidate.vaultId,
    keyId: candidate.keyId,
    provider: VAULT_KEY_PROVIDER_ID,
    wrappedKey: candidate.wrappedKey,
    createdAt: candidate.createdAt,
  };
  if (JSON.stringify(canonical) !== text) {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }
  return canonical;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  try {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertNewEnvelopeTarget(envelopePath: string): void {
  const absolutePath = checkedAbsolutePath(envelopePath);
  assertRealDirectory(dirname(absolutePath), "PERSIST_FAILED");
  try {
    lstatSync(absolutePath);
    throw new VaultKeyEnvelopeError("ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof VaultKeyEnvelopeError) throw error;
    if (!hasErrorCode(error, "ENOENT")) {
      throw new VaultKeyEnvelopeError("PERSIST_FAILED");
    }
  }
}

function persistExclusiveAtomic(envelopePath: string, bytes: Buffer): void {
  const absolutePath = checkedAbsolutePath(envelopePath);
  const parent = dirname(absolutePath);
  assertRealDirectory(parent, "PERSIST_FAILED");
  const temporaryPath = join(
    parent,
    `.vault-key-envelope-${process.pid}-${Date.now()}-${temporaryFileCounter++}.tmp`,
  );
  let descriptor: number | undefined;
  let linked = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("Short envelope write.");
      offset += count;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    // A same-directory hard link publishes the fully flushed inode atomically,
    // and unlike rename it fails if any file, directory, or symlink is present.
    linkSync(temporaryPath, absolutePath);
    linked = true;
    unlinkSync(temporaryPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the bounded outward error below.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file might not have been created or may already be gone.
    }
    if (!linked && hasErrorCode(error, "EEXIST")) {
      throw new VaultKeyEnvelopeError("ALREADY_EXISTS");
    }
    throw new VaultKeyEnvelopeError("PERSIST_FAILED");
  }
}

function checkedAbsolutePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new VaultKeyEnvelopeError("CORRUPT");
  }
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function assertRealDirectory(
  directoryPath: string,
  failureCode: "CORRUPT" | "PERSIST_FAILED",
): void {
  try {
    const stat = lstatSync(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new VaultKeyEnvelopeError(failureCode);
    }
    const real = realpathSync.native(directoryPath);
    const expected = resolve(directoryPath);
    const normalizedReal = process.platform === "win32" ? real.toLowerCase() : real;
    const normalizedExpected = process.platform === "win32" ? expected.toLowerCase() : expected;
    if (normalizedReal !== normalizedExpected) {
      throw new VaultKeyEnvelopeError(failureCode);
    }
  } catch (error) {
    if (error instanceof VaultKeyEnvelopeError) throw error;
    throw new VaultKeyEnvelopeError(failureCode);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
