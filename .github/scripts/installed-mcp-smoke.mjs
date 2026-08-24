import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createNodeSqliteDevelopmentStorageProvider,
  importDirectory,
  openVault,
} from "@owncontext/core";

const COLLECTION = "installed-lifecycle";
const BROKER_COLLECTION = "default";
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function strictDescendant(parent, candidate) {
  const child = relative(parent, candidate);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("Invalid installed MCP smoke boundary.");
  }
  return value;
}

function requiredBrokerPipe() {
  const value = process.env.OWNCONTEXT_MCP_BROKER_PIPE;
  if (!value || !/^\\\\\.\\pipe\\owncontext-mcp-[0-9a-f]{32}$/u.test(value)) {
    throw new Error("Invalid installed MCP broker boundary.");
  }
  return value;
}

function regularRealFile(candidate, trustedRoot) {
  const metadata = lstatSync(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Invalid installed MCP smoke input.");
  }
  const realCandidate = realpathSync.native(candidate);
  if (!strictDescendant(trustedRoot, realCandidate)) {
    throw new Error("Installed MCP smoke input escaped its trusted root.");
  }
  return realCandidate;
}

function regularRealDirectory(candidate, trustedRoot) {
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Invalid installed MCP smoke environment directory.");
  }
  const realCandidate = realpathSync.native(candidate);
  if (!strictDescendant(trustedRoot, realCandidate)) {
    throw new Error("Installed MCP smoke environment escaped its temporary root.");
  }
  return realCandidate;
}

function sameWindowsPath(left, right) {
  return left.toUpperCase() === right.toUpperCase();
}

function bounded(operation) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Installed MCP request timed out.")),
      REQUEST_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Installed MCP smoke requires Windows x64.");
  }

  const requestedRoot = requiredEnvironment("OWNCONTEXT_INSTALLED_SMOKE_ROOT");
  const requestedInstallRoot = requiredEnvironment("OWNCONTEXT_INSTALLED_ROOT");
  const rootMetadata = lstatSync(requestedRoot);
  const installMetadata = lstatSync(requestedInstallRoot);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    !installMetadata.isDirectory() ||
    installMetadata.isSymbolicLink()
  ) {
    throw new Error("Installed MCP smoke roots must be regular directories.");
  }

  const smokeRoot = realpathSync.native(requestedRoot);
  const installRoot = realpathSync.native(requestedInstallRoot);

  const expectedEnvironmentChildren = new Map([
    ["HOME", "profile"],
    ["USERPROFILE", "profile"],
    ["APPDATA", "appdata"],
    ["LOCALAPPDATA", "local-appdata"],
    ["TEMP", "temp"],
    ["TMP", "temp"],
  ]);
  const environmentDirectories = {};
  for (const [name, childName] of expectedEnvironmentChildren) {
    const actual = regularRealDirectory(requiredEnvironment(name), smokeRoot);
    const expected = realpathSync.native(join(smokeRoot, childName));
    if (!sameWindowsPath(actual, expected)) {
      throw new Error("Installed MCP smoke environment directory is not exact.");
    }
    environmentDirectories[name] = actual;
  }

  const expectedRootEntries = [...new Set(expectedEnvironmentChildren.values())].sort();
  const rootEntries = (await readdir(smokeRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (
    rootEntries.length !== expectedRootEntries.length ||
    rootEntries.some(
      (entry, index) =>
        entry.name !== expectedRootEntries[index] ||
        !entry.isDirectory() ||
        entry.isSymbolicLink(),
    )
  ) {
    throw new Error("Installed MCP smoke root did not contain only isolated environment directories.");
  }

  const executable = regularRealFile(
    requiredEnvironment("OWNCONTEXT_INSTALLED_EXE"),
    installRoot,
  );
  const mcpEntry = regularRealFile(
    requiredEnvironment("OWNCONTEXT_INSTALLED_MCP"),
    installRoot,
  );
  const brokerPipe = process.env.OWNCONTEXT_MCP_BROKER_PIPE
    ? requiredBrokerPipe()
    : undefined;
  const brokered = brokerPipe !== undefined;
  const collection = brokered ? BROKER_COLLECTION : COLLECTION;
  const fixtureDirectory = resolve(smokeRoot, "fixture");
  const vaultPath = resolve(smokeRoot, "vault.sqlite");
  const searchQuery = brokered ? "weekly review" : `installedlifecycle${randomUUID().replaceAll("-", "")}`;
  if (!brokered) {
    await mkdir(fixtureDirectory, { mode: 0o700 });
    await writeFile(
      join(fixtureDirectory, "fixture.md"),
      `# Disposable CI fixture\n\n${searchQuery} verifies installed MCP search and fetch.\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );

    const vault = openVault(
      vaultPath,
      createNodeSqliteDevelopmentStorageProvider(),
    );
    try {
      const imported = await importDirectory(vault, fixtureDirectory, {
        collection,
      });
      if (imported.imported !== 1 || imported.documents.length !== 1) {
        throw new Error("Installed MCP fixture import failed.");
      }
    } finally {
      vault.close();
    }
  }

  const environment = { ...getDefaultEnvironment() };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_API_KEY",
  ]) {
    delete environment[name];
  }
  Object.assign(environment, {
    ELECTRON_RUN_AS_NODE: "1",
    HOME: environmentDirectories.HOME,
    USERPROFILE: environmentDirectories.USERPROFILE,
    APPDATA: environmentDirectories.APPDATA,
    LOCALAPPDATA: environmentDirectories.LOCALAPPDATA,
    TEMP: environmentDirectories.TEMP,
    TMP: environmentDirectories.TMP,
    NODE_NO_WARNINGS: "1",
    OWNCONTEXT_ALLOWED_COLLECTION: collection,
    OWNCONTEXT_CLIENT_KIND: "codex",
    ...(brokered
      ? { OWNCONTEXT_MCP_BROKER_PIPE: brokerPipe }
      : { OWNCONTEXT_VAULT_PATH: vaultPath }),
  });

  const transport = new StdioClientTransport({
    command: executable,
    args: [mcpEntry],
    cwd: dirname(mcpEntry),
    env: environment,
    stderr: "pipe",
  });
  let diagnosticBytes = 0;
  let diagnosticLimitExceeded = false;
  transport.stderr?.on("data", (chunk) => {
    diagnosticBytes += Buffer.byteLength(chunk);
    if (diagnosticBytes > MAX_DIAGNOSTIC_BYTES) diagnosticLimitExceeded = true;
  });

  const client = new Client({
    name: "owncontext-installed-lifecycle-smoke",
    version: "0.0.0",
  });
  try {
    await bounded(client.connect(transport));
    const tools = await bounded(client.listTools());
    if (tools.tools.map((tool) => tool.name).join(",") !== "search,fetch") {
      throw new Error("Installed MCP tool inventory changed.");
    }

    const search = await bounded(client.callTool({
      name: "search",
      arguments: { query: searchQuery, collection },
    }));
    const results = search.structuredContent?.results;
    if (
      search.isError === true ||
      !Array.isArray(results) ||
      results.length !== 1 ||
      !/^[0-9a-f]{64}$/u.test(results[0]?.documentId) ||
      !/^[0-9a-f]{64}$/u.test(results[0]?.chunkId)
    ) {
      throw new Error("Installed MCP search failed.");
    }

    const issued = results[0];
    const fetched = await bounded(client.callTool({
      name: "fetch",
      arguments: {
        documentId: issued.documentId,
        chunkId: issued.chunkId,
        maxChars: 10_000,
      },
    }));
    const document = fetched.structuredContent?.document;
    if (
      fetched.isError === true ||
      !document ||
      document.documentId !== issued.documentId ||
      !document.content.includes(searchQuery)
    ) {
      throw new Error("Installed MCP fetch failed.");
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  if (diagnosticLimitExceeded) {
    throw new Error("Installed MCP diagnostics exceeded their bound.");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    result: "PASS",
    control: brokered
      ? "installed-packaged-mcp-broker-search-fetch"
      : "installed-packaged-mcp-search-fetch",
    brokered,
    toolCalls: ["search", "fetch"],
    contentFreeEvidence: true,
  })}\n`);
}

main().catch(() => {
  process.stderr.write("Installed packaged MCP smoke failed.\n");
  process.exitCode = 1;
});
