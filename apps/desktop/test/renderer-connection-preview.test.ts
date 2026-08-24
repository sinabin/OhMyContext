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

  it("labels the packaged broker without disclosing its endpoint or vault path", () => {
    const brokerLaunch = {
      ...launch,
      brokerPipeName: `\\\\.\\pipe\\owncontext-mcp-${"a".repeat(32)}`,
    };
    const codex = renderRendererSafeCodexPreview(brokerLaunch);
    const claude = renderRendererSafeClaudeCodePreview(brokerLaunch);
    expect(codex).toContain("private local OwnContext broker");
    expect(codex).not.toContain("OWNCONTEXT_VAULT_PATH");
    expect(claude).toContain("private local OwnContext broker");
    expect(claude).not.toContain("OWNCONTEXT_VAULT_PATH");
    expect(codex).not.toContain("private-user");
    expect(claude).not.toContain("private-user");
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
