export interface PackagedKeyStorageSmokeResult {
  architecture: "x64";
  envelopePersisted: true;
  envelopeSchemaVersion: 1;
  isPackaged: true;
  keyBytes: 32;
  knownPlaintextEncodingsAbsent: true;
  nonce: string;
  platform: "win32";
  providerId: "electron-safe-storage";
  roundTripMatched: true;
  safeStorageAsyncAvailable: true;
  schemaVersion: 2;
  shouldReEncrypt: boolean;
  status: "windows-key-envelope-round-trip-complete";
}

export const WINDOWS_KEY_STORAGE_BOUNDARY: Readonly<{
  proves: string;
  doesNotProve: string;
}>;

export function isPackagedKeyStorageSmokeResult(
  value: unknown,
  nonce: string,
): value is PackagedKeyStorageSmokeResult;

export function hasExactKeyStorageBoundary(value: unknown): boolean;
