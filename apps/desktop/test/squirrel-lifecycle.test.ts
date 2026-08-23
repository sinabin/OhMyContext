import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCodexConfigService,
  type CodexConfigMutationResult,
  type CodexConfigService,
  type OwnContextMcpLaunch,
} from "../src/electron/codex-config.js";
import {
  createClaudeCodeConfigService,
  renderClaudeCodeMcpConfig,
} from "../src/electron/claude-code-config.js";
import {
  beginSquirrelLifecycle,
  detectSquirrelEvent,
  type SquirrelLifecycleOptions,
} from "../src/electron/squirrel-lifecycle.js";

describe("Squirrel.Windows lifecycle", () => {
  let root: string;
  let configPath: string;
  let oldLaunch: OwnContextMcpLaunch;
  let newLaunch: OwnContextMcpLaunch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "owncontext-squirrel-"));
    configPath = join(root, ".codex", "config.toml");
    oldLaunch = launch(join(root, "old", "OwnContext.exe"));
    newLaunch = launch(join(root, "new", "OwnContext.exe"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ignores non-packaged, non-Windows, and unknown invocations", () => {
    expect(detectSquirrelEvent("linux", true, ["app", "--squirrel-install"]))
      .toBeUndefined();
    expect(detectSquirrelEvent("win32", false, ["app", "--squirrel-install"]))
      .toBeUndefined();
    expect(detectSquirrelEvent("win32", true, ["app", "--other"]))
      .toBeUndefined();
  });

  it("handles install with only shortcut creation, then quits", async () => {
    const operations: string[] = [];
    const started = beginSquirrelLifecycle(options("--squirrel-install", {
      createConfigService: () => {
        throw new Error("install must not inspect Codex configuration");
      },
      runUpdate: async (args) => {
        operations.push(args[0]!);
      },
      quit: () => operations.push("quit"),
    }));

    expect(started.handled).toBe(true);
    if (!started.handled) return;
    expect(await started.completion).toMatchObject({ event: "install", failures: [] });
    expect(operations).toEqual([
      "--createShortcut=OwnContext.exe",
      "quit",
    ]);
  });

  it("atomically refreshes a managed connection before updating the shortcut", async () => {
    const base = createCodexConfigService({ configPath });
    await base.apply(oldLaunch);
    const operations: string[] = [];
    let refreshResult: CodexConfigMutationResult | undefined;
    const service: CodexConfigService = {
      ...base,
      refreshManaged: async (nextLaunch) => {
        operations.push("refresh");
        refreshResult = await base.refreshManaged(nextLaunch);
        return refreshResult;
      },
    };
    const started = beginSquirrelLifecycle(options("--squirrel-updated", {
      createConfigService: () => service,
      createLaunch: () => newLaunch,
      runUpdate: async (args) => {
        operations.push(args[0]!);
        expect(await readFile(configPath, "utf8")).toContain("new\\\\OwnContext.exe");
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("updated event was not handled");
    expect(await started.completion).toMatchObject({ event: "updated", failures: [] });
    expect(refreshResult).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
    });
    expect(operations).toEqual([
      "refresh",
      "--createShortcut=OwnContext.exe",
      "quit",
    ]);
  });

  it("does not recreate an absent connection during update", async () => {
    const service = createCodexConfigService({ configPath });
    const operations: string[] = [];
    const started = beginSquirrelLifecycle(options("--squirrel-updated", {
      createConfigService: () => service,
      createLaunch: () => newLaunch,
      runUpdate: async () => {
        operations.push("shortcut");
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("updated event was not handled");
    expect(await started.completion).toMatchObject({ failures: [] });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(operations).toEqual(["shortcut", "quit"]);
  });

  it("refreshes a recognizable Claude Code entry before the old app path is retired", async () => {
    const claudeConfigPath = join(root, "claude-update", ".claude.json");
    await mkdir(join(root, "claude-update"), { recursive: true });
    await writeFile(claudeConfigPath, `${JSON.stringify({
      theme: "preserved",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(oldLaunch) },
    }, null, 2)}\n`, "utf8");
    const operations: string[] = [];
    const started = beginSquirrelLifecycle(options("--squirrel-updated", {
      createClaudeCodeConfigService: () => createClaudeCodeConfigService({
        configPath: claudeConfigPath,
        environment: { PATH: "" },
        homeDirectory: root,
      }),
      runUpdate: async () => {
        operations.push("shortcut");
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("updated event was not handled");
    expect(await started.completion).toMatchObject({ event: "updated", failures: [] });
    expect(JSON.parse(await readFile(claudeConfigPath, "utf8"))).toEqual({
      theme: "preserved",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(newLaunch) },
    });
    expect(operations).toEqual(["shortcut", "quit"]);
  });

  it("leaves unmanaged and malformed Codex configurations untouched on update", async () => {
    await mkdir(join(root, ".codex"), { recursive: true });
    const fixtures = [
      {
        text: '[mcp_servers.owncontext]\ncommand = "someone-else"\n',
        code: "unmanaged_conflict",
      },
      {
        text: [
          "# >>> owncontext managed MCP server (do not edit) >>>",
          "[mcp_servers.owncontext]",
          'command = "broken"',
        ].join("\n"),
        code: "malformed_managed_block",
      },
    ];

    for (const fixture of fixtures) {
      await writeFile(configPath, fixture.text, "utf8");
      const operations: string[] = [];
      const started = beginSquirrelLifecycle(options("--squirrel-updated", {
        createConfigService: () => createCodexConfigService({ configPath }),
        createLaunch: () => newLaunch,
        runUpdate: async () => {
          operations.push("shortcut");
        },
        quit: () => operations.push("quit"),
      }));
      if (!started.handled) throw new Error("updated event was not handled");
      expect(await started.completion).toMatchObject({
        failures: [{ stage: "refresh-managed", code: fixture.code }],
      });
      expect(await readFile(configPath, "utf8")).toBe(fixture.text);
      expect(operations).toEqual(["shortcut", "quit"]);
    }
  });

  it("preserves a concurrent user opt-out and still updates the shortcut", async () => {
    await createCodexConfigService({ configPath }).apply(oldLaunch);
    const optedOut = 'model = "user-opted-out"\n';
    const service = createCodexConfigService({
      configPath,
      beforeReplaceCheck: async () => writeFile(configPath, optedOut, "utf8"),
    });
    const operations: string[] = [];
    const started = beginSquirrelLifecycle(options("--squirrel-updated", {
      createConfigService: () => service,
      createLaunch: () => newLaunch,
      runUpdate: async () => {
        operations.push("shortcut");
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("updated event was not handled");
    expect(await started.completion).toMatchObject({
      failures: [{ stage: "refresh-managed", code: "concurrent_change" }],
    });
    expect(await readFile(configPath, "utf8")).toBe(optedOut);
    expect(operations).toEqual(["shortcut", "quit"]);
  });

  it("removes only the managed block before removing the shortcut", async () => {
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(configPath, 'model = "preserved"\n', "utf8");
    const service = createCodexConfigService({ configPath });
    await service.apply(oldLaunch);
    const operations: string[] = [];
    let configAtShortcut = "";
    const started = beginSquirrelLifecycle(options("--squirrel-uninstall", {
      createConfigService: () => service,
      runUpdate: async (args) => {
        operations.push(args[0]!);
        configAtShortcut = await readFile(configPath, "utf8");
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("uninstall event was not handled");
    expect(await started.completion).toMatchObject({ event: "uninstall", failures: [] });
    expect(configAtShortcut).toBe('model = "preserved"\n\n');
    expect(operations).toEqual([
      "--removeShortcut=OwnContext.exe",
      "quit",
    ]);
  });

  it("revokes a managed Claude Code entry on uninstall without requiring its CLI", async () => {
    const claudeConfigPath = join(root, "claude", ".claude.json");
    await mkdir(join(root, "claude"), { recursive: true });
    await writeFile(claudeConfigPath, `${JSON.stringify({
      theme: "preserved",
      mcpServers: {
        other: { type: "stdio", command: "other" },
        owncontext: renderClaudeCodeMcpConfig(newLaunch),
      },
    }, null, 2)}\n`, "utf8");
    const operations: string[] = [];
    const started = beginSquirrelLifecycle(options("--squirrel-uninstall", {
      createClaudeCodeConfigService: () => createClaudeCodeConfigService({
        configPath: claudeConfigPath,
        environment: { PATH: "" },
        homeDirectory: root,
      }),
      runUpdate: async (args) => {
        operations.push(args[0]!);
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("uninstall event was not handled");
    expect(await started.completion).toMatchObject({ event: "uninstall", failures: [] });
    expect(JSON.parse(await readFile(claudeConfigPath, "utf8"))).toEqual({
      theme: "preserved",
      mcpServers: { other: { type: "stdio", command: "other" } },
    });
    expect(operations).toEqual(["--removeShortcut=OwnContext.exe", "quit"]);
  });

  it("attempts later required steps and quits once after failures", async () => {
    const operations: string[] = [];
    const failures: string[] = [];
    const service = createCodexConfigService({ configPath });
    const rejectingService: CodexConfigService = {
      ...service,
      refreshManaged: async () => {
        operations.push("refresh");
        throw new Error("fixture failure");
      },
    };
    const started = beginSquirrelLifecycle(options("--squirrel-updated", {
      createConfigService: () => rejectingService,
      createLaunch: () => newLaunch,
      runUpdate: async () => {
        operations.push("shortcut");
        throw new Error("fixture failure");
      },
      quit: () => operations.push("quit"),
      reportFailure: ({ stage }) => failures.push(stage),
    }));

    if (!started.handled) throw new Error("updated event was not handled");
    expect(await started.completion).toMatchObject({
      failures: [
        { stage: "refresh-managed" },
        { stage: "create-shortcut" },
      ],
    });
    expect(operations).toEqual(["refresh", "shortcut", "quit"]);
    expect(failures).toEqual(["refresh-managed", "create-shortcut"]);
  });

  it("quits obsolete versions without touching config or shortcuts", async () => {
    const operations: string[] = [];
    const started = beginSquirrelLifecycle(options("--squirrel-obsolete", {
      createConfigService: () => {
        throw new Error("obsolete must not inspect config");
      },
      runUpdate: async () => {
        throw new Error("obsolete must not run Update.exe");
      },
      quit: () => operations.push("quit"),
    }));

    if (!started.handled) throw new Error("obsolete event was not handled");
    expect(await started.completion).toMatchObject({ event: "obsolete", failures: [] });
    expect(operations).toEqual(["quit"]);
  });

  function options(
    event: string,
    overrides: Partial<SquirrelLifecycleOptions>,
  ): SquirrelLifecycleOptions {
    return {
      platform: "win32",
      isPackaged: true,
      argv: [join(root, "app", "OwnContext.exe"), event],
      executablePath: join(root, "app", "OwnContext.exe"),
      createConfigService: () => createCodexConfigService({ configPath }),
      createLaunch: () => newLaunch,
      runUpdate: async () => undefined,
      quit: () => undefined,
      ...overrides,
    };
  }

  function launch(commandPath: string): OwnContextMcpLaunch {
    return {
      commandPath,
      args: [join(root, "resources", "mcp-server", "cli.mjs")],
      vaultPath: join(root, "user-data", "owncontext.sqlite"),
      allowedCollection: "default",
      runtime: "electron",
    };
  }
});
