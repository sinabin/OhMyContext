import { describe, expect, it } from "vitest";
import { resolveReleaseProfile } from "../scripts/release-profile.mjs";

describe("release profile boundary", () => {
  it("defaults to the unsigned developer alpha", () => {
    const profile = resolveReleaseProfile({});
    expect(profile.publicRelease).toBe(false);
    expect(profile.setupExe).toBe("OwnContext-Developer-Preview-Unsigned-Setup.exe");
    expect(profile.signing).toBeUndefined();
  });

  it("rejects a public profile without every signing and update input", () => {
    expect(() => resolveReleaseProfile({ OWNCONTEXT_RELEASE_PROFILE: "public" })).toThrow(
      /OWNCONTEXT_RELEASE_VERSION/u,
    );
  });

  it("keeps public signing secrets environment-only", () => {
    const profile = resolveReleaseProfile({
      OWNCONTEXT_RELEASE_PROFILE: "public",
      OWNCONTEXT_RELEASE_VERSION: "0.1.0",
      OWNCONTEXT_SIGNING_CERTIFICATE_FILE: "C:\\secure\\owncontext.pfx",
      OWNCONTEXT_SIGNING_CERTIFICATE_PASSWORD: "secret-not-serialized",
      OWNCONTEXT_TIMESTAMP_SERVER: "https://timestamp.example.test",
      OWNCONTEXT_UPDATE_URL: "https://downloads.example.test/owncontext/RELEASES",
      OWNCONTEXT_SIGNING_WEBSITE: "https://nexth.co.kr/owncontext",
    });

    expect(profile.publicRelease).toBe(true);
    expect(profile.signing).toMatchObject({
      certificateFile: "C:\\secure\\owncontext.pfx",
      timestampServer: "https://timestamp.example.test",
      website: "https://nexth.co.kr/owncontext",
    });
    expect(JSON.stringify(profile)).not.toContain("secret-not-serialized");
  });
});
