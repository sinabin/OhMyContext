import { describe, expect, it } from "vitest";
import { isTrustedIpcSender } from "../src/electron/ipc-trust.js";

const trusted = {
  trustedWebContentsId: 7,
  senderWebContentsId: 7,
  isMainFrame: true,
  senderUrl: "file:///C:/OwnContext/renderer/index.html",
  expectedUrl: "file:///C:/OwnContext/renderer/index.html",
};

describe("desktop IPC sender boundary", () => {
  it("accepts only the pinned local main frame", () => {
    expect(isTrustedIpcSender(trusted)).toBe(true);
  });

  it.each([
    { trustedWebContentsId: undefined },
    { senderWebContentsId: 8 },
    { isMainFrame: false },
    { senderUrl: "https://example.invalid/hostile" },
  ])("rejects mismatched sender evidence: %o", (change) => {
    expect(isTrustedIpcSender({ ...trusted, ...change })).toBe(false);
  });
});
