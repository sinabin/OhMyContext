import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClaudeCodeConfigService,
  discoverClaudeCodeCommand,
} from "../dist-electron/claude-code-config.js";

const REQUIRE_CLI = process.argv.includes("--require-cli");
const TEMP_PREFIX = "owncontext-claude-smoke-";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function safelyRemoveTemporaryDirectory(directory) {
  const canonicalTemporaryRoot = await realpath(tmpdir());
  const canonicalParent = await realpath(dirname(directory));
  const difference = relative(canonicalTemporaryRoot, directory);
  if (
    canonicalParent !== canonicalTemporaryRoot ||
    difference.length === 0 ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    !basename(directory).startsWith(TEMP_PREFIX)
  ) {
    throw new Error("Refusing to remove an unexpected Claude Code smoke directory.");
  }
  await rm(directory, { recursive: true, force: true });
}

const command = await discoverClaudeCodeCommand();
if (!command) {
  if (REQUIRE_CLI) {
    throw new Error("Claude Code CLI was not found through the safe native discovery path.");
  }
  console.log("Claude Code CLI smoke skipped: no safe native CLI was found.");
  process.exit(0);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
try {
  const configPath = join(temporaryRoot, ".claude.json");
  const canary = { theme: "owncontext-smoke-preserved" };
  await writeFile(configPath, `${JSON.stringify(canary, null, 2)}\n`, "utf8");

  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: temporaryRoot,
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
  };
  const service = createClaudeCodeConfigService({
    environment,
    homeDirectory: temporaryRoot,
  });
  const launch = {
    commandPath: process.execPath,
    args: [join(REPOSITORY_ROOT, "apps", "mcp-server", "dist", "cli.js")],
    vaultPath: join(temporaryRoot, "vault.sqlite3"),
    allowedCollection: "default",
    runtime: "node",
  };

  const before = await service.preview(launch);
  if (before.status !== "absent" || !before.cliAvailable || !before.canApply) {
    throw new Error(`Unexpected preflight state: ${before.status}`);
  }

  const applied = await service.apply(launch);
  if (!applied.ok || applied.code !== "applied") {
    throw new Error(`Claude Code apply failed closed with ${applied.code}.`);
  }
  const managed = await service.preview(launch);
  if (managed.status !== "managed" || !managed.canRemove) {
    throw new Error(`Claude Code registration was not verified: ${managed.status}`);
  }

  const removed = await service.remove();
  if (!removed.ok || removed.code !== "removed") {
    throw new Error(`Claude Code removal failed closed with ${removed.code}.`);
  }
  const finalConfig = JSON.parse(await readFile(configPath, "utf8"));
  if (
    finalConfig.theme !== canary.theme ||
    Object.hasOwn(finalConfig.mcpServers ?? {}, "owncontext")
  ) {
    throw new Error("Claude Code round trip did not preserve unrelated configuration.");
  }

  console.log("Claude Code user-scope temp-config round trip passed.");
} finally {
  await safelyRemoveTemporaryDirectory(temporaryRoot);
}
