export const WINDOWS_KEY_STORAGE_BOUNDARY = Object.freeze({
  proves:
    "The packaged Windows x64 Electron main process exclusively persisted and reopened a synthetic 32-byte key through async safeStorage, with tested direct raw and UTF plaintext encodings absent from the wrapped payload.",
  doesNotProve:
    "Independent DPAPI use, resistance to arbitrary reversible wrappers, another Windows account, the real SQLite vault, FTS, WAL, temporary files, AI-client configuration backups, migration, installer lifecycle, or public release is encrypted or approved.",
});

export function isPackagedKeyStorageSmokeResult(value, nonce) {
  return isObject(value) &&
    hasExactKeys(value, [
      "architecture",
      "envelopePersisted",
      "envelopeSchemaVersion",
      "isPackaged",
      "keyBytes",
      "knownPlaintextEncodingsAbsent",
      "nonce",
      "platform",
      "providerId",
      "roundTripMatched",
      "safeStorageAsyncAvailable",
      "schemaVersion",
      "shouldReEncrypt",
      "status",
    ]) &&
    value.schemaVersion === 2 &&
    value.status === "windows-key-envelope-round-trip-complete" &&
    value.nonce === nonce &&
    value.platform === "win32" &&
    value.architecture === "x64" &&
    value.isPackaged === true &&
    value.providerId === "electron-safe-storage" &&
    value.safeStorageAsyncAvailable === true &&
    value.keyBytes === 32 &&
    value.envelopeSchemaVersion === 1 &&
    value.envelopePersisted === true &&
    value.knownPlaintextEncodingsAbsent === true &&
    value.roundTripMatched === true &&
    typeof value.shouldReEncrypt === "boolean";
}

export function hasExactKeyStorageBoundary(value) {
  return isObject(value) &&
    hasExactKeys(value, ["doesNotProve", "proves"]) &&
    value.proves === WINDOWS_KEY_STORAGE_BOUNDARY.proves &&
    value.doesNotProve === WINDOWS_KEY_STORAGE_BOUNDARY.doesNotProve;
}

function hasExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
