import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MANAGED_MARKER,
  CLAUDE_CODE_SERVER_NAME,
  CLAUDE_CODE_TIMEOUT_MS,
  MAX_CLAUDE_CODE_CONFIG_BYTES,
  MAX_CLAUDE_CODE_STDERR_BYTES,
  MAX_CLAUDE_CODE_STDOUT_BYTES,
  createClaudeCodeConfigService,
  discoverClaudeCodeCommand,
  renderClaudeCodeMcpConfig,
  runClaudeCodeCommand,
  type ClaudeCodeCommandRequest,
  type ClaudeCodeCommandResult,
  type ClaudeCodeCommandRunner,
  type ClaudeCodeMcpLaunch,
} from "../src/electron/claude-code-config.js";

interface FakeRunnerOptions {
  addResult?: ClaudeCodeCommandResult;
  skipAddMutation?: boolean;
  corruptAddedEntry?: boolean;
  dropUnrelatedDuringAdd?: boolean;
  addKnownBootstrapMetadata?: boolean;
  addUnexpectedServer?: boolean;
  writeOversizedConfig?: boolean;
  mutateDespiteFailure?: boolean;
  beforeMutation?: () => void | Promise<void>;
}

const success: ClaudeCodeCommandResult = {
  exitCode: 0,
  timedOut: false,
  outputLimitExceeded: false,
};

describe("Claude Code OwnContext MCP configuration service", () => {
  let testRoot: string;
  let configPath: string;
  let launch: ClaudeCodeMcpLaunch;
  let commandPath: string;
  let requests: ClaudeCodeCommandRequest[];

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "owncontext-claude-code-config-"));
    configPath = join(testRoot, ".claude.json");
    commandPath = join(testRoot, "bin", "claude.exe");
    launch = {
      commandPath: join(testRoot, "runtime", "OwnContext.exe"),
      args: [join(testRoot, "resources", "mcp-server", "cli.mjs")],
      vaultPath: join(testRoot, "data", "owncontext.sqlite"),
      allowedCollection: "default",
      runtime: "electron",
    };
    requests = [];
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("returns only generated OwnContext JSON in a renderer-safe preview", async () => {
    const unrelatedSecret = "unrelated-claude-secret-that-must-not-leak";
    await writeJson(configPath, {
      theme: "dark",
      accountToken: unrelatedSecret,
      mcpServers: {
        other: { type: "stdio", command: "other-command" },
      },
    });
    const service = createService(configPath, createFakeRunner(configPath, requests));

    const preview = await service.preview(launch);
    const snippet = JSON.parse(preview.snippet) as Record<string, unknown>;

    expect(preview).toMatchObject({
      status: "absent",
      canApply: true,
      canRemove: false,
      cliAvailable: true,
      configExists: true,
    });
    expect(preview.snippet).not.toContain(unrelatedSecret);
    expect(snippet).toEqual(renderClaudeCodeMcpConfig(launch));
    expect(snippet).toMatchObject({
      type: "stdio",
      command: launch.commandPath,
      args: launch.args,
      env: {
        OWNCONTEXT_ALLOWED_COLLECTION: "default",
        OWNCONTEXT_CLIENT_KIND: "claude-code",
        OWNCONTEXT_MANAGED_BY: CLAUDE_CODE_MANAGED_MARKER,
        OWNCONTEXT_VAULT_PATH: launch.vaultPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it("uses the packaged broker without exposing the vault path", () => {
    const brokerLaunch = {
      ...launch,
      brokerPipeName: `\\\\.\\pipe\\owncontext-mcp-${"a".repeat(32)}`,
    };
    const generated = renderClaudeCodeMcpConfig(brokerLaunch);
    expect(generated.env.OWNCONTEXT_MCP_BROKER_PIPE).toBe(brokerLaunch.brokerPipeName);
    expect(generated.env.OWNCONTEXT_VAULT_PATH).toBeUndefined();
    expect(JSON.stringify(generated)).not.toContain(launch.vaultPath);
  });

  it("discovers native Windows binaries but never executes a PowerShell shim", async () => {
    const npmBin = join(testRoot, "npm-bin");
    const nativePackageBin = join(
      npmBin,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    await mkdir(dirname(nativePackageBin), { recursive: true });
    await writeFile(join(npmBin, "claude.ps1"), "Write-Output unsafe-shim\n", "utf8");
    await writeFile(nativePackageBin, "native-placeholder", "utf8");
    await writeJson(join(dirname(dirname(nativePackageBin)), "package.json"), {
      name: "@anthropic-ai/claude-code",
      version: "2.1.201",
      bin: { claude: "bin/claude.exe" },
    });

    const canonicalNativePackageBin = await realpath(nativePackageBin);
    await expect(discoverClaudeCodeCommand({
      platform: "win32",
      environment: { PATH: npmBin },
    })).resolves.toEqual({ commandPath: canonicalNativePackageBin, prefixArgs: [] });

    await rm(nativePackageBin);
    await expect(discoverClaudeCodeCommand({
      platform: "win32",
      environment: { PATH: npmBin },
    })).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "rejects local-looking PATH and npm directories that are junctions",
    async () => {
      const actualBin = join(testRoot, "actual-bin");
      const pathJunction = join(testRoot, "path-junction");
      await mkdir(actualBin, { recursive: true });
      await writeFile(join(actualBin, "claude.exe"), "native-placeholder", "utf8");
      await symlink(actualBin, pathJunction, "junction");
      await expect(discoverClaudeCodeCommand({
        platform: "win32",
        environment: { PATH: pathJunction },
      })).resolves.toBeUndefined();
      await unlink(pathJunction);

      const npmBin = join(testRoot, "npm-junction-bin");
      const packageParent = join(npmBin, "node_modules", "@anthropic-ai");
      const actualPackage = join(testRoot, "actual-package");
      await mkdir(join(actualPackage, "bin"), { recursive: true });
      await mkdir(packageParent, { recursive: true });
      await writeFile(
        join(actualPackage, "bin", "claude.exe"),
        "native-placeholder",
        "utf8",
      );
      await writeJson(join(actualPackage, "package.json"), {
        name: "@anthropic-ai/claude-code",
        version: "2.1.201",
        bin: { claude: "bin/claude.exe" },
      });
      const packageJunction = join(packageParent, "claude-code");
      await symlink(actualPackage, packageJunction, "junction");
      await expect(discoverClaudeCodeCommand({
        platform: "win32",
        environment: { PATH: npmBin },
      })).resolves.toBeUndefined();
      await unlink(packageJunction);
    },
  );

  it("backs up and verifies the same user config selected by CLAUDE_CONFIG_DIR", async () => {
    const configDirectory = join(testRoot, "custom-claude-config");
    const overriddenConfigPath = join(configDirectory, ".claude.json");
    const overrideRequests: ClaudeCodeCommandRequest[] = [];
    const service = createClaudeCodeConfigService({
      environment: {
        CLAUDE_CONFIG_DIR: configDirectory,
        ANTHROPIC_API_KEY: "must-not-reach-config-command",
        PATH: dirname(commandPath),
      },
      homeDirectory: join(testRoot, "home"),
      discoverCommand: () => ({ commandPath, prefixArgs: [] }),
      runCommand: createFakeRunner(overriddenConfigPath, overrideRequests),
    });

    const result = await service.apply(launch);

    expect(result).toMatchObject({ ok: true, code: "applied", changed: true });
    expect(await readJson(overriddenConfigPath)).toMatchObject({
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
    });
    expect(overrideRequests[0]?.environment.CLAUDE_CONFIG_DIR).toBe(configDirectory);
    expect(overrideRequests[0]?.environment.ANTHROPIC_API_KEY).toBeUndefined();
    await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("degrades only the Claude connection for an unsafe config override", async () => {
    const service = createClaudeCodeConfigService({
      environment: { CLAUDE_CONFIG_DIR: "relative-config" },
      homeDirectory: join(testRoot, "home"),
    });

    await expect(service.preview(launch)).resolves.toMatchObject({
      status: "invalid_config_target",
      canApply: false,
      canRemove: false,
    });
    await expect(service.apply(launch)).resolves.toMatchObject({
      ok: false,
      code: "invalid_config_target",
      changed: false,
    });
  });

  it("fails closed with an empty preview for renderer-supplied relative launch paths", async () => {
    const service = createService(configPath, createFakeRunner(configPath, requests));

    for (const invalid of [
      { ...launch, commandPath: "OwnContext.exe" },
      { ...launch, args: ["cli.mjs"] },
      { ...launch, vaultPath: "owncontext.sqlite" },
      { ...launch, allowedCollection: " default" },
      { ...launch, args: [] },
    ]) {
      expect(await service.preview(invalid)).toEqual({
        status: "invalid_launch",
        canApply: false,
        canRemove: false,
        cliAvailable: false,
        configExists: false,
        snippet: "",
      });
      expect(await service.apply(invalid)).toMatchObject({
        ok: false,
        code: "invalid_launch",
        changed: false,
        backupCreated: false,
      });
    }
    expect(requests).toHaveLength(0);
  });

  it("uses fixed add-json argv and backs up existing bytes before mutation", async () => {
    const original = Buffer.from(
      '{\r\n  "theme": "dark",\r\n  "mcpServers": {"other":{"type":"stdio","command":"other"}}\r\n}\r\n',
      "utf8",
    );
    await writeFile(configPath, original);
    let backupExistedBeforeMutation = false;
    const runner = createFakeRunner(configPath, requests, {
      beforeMutation: async () => {
        const entries = await readdir(testRoot);
        backupExistedBeforeMutation = entries.some((entry) =>
          entry.startsWith(".claude.json.owncontext-backup-"),
        );
      },
    });
    const service = createService(configPath, runner);
    const preview = await service.preview(launch);

    const result = await service.apply(launch);

    expect(result).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
      snippet: preview.snippet,
    });
    expect(backupExistedBeforeMutation).toBe(true);
    expect(result.backupFileName).toBe(basename(result.backupFileName!));
    expect(await readFile(join(testRoot, result.backupFileName!))).toEqual(original);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      commandPath,
      args: [
        "--fixed-wrapper",
        "mcp",
        "add-json",
        "--scope",
        "user",
        CLAUDE_CODE_SERVER_NAME,
        preview.snippet,
      ],
      timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
      maxStdoutBytes: MAX_CLAUDE_CODE_STDOUT_BYTES,
      maxStderrBytes: MAX_CLAUDE_CODE_STDERR_BYTES,
    });
    expect(requests[0]?.environment).toMatchObject({
      CLAUDE_CONFIG_DIR: testRoot,
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_TELEMETRY: "1",
    });
    expect("shell" in requests[0]!).toBe(false);
    expect(await readJson(configPath)).toMatchObject({
      theme: "dark",
      mcpServers: {
        other: { type: "stdio", command: "other" },
        owncontext: renderClaudeCodeMcpConfig(launch),
      },
    });
  });

  it("allows only observed non-executable Claude bootstrap metadata additions", async () => {
    await writeJson(configPath, {
      theme: "keep",
      nested: { retained: true },
      mcpServers: { other: { type: "stdio", command: "other" } },
    });
    const runner = createFakeRunner(configPath, requests, {
      addKnownBootstrapMetadata: true,
    });

    const result = await createService(configPath, runner).apply(launch);

    expect(result).toMatchObject({ ok: true, code: "applied", changed: true });
    expect(await readJson(configPath)).toEqual({
      theme: "keep",
      nested: { retained: true },
      mcpServers: {
        other: { type: "stdio", command: "other" },
        owncontext: renderClaudeCodeMcpConfig(launch),
      },
      firstStartTime: "2026-08-23T00:00:00.000Z",
      machineID: "a".repeat(64),
      migrationVersion: 13,
      opusProMigrationComplete: true,
      seenNotifications: {},
      sonnet1m45MigrationComplete: true,
    });
  });

  it("rejects an unexpected executable grant even when the baseline is preserved", async () => {
    await writeJson(configPath, {
      theme: "keep",
      mcpServers: { other: { type: "stdio", command: "other" } },
    });
    const runner = createFakeRunner(configPath, requests, {
      addUnexpectedServer: true,
    });

    const result = await createService(configPath, runner).apply(launch);

    expect(result).toMatchObject({
      ok: false,
      code: "recovery_required",
      changed: true,
      backupCreated: true,
    });
    expect(await readJson(configPath)).toMatchObject({
      theme: "keep",
      mcpServers: {
        other: { type: "stdio", command: "other" },
        owncontext: renderClaudeCodeMcpConfig(launch),
        unexpected: { type: "stdio", command: "unexpected.exe" },
      },
    });
  });

  it.each([
    ["successful exit", success],
    [
      "timeout after mutation",
      { exitCode: null, timedOut: true, outputLimitExceeded: false },
    ],
  ])(
    "never reports success when Claude drops unrelated settings after %s",
    async (_label, addResult) => {
      const original = {
        theme: "keep",
        mcpServers: { other: { type: "stdio", command: "other" } },
      };
      await writeJson(configPath, original);
      const runner = createFakeRunner(configPath, requests, {
        addResult,
        dropUnrelatedDuringAdd: true,
        mutateDespiteFailure: true,
      });

      const result = await createService(configPath, runner).apply(launch);

      expect(result).toMatchObject({
        ok: false,
        code: "recovery_required",
        changed: true,
        backupCreated: true,
      });
      expect(await readJson(configPath)).toEqual({
        mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
      });
      expect(await readJson(join(testRoot, result.backupFileName!))).toEqual(original);
    },
  );

  it("bounds snapshot verification after the CLI writes an oversized config", async () => {
    await writeJson(configPath, { theme: "keep" });
    const runner = createFakeRunner(configPath, requests, {
      writeOversizedConfig: true,
    });

    const result = await createService(configPath, runner).apply(launch);

    expect(result).toMatchObject({
      ok: false,
      code: "recovery_required",
      changed: true,
      backupCreated: true,
    });
    expect((await readFile(configPath)).byteLength).toBe(
      MAX_CLAUDE_CODE_CONFIG_BYTES + 1,
    );
  });

  it("does not claim a backup for a new Claude configuration", async () => {
    const service = createService(configPath, createFakeRunner(configPath, requests));

    const result = await service.apply(launch);

    expect(result).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: false,
    });
    expect(result.backupFileName).toBeUndefined();
    expect(await readJson(configPath)).toMatchObject({
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
    });
  });

  it("refuses an existing unmanaged owncontext entry without invoking Claude or backing up", async () => {
    const original = JSON.stringify({
      accountToken: "keep-private",
      mcpServers: {
        owncontext: {
          type: "stdio",
          command: join(testRoot, "someone-else.exe"),
          args: [],
          env: {},
        },
      },
    });
    await writeFile(configPath, original, "utf8");
    const service = createService(configPath, createFakeRunner(configPath, requests));

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
      changed: false,
      backupCreated: false,
    });
    expect(requests).toHaveLength(0);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await readdir(testRoot)).toEqual([".claude.json"]);
  });

  it("treats any extra field as a conflict and removes only a recognizable managed launch", async () => {
    const generated = renderClaudeCodeMcpConfig(launch);
    await writeJson(configPath, {
      mcpServers: {
        owncontext: { ...generated, unexpected: true },
      },
    });
    const service = createService(configPath, createFakeRunner(configPath, requests));

    expect(await service.remove()).toMatchObject({
      ok: false,
      code: "unmanaged_conflict",
      changed: false,
    });
    expect(requests).toHaveLength(0);

    await writeJson(configPath, {
      theme: "keep-me",
      mcpServers: {
        other: { type: "stdio", command: "other" },
        owncontext: generated,
      },
    });
    const exactBytes = await readFile(configPath);
    const result = await service.remove();

    expect(result).toMatchObject({
      ok: true,
      code: "removed",
      changed: true,
      backupCreated: true,
    });
    expect(await readFile(join(testRoot, result.backupFileName!))).toEqual(exactBytes);
    expect(requests).toHaveLength(0);
    expect(await readJson(configPath)).toEqual({
      theme: "keep-me",
      mcpServers: { other: { type: "stdio", command: "other" } },
    });
  });

  it("does not invoke the CLI when the exact managed entry is already present", async () => {
    await writeJson(configPath, {
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
    });
    const service = createService(configPath, createFakeRunner(configPath, requests));

    expect(await service.preview(launch)).toMatchObject({
      status: "managed",
      canApply: true,
      canRemove: true,
    });
    expect(await service.apply(launch)).toMatchObject({
      ok: true,
      code: "unchanged",
      changed: false,
      backupCreated: false,
    });
    expect(requests).toHaveLength(0);
  });

  it("recognizes a pre-client-label managed entry as stale and refreshes it locally", async () => {
    const legacy = structuredClone(renderClaudeCodeMcpConfig(launch)) as {
      env: Record<string, string>;
    };
    delete legacy.env.OWNCONTEXT_CLIENT_KIND;
    await writeJson(configPath, {
      theme: "keep-me",
      mcpServers: { owncontext: legacy },
    });
    const service = createService(configPath, createFakeRunner(configPath, requests));

    expect(await service.preview(launch)).toMatchObject({
      status: "managed_stale",
      canApply: true,
      canRemove: true,
    });
    await expect(service.apply(launch)).resolves.toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
    });
    expect(await readJson(configPath)).toEqual({
      theme: "keep-me",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
    });
    expect(requests).toHaveLength(0);
  });

  it("refuses a managed-looking entry that declares a different client", async () => {
    const conflicting = structuredClone(renderClaudeCodeMcpConfig(launch)) as {
      env: Record<string, string>;
    };
    conflicting.env.OWNCONTEXT_CLIENT_KIND = "codex";
    await writeJson(configPath, {
      mcpServers: { owncontext: conflicting },
    });
    const service = createService(configPath, createFakeRunner(configPath, requests));

    expect(await service.preview(launch)).toMatchObject({
      status: "unmanaged_conflict",
      canApply: false,
      canRemove: false,
    });
    expect(requests).toHaveLength(0);
  });

  it("updates a strictly recognizable OwnContext entry from an earlier app path", async () => {
    const previousLaunch = {
      ...launch,
      commandPath: join(testRoot, "previous-runtime", "OwnContext.exe"),
      args: [join(testRoot, "previous-resources", "mcp-server", "cli.mjs")],
      vaultPath: join(testRoot, "previous-data", "owncontext.sqlite"),
    };
    await writeJson(configPath, {
      theme: "keep-me",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(previousLaunch) },
    });
    const service = createService(configPath, createFakeRunner(configPath, requests));

    expect(await service.preview(launch)).toMatchObject({
      status: "managed_stale",
      canApply: true,
      canRemove: true,
    });
    const result = await service.apply(launch);

    expect(result).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
    });
    expect(await readJson(configPath)).toEqual({
      theme: "keep-me",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
    });
    expect(requests).toHaveLength(0);
  });

  it("refreshes an outdated grant without depending on the external CLI", async () => {
    const previousLaunch = {
      ...launch,
      commandPath: join(testRoot, "previous-runtime", "OwnContext.exe"),
    };
    await writeJson(configPath, {
      theme: "keep-me",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(previousLaunch) },
    });
    const runner = createFakeRunner(configPath, requests, {
      addResult: { exitCode: 7, timedOut: false, outputLimitExceeded: false },
    });

    const result = await createService(configPath, runner).apply(launch);

    expect(result).toMatchObject({
      ok: true,
      code: "applied",
      changed: true,
      backupCreated: true,
    });
    expect(await readJson(configPath)).toEqual({
      theme: "keep-me",
      mcpServers: { owncontext: renderClaudeCodeMcpConfig(launch) },
    });
    expect(requests).toHaveLength(0);
  });

  it("rejects a second mutation while one Claude CLI change is active", async () => {
    let releaseMutation!: () => void;
    let reportMutationStarted!: () => void;
    const mutationGate = new Promise<void>((resolvePromise) => {
      releaseMutation = resolvePromise;
    });
    const mutationStarted = new Promise<void>((resolvePromise) => {
      reportMutationStarted = resolvePromise;
    });
    const runner = createFakeRunner(configPath, requests, {
      beforeMutation: async () => {
        reportMutationStarted();
        await mutationGate;
      },
    });
    const service = createService(configPath, runner);

    const first = service.apply(launch);
    await mutationStarted;
    await expect(service.remove()).resolves.toMatchObject({
      ok: false,
      code: "busy",
      changed: false,
    });
    releaseMutation();
    await expect(first).resolves.toMatchObject({ ok: true, code: "applied" });
  });

  it("reports a failed add safely after creating the restorable backup", async () => {
    const original = Buffer.from('{"theme":"keep"}\n', "utf8");
    await writeFile(configPath, original);
    const runner = createFakeRunner(configPath, requests, {
      addResult: { exitCode: 7, timedOut: false, outputLimitExceeded: false },
    });
    const result = await createService(configPath, runner).apply(launch);

    expect(result).toMatchObject({
      ok: false,
      code: "cli_failed",
      changed: false,
      backupCreated: true,
    });
    expect(await readFile(configPath)).toEqual(original);
    expect(await readFile(join(testRoot, result.backupFileName!))).toEqual(original);
    expect(JSON.stringify(result)).not.toContain("keep");
  });

  it("reports bounded runner failures without exposing command output", async () => {
    await writeJson(configPath, { theme: "keep" });
    const timedOut = createFakeRunner(configPath, requests, {
      addResult: { exitCode: null, timedOut: true, outputLimitExceeded: false },
    });
    expect(await createService(configPath, timedOut).apply(launch)).toMatchObject({
      ok: false,
      code: "cli_timeout",
      changed: false,
      backupCreated: true,
    });

    requests = [];
    const outputLimited = createFakeRunner(configPath, requests, {
      addResult: { exitCode: null, timedOut: false, outputLimitExceeded: true },
    });
    const result = await createService(configPath, outputLimited).apply(launch);
    expect(result).toMatchObject({
      ok: false,
      code: "cli_output_limit",
      changed: false,
      backupCreated: true,
    });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
  });

  it("never restores over an unrecognized OwnContext entry written during apply", async () => {
    await writeJson(configPath, { theme: "keep" });
    const runner = createFakeRunner(configPath, requests, { corruptAddedEntry: true });

    const result = await createService(configPath, runner).apply(launch);

    expect(result).toMatchObject({
      ok: false,
      code: "recovery_required",
      changed: true,
      backupCreated: true,
    });
    expect(requests).toHaveLength(1);
    expect(await readJson(configPath)).toMatchObject({
      theme: "keep",
      mcpServers: { owncontext: { command: "wrong-command" } },
    });
    expect(await createService(configPath, createFakeRunner(configPath, [])).preview(launch))
      .toMatchObject({
        status: "unmanaged_conflict",
        canApply: false,
        canRemove: false,
      });
  });

  it("fails closed for malformed or structurally ambiguous Claude JSON", async () => {
    const service = createService(configPath, createFakeRunner(configPath, requests));
    for (const [content, status] of [
      ["{not-json", "invalid_json"],
      ["[]", "invalid_structure"],
      ['{"mcpServers":[]}', "invalid_structure"],
      ['{"id":9007199254740993}', "invalid_structure"],
      ['{"id":9007199254740993.0}', "invalid_structure"],
      ['{"id":9.007199254740993e15}', "invalid_structure"],
      ['{"ratio":0.100000000000000005}', "invalid_structure"],
      ['{"id":-0}', "invalid_structure"],
      ['{"id":1e400}', "invalid_structure"],
      ['{"theme":"first","theme":"second"}', "invalid_structure"],
    ] as const) {
      await writeFile(configPath, content, "utf8");
      expect(await service.preview(launch)).toMatchObject({
        status,
        canApply: false,
        canRemove: false,
        configExists: true,
      });
      expect(await service.apply(launch)).toMatchObject({
        ok: false,
        code: status,
        backupCreated: false,
      });
    }
    expect(requests).toHaveLength(0);
  });

  it("enforces stdout and wall-clock bounds in the default no-shell runner", async () => {
    const outputResult = await runClaudeCodeCommand({
      commandPath: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      environment: {},
      timeoutMs: 5_000,
      maxStdoutBytes: 32,
      maxStderrBytes: 32,
    });
    expect(outputResult.outputLimitExceeded).toBe(true);

    const timeoutResult = await runClaudeCodeCommand({
      commandPath: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      environment: {},
      timeoutMs: 50,
      maxStdoutBytes: 32,
      maxStderrBytes: 32,
    });
    expect(timeoutResult.timedOut).toBe(true);
  });
});

function createService(configPath: string, runCommand: ClaudeCodeCommandRunner) {
  return createClaudeCodeConfigService({
    configPath,
    discoverCommand: () => ({
      commandPath: join(dirname(configPath), "bin", "claude.exe"),
      prefixArgs: ["--fixed-wrapper"],
    }),
    runCommand,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
  });
}

function createFakeRunner(
  configPath: string,
  requests: ClaudeCodeCommandRequest[],
  options: FakeRunnerOptions = {},
): ClaudeCodeCommandRunner {
  return async (request) => {
    requests.push({ ...request, args: [...request.args] });
    const mcpIndex = request.args.indexOf("mcp");
    const operation = request.args[mcpIndex + 1];

    if (operation === "add-json") {
      if (
        options.addResult &&
        options.addResult.exitCode !== 0 &&
        !options.mutateDespiteFailure
      ) {
        return options.addResult;
      }
      if (!options.skipAddMutation) {
        await options.beforeMutation?.();
        if (options.writeOversizedConfig) {
          await writeFile(
            configPath,
            Buffer.alloc(MAX_CLAUDE_CODE_CONFIG_BYTES + 1, 0x78),
          );
          return options.addResult ?? success;
        }
        const root = options.dropUnrelatedDuringAdd
          ? {}
          : await readJsonOrEmpty(configPath);
        const servers = isRecord(root.mcpServers) ? root.mcpServers : {};
        const snippet = request.args.at(-1);
        if (!snippet) throw new Error("Expected generated Claude JSON.");
        const generated = JSON.parse(snippet) as Record<string, unknown>;
        servers[CLAUDE_CODE_SERVER_NAME] = options.corruptAddedEntry
          ? { ...generated, command: "wrong-command" }
          : generated;
        if (options.addUnexpectedServer) {
          servers.unexpected = { type: "stdio", command: "unexpected.exe" };
        }
        root.mcpServers = servers;
        if (options.addKnownBootstrapMetadata) {
          root.firstStartTime = "2026-08-23T00:00:00.000Z";
          root.machineID = "a".repeat(64);
          root.migrationVersion = 13;
          root.opusProMigrationComplete = true;
          root.seenNotifications = {};
          root.sonnet1m45MigrationComplete = true;
        }
        await writeJson(configPath, root);
      }
      return options.addResult ?? success;
    }

    throw new Error(`Unexpected fake Claude operation: ${String(operation)}`);
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  try {
    return await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
