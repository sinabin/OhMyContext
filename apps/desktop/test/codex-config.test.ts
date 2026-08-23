import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CODEX_CONFIG_BYTES,
  MAX_MANAGED_BLOCK_BYTES,
  OWNCONTEXT_MARKER_END,
  OWNCONTEXT_MARKER_START,
  createCodexConfigService,
  renderOwnContextMcpBlock,
  type OwnContextMcpLaunch,
} from "../src/electron/codex-config.js";

describe("Codex OwnContext MCP configuration service", () => {
  let testRoot: string;
  let codexDirectory: string;
  let configPath: string;
  let launch: OwnContextMcpLaunch;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "owncontext-codex-config-"));
    codexDirectory = join(testRoot, ".codex");
    configPath = join(codexDirectory, "config.toml");
    launch = {
      commandPath: join(testRoot, "runtime", "electron.exe"),
      args: [join(testRoot, "app", "mcp-server.mjs")],
      vaultPath: join(testRoot, "data", "vault.sqlite"),
      allowedCollection: "default",
      runtime: "electron",
    };
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("creates a fresh official config with an explicit vault and Electron node mode", async () => {
    const service = createCodexConfigService({ configPath });

    const preview = await service.preview(launch);
    expect(preview).toMatchObject({
      status: "absent",
      canApply: true,
      canRemove: false,
      configExists: false,
    });
    expect(preview.snippet).toContain("OWNCONTEXT_VAULT_PATH");
    expect(preview.snippet).toContain('OWNCONTEXT_ALLOWED_COLLECTION = "default"');
    expect(preview.snippet).toContain('ELECTRON_RUN_AS_NODE = "1"');

    const result = await service.apply(launch);
    expect(result).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: false,
    });
    expect(await readFile(configPath, "utf8")).toBe(`${preview.snippet}\n`);
  });

  it("preserves unrelated TOML byte-for-byte while appending its marked block", async () => {
    const unrelated = [
      'model = "gpt-5"',
      "",
      "[projects.'C:\\\\work']",
      'trust_level = "trusted"',
      "",
    ].join("\r\n");
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(configPath, unrelated, "utf8");

    const result = await createCodexConfigService({ configPath }).apply(launch);
    const updated = await readFile(configPath, "utf8");

    expect(result.ok).toBe(true);
    expect(updated.startsWith(unrelated)).toBe(true);
    expect(updated).toContain("[mcp_servers.owncontext]");
    expect(updated).toContain("\r\n");
  });

  it("updates exactly one managed block and makes an exclusive backup", async () => {
    const service = createCodexConfigService({ configPath });
    await service.apply(launch);
    const original = await readFile(configPath, "utf8");
    const nextLaunch = {
      ...launch,
      vaultPath: join(testRoot, "data", "replacement.sqlite"),
    };

    const result = await service.apply(nextLaunch);
    const updated = await readFile(configPath, "utf8");

    expect(result).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
    });
    expect(result.backupFileName).toBe(basename(result.backupFileName!));
    expect(await readFile(join(codexDirectory, result.backupFileName!), "utf8")).toBe(
      original,
    );
    expect(updated).toContain("replacement.sqlite");
    expect(updated.match(/\[mcp_servers\.owncontext\]/g)).toHaveLength(1);
    expect(updated.match(new RegExp(escapeRegex(OWNCONTEXT_MARKER_START), "g"))).toHaveLength(
      1,
    );
  });

  it("refreshes only an existing managed block and never creates an absent one", async () => {
    const service = createCodexConfigService({ configPath });
    const absent = await service.refreshManaged(launch);
    expect(absent).toMatchObject({
      ok: true,
      code: "unchanged",
      changed: false,
      backupCreated: false,
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await service.apply(launch);
    const updatedLaunch = {
      ...launch,
      commandPath: join(testRoot, "updated", "OwnContext.exe"),
    };
    const refreshed = await service.refreshManaged(updatedLaunch);
    expect(refreshed).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
    });
    expect(await readFile(configPath, "utf8")).toContain("updated");
  });

  it("does not recreate a managed block removed concurrently during refresh", async () => {
    await createCodexConfigService({ configPath }).apply(launch);
    const userOptOut = 'model = "keep-user-opt-out"\n';
    const service = createCodexConfigService({
      configPath,
      beforeReplaceCheck: async () => {
        await writeFile(configPath, userOptOut, "utf8");
      },
    });

    const result = await service.refreshManaged({
      ...launch,
      commandPath: join(testRoot, "updated", "OwnContext.exe"),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "concurrent_change",
      changed: false,
      backupCreated: true,
    });
    expect(await readFile(configPath, "utf8")).toBe(userOptOut);
  });

  it("refuses an unmanaged owncontext table without changing or backing up the file", async () => {
    const original = [
      "[mcp_servers.owncontext]",
      'command = "someone-elses-command"',
      "",
    ].join("\n");
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(configPath, original, "utf8");

    const service = createCodexConfigService({ configPath });
    expect(await service.preview(launch)).toMatchObject({
      status: "unmanaged_conflict",
      canApply: false,
      canRemove: false,
    });
    expect(await service.apply(launch)).toMatchObject({
      ok: false,
      code: "unmanaged_conflict",
      changed: false,
      backupCreated: false,
    });
    expect(await service.remove()).toMatchObject({
      ok: false,
      code: "unmanaged_conflict",
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("refuses equivalent unmanaged TOML assignment forms", async () => {
    await mkdir(codexDirectory, { recursive: true });
    const service = createCodexConfigService({ configPath });
    const conflicts = [
      "mcp_servers.owncontext = { command = \"other\" }\n",
      '"mcp_servers"."owncontext" = { command = "other" }\n',
      "[mcp_servers]\nowncontext = { command = \"other\" }\n",
      '["mcp_servers"]\n"owncontext" = { command = "other" }\n',
      '["mcp_servers"."owncontext"]\ncommand = "other"\n',
    ];

    for (const conflict of conflicts) {
      await writeFile(configPath, conflict, "utf8");
      expect(await service.preview(launch)).toMatchObject({
        status: "unmanaged_conflict",
        canApply: false,
        canRemove: false,
      });
      expect(await service.apply(launch)).toMatchObject({
        ok: false,
        code: "unmanaged_conflict",
      });
      expect(await readFile(configPath, "utf8")).toBe(conflict);
    }
  });

  it("removes only the managed block and keeps unrelated settings", async () => {
    const unrelated = 'model = "gpt-5"\n\n';
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(
      configPath,
      `${unrelated}${renderOwnContextMcpBlock(launch)}\n[features]\napps = true\n`,
      "utf8",
    );

    const result = await createCodexConfigService({ configPath }).remove();
    const updated = await readFile(configPath, "utf8");

    expect(result).toMatchObject({
      ok: true,
      code: "removed",
      changed: true,
      backupCreated: true,
    });
    expect(updated).toBe(`${unrelated}[features]\napps = true\n`);
    expect(updated).not.toContain("mcp_servers.owncontext");
  });

  it("refuses missing, duplicate, and oversized managed markers", async () => {
    await mkdir(codexDirectory, { recursive: true });
    const service = createCodexConfigService({ configPath });

    for (const malformed of [
      `${OWNCONTEXT_MARKER_START}\n[mcp_servers.owncontext]\n`,
      `${renderOwnContextMcpBlock(launch)}\n${OWNCONTEXT_MARKER_END}\n`,
      [
        OWNCONTEXT_MARKER_START,
        "[mcp_servers.owncontext]",
        `command = "${"x".repeat(MAX_MANAGED_BLOCK_BYTES)}"`,
        "args = []",
        "env = {}",
        OWNCONTEXT_MARKER_END,
      ].join("\n"),
    ]) {
      await writeFile(configPath, malformed, "utf8");
      expect(await service.preview(launch)).toMatchObject({
        status: "malformed_managed_block",
        canApply: false,
        canRemove: false,
      });
      expect(await service.apply(launch)).toMatchObject({
        ok: false,
        code: "malformed_managed_block",
        backupCreated: false,
      });
      expect(await readFile(configPath, "utf8")).toBe(malformed);
    }
  });

  it("creates a directly restorable backup before changing an existing file", async () => {
    const original = 'model = "gpt-5"\n';
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(configPath, original, "utf8");
    const service = createCodexConfigService({ configPath });

    const result = await service.apply(launch);
    expect(result.backupCreated).toBe(true);
    const backupPath = join(codexDirectory, result.backupFileName!);
    expect(await readFile(backupPath, "utf8")).toBe(original);

    await copyFile(backupPath, configPath);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await service.preview(launch)).toMatchObject({ status: "absent" });
  });

  it("rejects a symlink target instead of replacing it", async () => {
    const actualConfig = join(testRoot, "actual-config.toml");
    const original = 'model = "outside"\n';
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(actualConfig, original, "utf8");
    try {
      await symlink(actualConfig, configPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EINVAL" || code === "UNKNOWN") {
        return;
      }
      throw error;
    }

    const service = createCodexConfigService({ configPath });
    expect(await service.preview(launch)).toMatchObject({
      status: "read_failed",
      canApply: false,
      canRemove: false,
    });
    expect(await service.apply(launch)).toMatchObject({
      ok: false,
      code: "read_failed",
      changed: false,
    });
    expect(await readFile(actualConfig, "utf8")).toBe(original);
  });

  it("does not overwrite a config changed concurrently before replacement", async () => {
    const original = 'model = "before"\n';
    const concurrent = 'model = "changed-by-another-process"\n';
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(configPath, original, "utf8");
    const service = createCodexConfigService({
      configPath,
      beforeReplaceCheck: async () => {
        await writeFile(configPath, concurrent, "utf8");
      },
    });

    const result = await service.apply(launch);

    expect(result).toMatchObject({
      ok: false,
      code: "concurrent_change",
      changed: false,
      backupCreated: true,
    });
    expect(await readFile(configPath, "utf8")).toBe(concurrent);
    expect(await readFile(join(codexDirectory, result.backupFileName!), "utf8")).toBe(
      original,
    );
  });

  it("rejects an oversized concurrent replacement without reading it as a snapshot", async () => {
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(configPath, 'model = "before"\n', "utf8");
    const service = createCodexConfigService({
      configPath,
      beforeReplaceCheck: async () => {
        await writeFile(configPath, Buffer.alloc(MAX_CODEX_CONFIG_BYTES + 1, 0x78));
      },
    });

    const result = await service.apply(launch);

    expect(result).toMatchObject({
      ok: false,
      code: "concurrent_change",
      changed: false,
      backupCreated: true,
    });
    expect((await readFile(configPath)).byteLength).toBe(MAX_CODEX_CONFIG_BYTES + 1);
  });

  it("rejects every relative supplied path and never creates a config", async () => {
    expect(() => createCodexConfigService({ configPath: "config.toml" })).toThrow(
      "Invalid internal Codex configuration path.",
    );

    const service = createCodexConfigService({ configPath });
    for (const invalidLaunch of [
      { ...launch, commandPath: "electron.exe" },
      { ...launch, args: ["mcp-server.js"] },
      { ...launch, vaultPath: "vault.sqlite" },
    ]) {
      expect(await service.apply(invalidLaunch)).toMatchObject({
        ok: false,
        code: "invalid_path",
        changed: false,
      });
    }

    expect(await service.preview({ ...launch, vaultPath: "secret-token-value" })).toMatchObject({
      canApply: false,
      snippet: "",
      configExists: false,
    });
  });

  it("accepts only absolute MCP entry paths for Electron", async () => {
    const service = createCodexConfigService({ configPath });

    expect(await service.preview(launch)).toMatchObject({
      canApply: true,
    });

    for (const args of [
      [],
      ["--inspect"],
      ["relative-app", join(testRoot, "app", "mcp-server.mjs")],
      [join(testRoot, "app", "mcp-server.mjs"), "--other-mode"],
    ]) {
      expect(await service.preview({ ...launch, args })).toMatchObject({
        canApply: false,
        snippet: "",
      });
    }
  });

  it("emits no Electron override for a Node runtime", () => {
    const block = renderOwnContextMcpBlock({
      ...launch,
      commandPath: join(testRoot, "runtime", "node.exe"),
      args: [join(testRoot, "app", "mcp-server.js")],
      runtime: "node",
    });

    expect(block).toContain("OWNCONTEXT_VAULT_PATH");
    expect(block).not.toContain("ELECTRON_RUN_AS_NODE");
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
