import { describe, expect, it } from "vitest";
import {
  DIRECTORY_IMPORT_TOKEN_TTL_MS,
  DirectoryImportTokenManager,
  isValidDirectoryImportToken,
  renderImportResult,
} from "../src/electron/directory-import-preflight.js";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

describe("directory import preflight token manager", () => {
  it("binds one opaque prepared import to the issuing renderer", () => {
    const prepared = { identity: "core-owned" };
    const manager = new DirectoryImportTokenManager({ createToken: () => TOKEN_A });
    const token = manager.issue(7, prepared, 1_000);

    expect(token).toBe(TOKEN_A);
    expect(manager.takeForConfirmation(token, 7, 1_001)).toEqual({
      status: "ready",
      prepared,
    });
  });

  it("collapses malformed, unknown, and wrong-sender tokens into invalid", () => {
    const manager = new DirectoryImportTokenManager({ createToken: () => TOKEN_A });
    manager.issue(7, { identity: "prepared" }, 1_000);

    expect(isValidDirectoryImportToken("short")).toBe(false);
    expect(manager.takeForConfirmation("short", 7, 1_001)).toEqual({ status: "invalid" });
    expect(manager.takeForConfirmation("Z".repeat(43), 7, 1_001)).toEqual({ status: "invalid" });
    expect(manager.takeForConfirmation(TOKEN_A, 8, 1_001)).toEqual({ status: "invalid" });
    expect(manager.takeForConfirmation(TOKEN_A, 7, 1_001).status).toBe("ready");
  });

  it("expires a token at five minutes and never returns its prepared object", () => {
    const prepared = { identity: "must-stay-private" };
    const released: object[] = [];
    const manager = new DirectoryImportTokenManager<object>({
      createToken: () => TOKEN_A,
      onPreparedReleased: (value) => released.push(value),
    });
    manager.issue(3, prepared, 10);
    manager.expireIfDue(TOKEN_A, 10 + DIRECTORY_IMPORT_TOKEN_TTL_MS);
    expect(manager.takeForConfirmation(
      TOKEN_A,
      3,
      10 + DIRECTORY_IMPORT_TOKEN_TTL_MS,
    )).toEqual({ status: "expired" });
    expect(released).toEqual([prepared]);
  });

  it("rejects confirmation replay after an import starts or completes", () => {
    const prepared = { identity: "prepared" };
    const released: object[] = [];
    const manager = new DirectoryImportTokenManager<object>({
      createToken: () => TOKEN_A,
      onPreparedReleased: (value) => released.push(value),
    });
    manager.issue(4, prepared, 20);
    expect(manager.takeForConfirmation(TOKEN_A, 4, 21).status).toBe("ready");
    expect(manager.takeForConfirmation(TOKEN_A, 4, 22)).toEqual({ status: "imported" });
    manager.markImported(TOKEN_A);
    expect(manager.takeForConfirmation(TOKEN_A, 4, 23)).toEqual({ status: "imported" });
    expect(released).toEqual([prepared]);
  });

  it("purges an earlier prepared scan when the same renderer starts a new one", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const first = { identity: "first" };
    const released: object[] = [];
    const manager = new DirectoryImportTokenManager<object>({
      createToken: () => tokens.shift()!,
      onPreparedReleased: (value) => released.push(value),
    });
    manager.issue(5, first, 100);
    manager.issue(5, { identity: "second" }, 101);

    expect(manager.takeForConfirmation(TOKEN_A, 5, 102)).toEqual({ status: "aborted" });
    expect(manager.takeForConfirmation(TOKEN_B, 5, 102).status).toBe("ready");
    expect(released).toEqual([first]);
  });

  it("cancels a pending token and invalidates all pending tokens on window close", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const first = { identity: "first" };
    const second = { identity: "second" };
    const released: object[] = [];
    const manager = new DirectoryImportTokenManager<object>({
      createToken: () => tokens.shift()!,
      onPreparedReleased: (value) => released.push(value),
    });
    manager.issue(11, first, 200);
    expect(manager.cancel(TOKEN_A, 11, 201)).toEqual({ status: "aborted" });
    expect(manager.takeForConfirmation(TOKEN_A, 11, 202)).toEqual({ status: "aborted" });

    manager.issue(12, second, 203);
    manager.abortPendingForSender(12, 204);
    expect(manager.takeForConfirmation(TOKEN_B, 12, 205)).toEqual({ status: "aborted" });
    expect(released).toEqual([first, second]);
  });

  it("reports a stale core scan as a terminal structured status", () => {
    const manager = new DirectoryImportTokenManager({ createToken: () => TOKEN_A });
    manager.issue(9, { identity: "prepared" }, 300);
    expect(manager.takeForConfirmation(TOKEN_A, 9, 301).status).toBe("ready");
    manager.markStale(TOKEN_A);
    expect(manager.takeForConfirmation(TOKEN_A, 9, 302)).toEqual({ status: "stale-scan" });
  });
});

describe("renderer-safe import result", () => {
  it("keeps exact counts, bounds issues, and omits document/source metadata", () => {
    const result = renderImportResult({
      scanned: 12,
      imported: 2,
      updated: 1,
      unchanged: 4,
      skipped: 5,
      issues: Array.from({ length: 10 }, (_value, index) => ({
        code: "invalid-utf8",
        path: `relative-${index}.md`,
        message: "Only valid UTF-8 is accepted",
      })),
    });

    expect(result).toMatchObject({
      scanned: 12,
      imported: 2,
      updated: 1,
      unchanged: 4,
      skipped: 5,
      truncatedIssueCount: 2,
    });
    expect(result.issueExamples).toHaveLength(8);
    expect(JSON.stringify(result)).not.toContain("documentId");
    expect(JSON.stringify(result)).not.toContain("sourceUri");
  });

  it.each([
    "C:\\Users\\person\\secret.md",
    "\\\\server\\share\\secret.md",
    "/home/person/secret.md",
    "../secret.md",
    "notes/../../secret.md",
  ])("fails closed instead of exposing an unsafe issue path: %s", (path) => {
    const [issue] = renderImportResult({
      scanned: 1,
      imported: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      issues: [{ code: "read-error", path, message: `raw OS failure at ${path}` }],
    }).issueExamples;

    expect(issue).toEqual({
      code: "read-error",
      path: "(unavailable)",
      message: "The file could not be read safely.",
    });
    expect(JSON.stringify(issue)).not.toContain("raw OS failure");
  });

  it("retains a safe relative path but replaces raw error text with fixed product copy", () => {
    const [issue] = renderImportResult({
      scanned: 1,
      imported: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      issues: [{
        code: "invalid-utf8",
        path: "notes/private.md",
        message: "EACCES C:\\Users\\person\\private.md",
      }],
    }).issueExamples;

    expect(issue).toEqual({
      code: "invalid-utf8",
      path: "notes/private.md",
      message: "Only valid UTF-8 .md and .txt files are supported.",
    });
  });

  it("preserves a hard-link classification with fixed renderer copy", () => {
    const [issue] = renderImportResult({
      scanned: 1,
      imported: 0,
      updated: 0,
      unchanged: 0,
      skipped: 1,
      issues: [{
        code: "hardlink",
        path: "notes/alias.md",
        message: "outside target was C:\\Users\\person\\private.md",
      }],
    }).issueExamples;

    expect(issue).toEqual({
      code: "hardlink",
      path: "notes/alias.md",
      message: "Files with multiple hard links are not imported.",
    });
  });
});
