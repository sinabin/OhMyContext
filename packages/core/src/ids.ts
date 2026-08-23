import { createHash } from "node:crypto";

export const HASH_ID_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Hashes length-delimited components so that `["ab", "c"]` cannot collide
 * with `["a", "bc"]`. The domain is part of the digest input.
 */
export function deterministicId(domain: string, ...components: string[]): string {
  const hash = createHash("sha256");
  for (const component of ["owncontext:v1", domain, ...components]) {
    const bytes = Buffer.from(component, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
  return hash.digest("hex");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function assertHashId(value: string, name: string): void {
  if (!HASH_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a 64-character lowercase SHA-256 ID`);
  }
}
