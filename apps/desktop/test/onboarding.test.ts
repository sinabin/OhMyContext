import { describe, expect, it } from "vitest";
import { deriveLibraryOnboarding } from "../src/renderer/onboarding.js";

describe("desktop first-run onboarding state", () => {
  it("offers the safe sample before any document exists", () => {
    expect(deriveLibraryOnboarding({
      documentCount: 0,
      resultCount: 0,
      hasSearched: false,
      hasManagedConnection: false,
    })).toEqual({
      emptyState: "first-run",
      canContinueToConnections: false,
      aiConfigurationSaved: false,
    });
  });

  it("distinguishes ready-to-search from a completed zero-result search", () => {
    expect(deriveLibraryOnboarding({
      documentCount: 2,
      resultCount: 0,
      hasSearched: false,
      hasManagedConnection: false,
    }).emptyState).toBe("ready-to-search");

    expect(deriveLibraryOnboarding({
      documentCount: 2,
      resultCount: 0,
      hasSearched: true,
      hasManagedConnection: false,
    }).emptyState).toBe("no-results");
  });

  it("opens the connections step after import without claiming a live connection", () => {
    expect(deriveLibraryOnboarding({
      documentCount: 2,
      resultCount: 1,
      hasSearched: true,
      hasManagedConnection: true,
    })).toEqual({
      emptyState: "has-results",
      canContinueToConnections: true,
      aiConfigurationSaved: true,
    });
  });

  it("rejects invalid counts instead of inventing progress", () => {
    expect(() => deriveLibraryOnboarding({
      documentCount: -1,
      resultCount: 0,
      hasSearched: false,
      hasManagedConnection: false,
    })).toThrow("non-negative integers");
  });
});
