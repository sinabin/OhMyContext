import { mkdtemp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createNodeSqliteDevelopmentStorageProvider,
  listRetrievalActivity,
  openVault,
} from "@owncontext/core";
import {
  createClaudeCodeConfigService,
} from "../dist-electron/claude-code-config.js";
import { createCodexConfigService } from "../dist-electron/codex-config.js";
import {
  PackagedClientSmokeError,
  assertClaudeMcpHealth,
  assertCodexConfigParse,
  assertNoNewPackagedMcpProcess,
  createIsolatedClientEnvironment,
  discoverClaudeNpmNativeCommand,
  discoverCodexNativeCommand,
  listPackagedMcpProcessIds,
  resolveSourceBoundPackagedBuild,
  runBoundedCommand,
  terminateNewPackagedMcpProcesses,
} from "./packaged-client-smoke-support.mjs";
import {
  FORGE_BUILD_ID_ENV,
  validateForgeBuildIdentifier,
} from "./forge-build-id.mjs";
import { verifyReleaseBundle } from "../../../scripts/release-bundle.mjs";

const TEMP_PREFIX = "owncontext-packaged-clients-";
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptsDirectory, "..");
const projectRoot = resolve(desktopDirectory, "..", "..");
const outDirectory = resolve(desktopDirectory, "out");
const allowedCollection = "client-smoke";

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new PackagedClientSmokeError("windows_x64_required");
  }
  const configuredBuildIdentifier = process.env[FORGE_BUILD_ID_ENV];
  if (configuredBuildIdentifier === undefined) {
    throw new PackagedClientSmokeError("explicit_build_id_required");
  }

  const packaged = await resolveSourceBoundPackagedBuild({
    buildIdentifier: configuredBuildIdentifier,
    outDirectory,
    validateBuildIdentifier: validateForgeBuildIdentifier,
  });
  try {
    await verifyReleaseBundle({
      buildPath: packaged.buildDirectory,
      projectRoot,
    });
  } catch {
    throw new PackagedClientSmokeError("source_bound_bundle_verification_failed");
  }
  const [codexCommand, claudeCommand] = await Promise.all([
    discoverCodexNativeCommand({ environment: process.env }),
    discoverClaudeNpmNativeCommand({ environment: process.env }),
  ]);
  if (!codexCommand) throw new PackagedClientSmokeError("codex_cli_unavailable");
  if (!claudeCommand) throw new PackagedClientSmokeError("claude_cli_unavailable");

  const temporaryRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  let codexService;
  let claudeService;
  let processBaseline;
  let processTargets;
  let primaryError;
  try {
    const codexHome = join(temporaryRoot, "codex-home");
    const claudeHome = join(temporaryRoot, "claude-home");
    const claudeConfigDirectory = join(temporaryRoot, "claude-config");
    const probeHome = join(temporaryRoot, "probe-home");
    const vaultPath = join(temporaryRoot, "vault.sqlite3");
    await Promise.all([
      prepareTemporaryProfile(codexHome),
      prepareTemporaryProfile(claudeHome),
      prepareTemporaryProfile(probeHome),
      mkdir(claudeConfigDirectory, { recursive: true }),
    ]);

    const launch = Object.freeze({
      commandPath: packaged.executable,
      args: Object.freeze([packaged.mcpEntry]),
      vaultPath,
      allowedCollection,
      runtime: "electron",
    });
    const clientProcessIds = new Set();
    processTargets = {
      executable: packaged.executable,
      mcpEntry: packaged.mcpEntry,
      clientProcessIds,
      environment: createIsolatedClientEnvironment(process.env, {
        homeDirectory: probeHome,
      }),
    };
    processBaseline = await listPackagedMcpProcessIds(processTargets);

    const codexConfigPath = join(codexHome, "config.toml");
    const codexCanary = "# packaged-client smoke canary\n";
    await writeFile(codexConfigPath, codexCanary, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    codexService = createCodexConfigService({ configPath: codexConfigPath });
    const codexBefore = await codexService.preview(launch);
    if (codexBefore.status !== "absent" || !codexBefore.canApply) {
      throw new PackagedClientSmokeError("codex_preflight_failed");
    }
    const codexApplied = await codexService.apply(launch);
    if (!codexApplied.ok || codexApplied.code !== "applied") {
      throw new PackagedClientSmokeError("codex_apply_failed");
    }
    const codexManaged = await codexService.preview(launch);
    if (codexManaged.status !== "managed" || !codexManaged.canRemove) {
      throw new PackagedClientSmokeError("codex_apply_unverified");
    }

    const codexEnvironment = createIsolatedClientEnvironment(process.env, {
      homeDirectory: codexHome,
      codexHome,
    });
    const codexResult = await runBoundedCommand({
      commandPath: codexCommand.commandPath,
      args: [...codexCommand.prefixArgs, "mcp", "get", "owncontext", "--json"],
      environment: codexEnvironment,
    });
    if (Number.isSafeInteger(codexResult.processId)) {
      clientProcessIds.add(codexResult.processId);
    }
    assertSuccessfulClientCommand(codexResult, "codex");
    assertCodexConfigParse(codexResult.stdout, launch);
    await assertNoNewPackagedMcpProcess(processBaseline, processTargets);

    const codexRemoved = await codexService.remove();
    if (!codexRemoved.ok || codexRemoved.code !== "removed") {
      throw new PackagedClientSmokeError("codex_remove_failed");
    }
    const codexAfter = await codexService.preview(launch);
    const codexFinalText = await readFile(codexConfigPath, "utf8");
    if (
      codexAfter.status !== "absent" ||
      codexAfter.canRemove ||
      codexFinalText.trimEnd() !== codexCanary.trimEnd()
    ) {
      throw new PackagedClientSmokeError("codex_remove_unverified");
    }
    codexService = undefined;

    const claudeConfigPath = join(claudeConfigDirectory, ".claude.json");
    const claudeCanary = Object.freeze({
      theme: "owncontext-packaged-client-smoke-preserved",
    });
    await writeFile(
      claudeConfigPath,
      `${JSON.stringify(claudeCanary, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const claudeEnvironment = createIsolatedClientEnvironment(process.env, {
      homeDirectory: claudeHome,
      claudeConfigDirectory,
    });
    claudeService = createClaudeCodeConfigService({
      environment: claudeEnvironment,
      homeDirectory: claudeHome,
      discoverCommand: () => claudeCommand,
    });
    const claudeBefore = await claudeService.preview(launch);
    if (
      claudeBefore.status !== "absent" ||
      !claudeBefore.cliAvailable ||
      !claudeBefore.canApply
    ) {
      throw new PackagedClientSmokeError("claude_preflight_failed");
    }
    const claudeApplied = await claudeService.apply(launch);
    if (!claudeApplied.ok || claudeApplied.code !== "applied") {
      throw new PackagedClientSmokeError("claude_apply_failed");
    }
    const claudeManaged = await claudeService.preview(launch);
    if (claudeManaged.status !== "managed" || !claudeManaged.canRemove) {
      throw new PackagedClientSmokeError("claude_apply_unverified");
    }

    const claudeResult = await runBoundedCommand({
      commandPath: claudeCommand.commandPath,
      args: [...claudeCommand.prefixArgs, "mcp", "get", "owncontext"],
      environment: claudeEnvironment,
    });
    if (Number.isSafeInteger(claudeResult.processId)) {
      clientProcessIds.add(claudeResult.processId);
    }
    assertSuccessfulClientCommand(claudeResult, "claude");
    assertClaudeMcpHealth(`${claudeResult.stdout}\n${claudeResult.stderr}`);
    await assertNoNewPackagedMcpProcess(processBaseline, processTargets);
    await assertVaultOpenedWithoutRetrievalActivity(vaultPath);

    const claudeRemoved = await claudeService.remove();
    if (!claudeRemoved.ok || claudeRemoved.code !== "removed") {
      throw new PackagedClientSmokeError("claude_remove_failed");
    }
    const claudeAfter = await claudeService.preview(launch);
    const claudeFinalConfig = JSON.parse(await readFile(claudeConfigPath, "utf8"));
    if (
      claudeAfter.status !== "absent" ||
      claudeAfter.canRemove ||
      claudeFinalConfig.theme !== claudeCanary.theme ||
      Object.hasOwn(claudeFinalConfig.mcpServers ?? {}, "owncontext")
    ) {
      throw new PackagedClientSmokeError("claude_remove_unverified");
    }
    claudeService = undefined;

    await assertPackagedEncryptedBroker(packaged, temporaryRoot);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (processBaseline && processTargets) {
      try {
        await terminateNewPackagedMcpProcesses(processBaseline, processTargets);
      } catch {
        cleanupErrors.push("packaged_mcp_cleanup_failed");
      }
    }
    if (claudeService) {
      const removed = await claudeService.remove().catch(() => undefined);
      if (!removed?.ok) cleanupErrors.push("claude_cleanup_failed");
    }
    if (codexService) {
      const removed = await codexService.remove().catch(() => undefined);
      if (!removed?.ok) cleanupErrors.push("codex_cleanup_failed");
    }
    try {
      await safelyRemoveTemporaryDirectory(temporaryRoot);
    } catch {
      cleanupErrors.push("temporary_cleanup_failed");
    }
    if (cleanupErrors.length > 0) {
      primaryError = new PackagedClientSmokeError(cleanupErrors[0]);
    }
  }
  if (primaryError) throw primaryError;
}

async function assertPackagedEncryptedBroker(packaged, temporaryRoot) {
  const userDataPath = join(temporaryRoot, "broker-user-data");
  const encryptedVaultPath = join(
    userDataPath,
    "encrypted-vault",
    "owncontext.encrypted.sqlite",
  );
  const transport = new StdioClientTransport({
    command: packaged.executable,
    args: [`--user-data-dir=${userDataPath}`, "--owncontext-mcp-bridge"],
    env: {
      ...createIsolatedClientEnvironment(process.env, {
        homeDirectory: join(temporaryRoot, "broker-home"),
      }),
      OWNCONTEXT_ALLOWED_COLLECTION: allowedCollection,
      OWNCONTEXT_CLIENT_KIND: "codex",
      OWNCONTEXT_VAULT_PATH: encryptedVaultPath,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "owncontext-packaged-broker-smoke", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    if (!names.has("search") || !names.has("fetch")) {
      throw new PackagedClientSmokeError("encrypted_broker_tools_missing");
    }
  } catch (error) {
    if (error instanceof PackagedClientSmokeError) throw error;
    throw new PackagedClientSmokeError(
      `encrypted_broker_protocol_failed_${String(error).replace(/[^a-z0-9]+/giu, "_").slice(0, 120)}`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
  try {
    const metadata = await lstat(encryptedVaultPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
      throw new Error("invalid encrypted broker vault");
    }
  } catch (error) {
    if (error instanceof PackagedClientSmokeError) throw error;
    throw new PackagedClientSmokeError("encrypted_broker_vault_not_created");
  }
}

function assertSuccessfulClientCommand(result, client) {
  if (result.timedOut) {
    throw new PackagedClientSmokeError(`${client}_cli_timeout`);
  }
  if (result.outputLimitExceeded) {
    throw new PackagedClientSmokeError(`${client}_cli_output_limit`);
  }
  if (result.exitCode !== 0) {
    throw new PackagedClientSmokeError(`${client}_cli_failed`);
  }
}

async function assertVaultOpenedWithoutRetrievalActivity(vaultPath) {
  let vault;
  try {
    const metadata = await lstat(vaultPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > 1024 * 1024 * 1024
    ) {
      throw new Error("invalid vault");
    }
    vault = openVault(vaultPath, createNodeSqliteDevelopmentStorageProvider());
    if (listRetrievalActivity(vault).length !== 0) {
      throw new PackagedClientSmokeError("claude_unexpected_retrieval_activity");
    }
  } catch (error) {
    if (error instanceof PackagedClientSmokeError) throw error;
    throw new PackagedClientSmokeError("claude_packaged_mcp_not_observed");
  } finally {
    vault?.close();
  }
}

async function prepareTemporaryProfile(homeDirectory) {
  await Promise.all([
    mkdir(join(homeDirectory, "AppData", "Roaming"), { recursive: true }),
    mkdir(join(homeDirectory, "AppData", "Local"), { recursive: true }),
    mkdir(join(homeDirectory, "Temp"), { recursive: true }),
  ]);
}

async function safelyRemoveTemporaryDirectory(directory) {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const canonicalParent = await realpath(dirname(directory));
  const difference = relative(canonicalTemporaryRoot, directory);
  if (
    canonicalParent.toLocaleLowerCase("en-US") !==
      canonicalTemporaryRoot.toLocaleLowerCase("en-US") ||
    difference.length === 0 ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    !basename(directory).startsWith(TEMP_PREFIX)
  ) {
    throw new PackagedClientSmokeError("unsafe_temporary_cleanup");
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

try {
  await main();
  console.log(
    "Packaged client compatibility smoke passed: Codex config parse; Claude Code CLI packaged MCP health check (exact owncontext Connected status and temporary vault creation). The harness invoked local configuration-inspection subcommands only, used no inherited credentials, and the temporary vault recorded zero search/fetch activity.",
  );
} catch (error) {
  const code = error instanceof PackagedClientSmokeError
    ? error.code
    : "unexpected_failure";
  console.error(`Packaged client compatibility smoke failed: ${code}.`);
  process.exitCode = 1;
}
