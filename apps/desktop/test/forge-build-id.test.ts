import { describe, expect, it } from "vitest";
import {
  createForgeBuildIdentifier,
  resolveForgeBuildIdentifier,
  validateForgeBuildIdentifier,
} from "../scripts/forge-build-id.mjs";

describe("Forge build identifier", () => {
  it("creates a stable filesystem-safe identifier", () => {
    expect(
      createForgeBuildIdentifier(new Date("2026-08-23T06:12:34.567Z"), 42),
    ).toBe("unsigned-2026-08-23T06-12-34-567Z-42");
  });

  it("uses the explicitly supplied orchestration identifier", () => {
    expect(
      resolveForgeBuildIdentifier({
        OWNCONTEXT_FORGE_BUILD_ID: "unsigned-integration-123",
      }),
    ).toBe("unsigned-integration-123");
  });

  it.each([
    "",
    "release-build",
    "unsigned-../escape",
    "unsigned-with.dot",
    "unsigned-trailing-",
  ])("rejects unsafe identifier %j", (candidate) => {
    expect(() => validateForgeBuildIdentifier(candidate)).toThrow(
      /OWNCONTEXT_FORGE_BUILD_ID/u,
    );
  });
});
