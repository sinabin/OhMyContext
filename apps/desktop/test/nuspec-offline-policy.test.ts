import { describe, expect, it } from "vitest";
import { assertOfflineNuspecMetadata } from "../scripts/nuspec-offline-policy.mjs";

const namespace = "http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd";

function packageXml(metadata: string): string {
  return `<?xml version="1.0"?><package xmlns="${namespace}"><metadata>${metadata}</metadata></package>`;
}

describe("Squirrel NuSpec offline policy", () => {
  it("accepts repository-owned metadata with only the exact NuSpec namespace URL", () => {
    expect(() => assertOfflineNuspecMetadata(packageXml(
      "<id>OwnContextDeveloperPreview</id><version>0.0.0</version>",
    ))).not.toThrow();
  });

  it("rejects iconUrl by expanded local name even when namespace-prefixed", () => {
    const malicious = `<?xml version="1.0"?><package xmlns="${namespace}" xmlns:n="${namespace}"><metadata><n:iconUrl>${namespace}/icon.ico</n:iconUrl></metadata></package>`;
    expect(() => assertOfflineNuspecMetadata(malicious)).toThrow(
      "external icon download",
    );
  });

  it("rejects a URL that merely begins with the allowed namespace", () => {
    expect(() => assertOfflineNuspecMetadata(packageXml(
      `<repository url="${namespace}/attacker" />`,
    ))).toThrow("external URL");
  });

  it("rejects entity-obfuscated URLs and document type declarations", () => {
    expect(() => assertOfflineNuspecMetadata(packageXml(
      "<repository url=\"&#x68;ttps://example.invalid/repo\" />",
    ))).toThrow("external URL");
    expect(() => assertOfflineNuspecMetadata(
      `<!DOCTYPE package [<!ENTITY remote "https://example.invalid/icon">]>${packageXml("<id>&remote;</id>")}`,
    )).toThrow("metadata is invalid");
  });
});
