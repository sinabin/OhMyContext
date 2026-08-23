import { describe, expect, it } from "vitest";
import { isPackagedKeyStorageSmokeResult } from "../../../scripts/key-storage-evidence-policy.mjs";

const nonce = "94f2e89d-4f80-4204-9ee3-1c991134acb6";

function validResult(): Record<string, unknown> {
  return {
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
    shouldReEncrypt: false,
  };
}

describe("packaged key-storage result policy", () => {
  it("accepts the exact producer schema independent of object key order", () => {
    const reordered = Object.fromEntries(Object.entries(validResult()).reverse());

    expect(isPackagedKeyStorageSmokeResult(reordered, nonce)).toBe(true);
  });

  it("rejects missing, extra, or mismatched evidence fields", () => {
    const missing = validResult();
    delete missing.knownPlaintextEncodingsAbsent;
    const extra = { ...validResult(), claim: "fully encrypted" };
    const mismatched = { ...validResult(), nonce: "different" };

    expect(isPackagedKeyStorageSmokeResult(missing, nonce)).toBe(false);
    expect(isPackagedKeyStorageSmokeResult(extra, nonce)).toBe(false);
    expect(isPackagedKeyStorageSmokeResult(mismatched, nonce)).toBe(false);
  });
});
