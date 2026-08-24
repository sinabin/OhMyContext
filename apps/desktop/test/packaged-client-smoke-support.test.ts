import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PackagedClientSmokeError,
  assertClaudeMcpHealth,
  assertCodexConfigParse,
  createIsolatedClientEnvironment,
  discoverClaudeNpmNativeCommand,
  parseWindowsCommandLine,
} from "../scripts/packaged-client-smoke-support.mjs";

const launch = {
  commandPath: resolve("packaged", "OhMyContextDeveloperPreview.exe"),
  args: [resolve("packaged", "resources", "mcp-server", "cli.mjs")],
  vaultPath: resolve("temporary-profile", "vault.sqlite3"),
  allowedCollection: "client-smoke",
  runtime: "electron" as const,
};

describe("packaged client smoke output boundaries", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ));
  });

  it("accepts an exact Codex MCP configuration record", () => {
    expect(() => assertCodexConfigParse(JSON.stringify({
      name: "owncontext",
      transport: {
        type: "stdio",
        command: launch.commandPath,
        args: launch.args,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          OWNCONTEXT_ALLOWED_COLLECTION: launch.allowedCollection,
          OWNCONTEXT_CLIENT_KIND: "codex",
          OWNCONTEXT_VAULT_PATH: launch.vaultPath,
        },
      },
    }), launch)).not.toThrow();
  });

  it("fails closed when Codex reports a different launch environment", () => {
    expect(() => assertCodexConfigParse(JSON.stringify({
      name: "owncontext",
      transport: {
        type: "stdio",
        command: launch.commandPath,
        args: launch.args,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          OWNCONTEXT_ALLOWED_COLLECTION: launch.allowedCollection,
          OWNCONTEXT_CLIENT_KIND: "codex",
          OWNCONTEXT_VAULT_PATH: launch.vaultPath,
          UNEXPECTED: "value",
        },
      },
    }), launch)).toThrowError(
      expect.objectContaining<Partial<PackagedClientSmokeError>>({
        code: "codex_config_mismatch",
      }),
    );
  });

  it("requires Claude Code to report an explicit connected state", () => {
    expect(() => assertClaudeMcpHealth("owncontext:\n  Status: √ Connected")).not.toThrow();
    expect(() => assertClaudeMcpHealth("owncontext:\n  Status: ✔ Connected")).not.toThrow();
    expect(() => assertClaudeMcpHealth("owncontext: configuration found")).toThrowError(
      expect.objectContaining<Partial<PackagedClientSmokeError>>({
        code: "claude_mcp_health_unverified",
      }),
    );
    expect(() =>
      assertClaudeMcpHealth("owncontext:\n  Status: configured\nunrelated:\n  Status: ✓ Connected"),
    ).toThrowError(
      expect.objectContaining<Partial<PackagedClientSmokeError>>({
        code: "claude_mcp_health_unverified",
      }),
    );
    expect(() =>
      assertClaudeMcpHealth("unrelated:\n  Detail: owncontext docs\n  Status: ✔ Connected"),
    ).toThrowError(
      expect.objectContaining<Partial<PackagedClientSmokeError>>({
        code: "claude_mcp_health_unverified",
      }),
    );
    expect(() => assertClaudeMcpHealth("owncontext: ✗ Failed to connect")).toThrowError(
      expect.objectContaining<Partial<PackagedClientSmokeError>>({
        code: "claude_mcp_health_unverified",
      }),
    );
  });

  it("parses exact quoted Windows process arguments without prefix matching", () => {
    const executable = "C:\\Program Files\\OhMyContext\\OhMyContextDeveloperPreview.exe";
    const entry = "C:\\Program Files\\OhMyContext\\resources\\mcp-server\\cli.mjs";
    expect(parseWindowsCommandLine(`"${executable}" "${entry}"`)).toEqual([
      executable,
      entry,
    ]);
    expect(parseWindowsCommandLine(`"${executable}" "${entry}.unrelated"`)).toEqual([
      executable,
      `${entry}.unrelated`,
    ]);
    expect(parseWindowsCommandLine(`"${executable}" "${entry}" unrelated`)).toEqual([
      executable,
      entry,
      "unrelated",
    ]);
  });

  it.runIf(process.platform === "win32")(
    "isolates client homes and excludes inherited credentials",
    () => {
      const homeDirectory = "C:\\Temp\\owncontext-client-smoke";
      const environment = createIsolatedClientEnvironment({
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        OPENAI_API_KEY: "must-not-survive",
        ANTHROPIC_API_KEY: "must-not-survive",
      }, {
        homeDirectory,
        codexHome: `${homeDirectory}\\codex`,
        claudeConfigDirectory: `${homeDirectory}\\claude`,
      });

      expect(environment).toMatchObject({
        APPDATA: `${homeDirectory}\\AppData\\Roaming`,
        LOCALAPPDATA: `${homeDirectory}\\AppData\\Local`,
        TEMP: `${homeDirectory}\\Temp`,
        TMP: `${homeDirectory}\\Temp`,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
        CODEX_HOME: `${homeDirectory}\\codex`,
        CLAUDE_CONFIG_DIR: `${homeDirectory}\\claude`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_ERROR_REPORTING: "1",
        DISABLE_TELEMETRY: "1",
      });
      expect(environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a standalone Claude executable without the npm package boundary",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "owncontext-claude-discovery-"));
      temporaryRoots.push(root);
      await writeFile(join(root, "claude.exe"), "untrusted", "utf8");

      await expect(discoverClaudeNpmNativeCommand({
        environment: { PATH: root },
      })).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform === "win32")(
    "binds Claude discovery to matching root and platform package bytes",
    async () => {
      const npmBin = await mkdtemp(join(tmpdir(), "owncontext-claude-discovery-"));
      temporaryRoots.push(npmBin);
      const packageRoot = join(
        npmBin,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
      );
      const nativeRoot = join(
        packageRoot,
        "node_modules",
        "@anthropic-ai",
        "claude-code-win32-x64",
      );
      await Promise.all([
        mkdir(join(packageRoot, "bin"), { recursive: true }),
        mkdir(nativeRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name: "@anthropic-ai/claude-code",
          version: "1.2.3",
          bin: { claude: "bin/claude.exe" },
          optionalDependencies: {
            "@anthropic-ai/claude-code-win32-x64": "1.2.3",
          },
        }), "utf8"),
        writeFile(join(nativeRoot, "package.json"), JSON.stringify({
          name: "@anthropic-ai/claude-code-win32-x64",
          version: "1.2.3",
          os: ["win32"],
          cpu: ["x64"],
          files: ["claude.exe"],
        }), "utf8"),
        writeFile(join(packageRoot, "bin", "claude.exe"), "same-binary", "utf8"),
        writeFile(join(nativeRoot, "claude.exe"), "same-binary", "utf8"),
      ]);

      const canonicalPackageRoot = await realpath(packageRoot);
      await expect(discoverClaudeNpmNativeCommand({
        environment: { PATH: npmBin },
      })).resolves.toEqual({
        commandPath: join(canonicalPackageRoot, "bin", "claude.exe"),
        prefixArgs: [],
      });
    },
  );
});
