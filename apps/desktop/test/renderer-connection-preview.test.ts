import { describe, expect, it } from "vitest";
import {
  omitConnectionMutationSnippet,
  renderRendererSafeClaudeCodePreview,
  renderRendererSafeCodexPreview,
} from "../src/electron/renderer-connection-preview.js";

describe("renderer-safe connection previews", () => {
  const launch = {
    commandPath: "C:\\Users\\private-user\\OwnContext.exe",
    args: ["C:\\Users\\private-user\\resources\\cli.mjs"],
    vaultPath: "C:\\Users\\private-user\\AppData\\vault.sqlite",
    allowedCollection: "default",
    runtime: "electron" as const,
  };

  it.each([
    renderRendererSafeCodexPreview(launch),
    renderRendererSafeClaudeCodePreview(launch),
  ])("shows the grant without disclosing private local paths", (preview) => {
    expect(preview).toContain("default");
    expect(preview).toMatch(/OWNCONTEXT_CLIENT_KIND/);
    expect(preview).toContain("private local OwnContext vault");
    expect(preview).not.toContain("private-user");
    expect(preview).not.toContain(launch.commandPath);
    expect(preview).not.toContain(launch.args[0]);
    expect(preview).not.toContain(launch.vaultPath);
  });

  it("keeps the Claude display preview valid JSON", () => {
    expect(JSON.parse(renderRendererSafeClaudeCodePreview(launch))).toMatchObject({
      type: "stdio",
      env: {
        OWNCONTEXT_ALLOWED_COLLECTION: "default",
        OWNCONTEXT_CLIENT_KIND: "claude-code",
      },
    });
  });

  it("removes real-path snippets from mutation IPC results", () => {
    const result = omitConnectionMutationSnippet({
      ok: true,
      code: "applied",
      snippet: `${launch.commandPath} ${launch.vaultPath}`,
    });
    expect(result).toEqual({ ok: true, code: "applied" });
    expect(JSON.stringify(result)).not.toContain("private-user");
  });
});
