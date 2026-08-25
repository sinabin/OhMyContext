import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareGuiSmoke,
  runGuiSmokeJourney,
  writeGuiSmokeSuccess,
  type GuiSmokeRenderer,
} from "../src/electron/gui-smoke.js";

const nonce = "12345678-1234-4123-8123-123456789abc";

describe("packaged GUI first-run smoke contract", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts bounded content-free evidence from the renderer journey", async () => {
    const renderer: GuiSmokeRenderer = {
      executeJavaScript: vi.fn(async (_script: string, _userGesture?: boolean) => ({
        sampleSourceReady: true,
        sampleSourceLabel: "OhMyContext Sample Library",
        suggestedQuery: "weekly review",
        sampleProvenanceVerified: true,
        resultCardCount: 1,
        connectionsScreenReady: true,
        codexConnectionCardReady: true,
        claudeCodeConnectionCardReady: true,
        externalTransferBoundaryVisible: true,
        accessHistoryScreenReady: true,
        desktopHistoryEntryReady: true,
        contentFreeHistoryBoundaryVisible: true,
      })),
    };
    const executeJavaScript = vi.mocked(renderer.executeJavaScript);

    const evidence = await runGuiSmokeJourney(renderer);

    expect(evidence).toEqual({
      sampleSourceReady: true,
        sampleSourceLabel: "OhMyContext Sample Library",
      suggestedQuery: "weekly review",
      sampleProvenanceVerified: true,
      resultCardCount: 1,
      connectionsScreenReady: true,
      codexConnectionCardReady: true,
      claudeCodeConnectionCardReady: true,
      externalTransferBoundaryVisible: true,
      accessHistoryScreenReady: true,
      desktopHistoryEntryReady: true,
      contentFreeHistoryBoundaryVisible: true,
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    expect(executeJavaScript.mock.calls[0]?.[1]).toBe(true);
    const script = executeJavaScript.mock.calls[0]?.[0] ?? "";
    expect(script).toContain('data-testid="locale-select"');
    expect(script).toContain("localeSelect.value = 'en'");
    expect(script).toContain("enabledButtonWithTestId('nav-library')");
    expect(script).toContain("enabledButtonWithTestId('import-sample')");
    expect(script).toContain('data-testid="search-input"');
    expect(script).toContain("requestSubmit()");
    expect(script).toContain(".result-card");
    expect(script).toContain("enabledButtonWithTestId('nav-connections')");
    expect(script).toContain(".connection-card");
    expect(script).toContain("returned context may leave");
    expect(script).toContain("enabledButtonWithTestId('nav-history')");
    expect(script).toContain('data-testid="data-boundary"');
    expect(script).toContain(".history-client.desktop");
    expect(script).toContain("Content-free local log");
    expect(script).toContain(".history-actions button.secondary:not(.danger-text)");
    expect(script).toContain("does not live-update");
  });

  it.each([
    undefined,
    {},
    {
      sampleSourceReady: true,
        sampleSourceLabel: "OhMyContext Sample Library",
      suggestedQuery: "weekly review",
      sampleProvenanceVerified: true,
      resultCardCount: 0,
      connectionsScreenReady: true,
      codexConnectionCardReady: true,
      claudeCodeConnectionCardReady: true,
      externalTransferBoundaryVisible: true,
      accessHistoryScreenReady: true,
      desktopHistoryEntryReady: true,
      contentFreeHistoryBoundaryVisible: true,
    },
    {
      sampleSourceReady: true,
      sampleSourceLabel: "unexpected",
      suggestedQuery: "weekly review",
      sampleProvenanceVerified: true,
      resultCardCount: 1,
      connectionsScreenReady: true,
      codexConnectionCardReady: true,
      claudeCodeConnectionCardReady: true,
      externalTransferBoundaryVisible: true,
      accessHistoryScreenReady: true,
      desktopHistoryEntryReady: true,
      contentFreeHistoryBoundaryVisible: true,
    },
  ])("rejects invalid or unbounded renderer evidence: %o", async (value) => {
    const renderer: GuiSmokeRenderer = {
      executeJavaScript: async () => value,
    };
    await expect(runGuiSmokeJourney(renderer)).rejects.toThrow(
      "first-run evidence is invalid",
    );
  });

  it("records the completed journey only inside an isolated temporary root", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-gui-smoke-test-"));
    temporaryRoots.push(root);
    const context = prepareGuiSmoke(
      ["OwnContext.exe", "--owncontext-gui-smoke"],
      {
        OWNCONTEXT_GUI_SMOKE_ROOT: root,
        OWNCONTEXT_GUI_SMOKE_NONCE: nonce,
      },
      tmpdir(),
    );
    expect(context).toBeDefined();

    writeGuiSmokeSuccess(context!, true, {
      sampleSourceReady: true,
        sampleSourceLabel: "OhMyContext Sample Library",
      suggestedQuery: "weekly review",
      sampleProvenanceVerified: true,
      resultCardCount: 2,
      connectionsScreenReady: true,
      codexConnectionCardReady: true,
      claudeCodeConnectionCardReady: true,
      externalTransferBoundaryVisible: true,
      accessHistoryScreenReady: true,
      desktopHistoryEntryReady: true,
      contentFreeHistoryBoundaryVisible: true,
    });

    const result = JSON.parse(await readFile(context!.resultPath, "utf8"));
    expect(result).toEqual({
      status: "first-run-sample-search-and-connections-preview-complete",
      nonce,
      isPackaged: true,
      sampleSourceReady: true,
        sampleSourceLabel: "OhMyContext Sample Library",
      suggestedQuery: "weekly review",
      sampleProvenanceVerified: true,
      resultCardCount: 2,
      connectionsScreenReady: true,
      codexConnectionCardReady: true,
      claudeCodeConnectionCardReady: true,
      externalTransferBoundaryVisible: true,
      accessHistoryScreenReady: true,
      desktopHistoryEntryReady: true,
      contentFreeHistoryBoundaryVisible: true,
    });
  });
});
