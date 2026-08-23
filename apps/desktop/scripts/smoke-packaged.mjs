import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { importDirectory, openVault } from "@owncontext/core";
import { verifyCompliance } from "../../../scripts/release-compliance.mjs";
import {
  FORGE_BUILD_ID_ENV,
  validateForgeBuildIdentifier,
} from "./forge-build-id.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptsDirectory, "..");
const projectRoot = resolve(desktopDirectory, "..", "..");
const outDirectory = resolve(desktopDirectory, "out");
const requireMaker = process.argv.includes("--require-maker");
const complianceNames = [
  "THIRD_PARTY_NOTICES.txt",
  "SBOM.spdx.json",
  "SHA256SUMS",
];

function requireTemporaryRoot(candidate) {
  const base = resolve(tmpdir());
  const target = resolve(candidate);
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  if (
    normalizedTarget === normalizedBase ||
    !normalizedTarget.startsWith(`${normalizedBase}${sep}`)
  ) {
    throw new Error("Refusing to remove a path outside the OS temporary folder.");
  }
  return target;
}

async function findPackagedDirectory() {
  const requestedBuild = process.env[FORGE_BUILD_ID_ENV];
  if (requestedBuild !== undefined) {
    const buildIdentifier = validateForgeBuildIdentifier(requestedBuild);
    const requestedPackage = resolve(
      outDirectory,
      buildIdentifier,
      "OwnContext Developer Preview-win32-x64",
    );
    const metadata = await stat(requestedPackage);
    if (!metadata.isDirectory()) {
      throw new Error("The requested Forge package path is not a directory.");
    }
    return requestedPackage;
  }

  const candidates = [];

  async function visit(directory, remainingDepth) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = resolve(directory, entry.name);
      if (entry.name.endsWith("-win32-x64")) {
        const makerPackage = resolve(
          dirname(child),
          "make",
          "squirrel.windows",
          "x64",
          "OwnContextDeveloperPreview-0.0.0-full.nupkg",
        );
        if (!requireMaker || existsSync(makerPackage)) candidates.push(child);
      } else if (remainingDepth > 0 && entry.name !== "make") {
        await visit(child, remainingDepth - 1);
      }
    }
  }

  await visit(outDirectory, 2);
  if (candidates.length === 0) {
    throw new Error("No packaged win32-x64 directory was found.");
  }
  const dated = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      modifiedAt: (await stat(candidate)).mtimeMs,
    })),
  );
  dated.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return dated[0].candidate;
}

function inspectNupkgCompliance(nupkgPath) {
  const powershell = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$path = [Environment]::GetEnvironmentVariable('OWNCONTEXT_SMOKE_NUPKG_PATH')",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($path)",
    "try {",
    "  $items = @()",
    "  foreach ($entry in $archive.Entries) {",
    "    if ($entry.FullName -like 'lib/net45/resources/compliance/*' -and $entry.Length -gt 0) {",
    "      $stream = $entry.Open()",
    "      $sha = [System.Security.Cryptography.SHA256]::Create()",
    "      try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }",
    "      $items += [PSCustomObject]@{ name = $entry.FullName; length = $entry.Length; sha256 = $hash }",
    "    }",
    "  }",
    "  [Console]::Out.Write((ConvertTo-Json -InputObject @($items) -Compress))",
    "} finally { $archive.Dispose() }",
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OWNCONTEXT_SMOKE_NUPKG_PATH: nupkgPath,
      },
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Cannot inspect the Squirrel package (${result.stderr.trim() || `exit ${result.status}`}).`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (!entries.every((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof entry.name === "string" &&
    Number.isSafeInteger(entry.length) &&
    typeof entry.sha256 === "string"
  )) {
    throw new Error("The Squirrel package compliance inventory is malformed.");
  }
  return entries.map((entry) => ({
    ...entry,
    name: entry.name.replaceAll("\\", "/"),
  }));
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runGuiSmoke(executable, temporaryRoot) {
  const nonce = randomUUID();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OWNCONTEXT_GUI_SMOKE_ROOT = temporaryRoot;
  environment.OWNCONTEXT_GUI_SMOKE_NONCE = nonce;

  const child = spawn(executable, ["--owncontext-gui-smoke"], {
    cwd: dirname(executable),
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          timedOut
            ? "Packaged GUI renderer smoke timed out."
            : `Packaged GUI renderer smoke failed (${signal ?? String(code)}).`,
        ),
      );
    });
  });

  const result = JSON.parse(
    await readFile(resolve(temporaryRoot, "renderer-ready.json"), "utf8"),
  );
  if (
    result.status !== "renderer-loaded" ||
    result.nonce !== nonce ||
    result.isPackaged !== true
  ) {
    throw new Error("Packaged GUI renderer readiness evidence is invalid.");
  }
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The packaged smoke test requires a Windows x64 host.");
}

const packagedDirectory = await findPackagedDirectory();
const buildDirectory = dirname(packagedDirectory);
const executable = resolve(packagedDirectory, "OwnContextDeveloperPreview.exe");
const resources = resolve(packagedDirectory, "resources");
const asarPath = resolve(resources, "app.asar");
const mcpEntry = resolve(resources, "mcp-server", "cli.mjs");
const manifestPath = resolve(resources, "mcp-server", "runtime-manifest.json");
const noticePath = resolve(resources, "UNSIGNED-DEVELOPER-PREVIEW.txt");
const complianceDirectory = resolve(resources, "compliance");
const compliancePaths = complianceNames.map((name) =>
  resolve(complianceDirectory, name),
);

for (const requiredPath of [
  executable,
  asarPath,
  mcpEntry,
  manifestPath,
  noticePath,
  ...compliancePaths,
]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Packaged runtime is missing ${basename(requiredPath)}.`);
  }
}

if (requireMaker) {
  const makerDirectory = resolve(buildDirectory, "make", "squirrel.windows", "x64");
  const makerFiles = await readdir(makerDirectory);
  const requiredMakerFiles = [
    "OwnContext-Developer-Preview-Unsigned-Setup.exe",
    "OwnContextDeveloperPreview-0.0.0-full.nupkg",
    "RELEASES",
  ];
  for (const requiredFile of requiredMakerFiles) {
    if (!makerFiles.includes(requiredFile)) {
      throw new Error(`Squirrel output is missing ${requiredFile}.`);
    }
  }
  const releases = await readFile(resolve(makerDirectory, "RELEASES"), "utf8");
  if (!releases.includes("OwnContextDeveloperPreview-0.0.0-full.nupkg")) {
    throw new Error("Squirrel RELEASES metadata does not reference the full package.");
  }
  const nupkgPath = resolve(
    makerDirectory,
    "OwnContextDeveloperPreview-0.0.0-full.nupkg",
  );
  const nupkgEntries = inspectNupkgCompliance(nupkgPath);
  for (const [index, complianceName] of complianceNames.entries()) {
    const expectedEntry = `lib/net45/resources/compliance/${complianceName}`;
    const embedded = nupkgEntries.find((entry) => entry.name === expectedEntry);
    if (!embedded) {
      throw new Error(
        `Squirrel package is missing embedded compliance evidence: ${complianceName}.`,
      );
    }
    const packagedBytes = (await stat(compliancePaths[index])).size;
    const packagedHash = await sha256File(compliancePaths[index]);
    if (embedded.length !== packagedBytes || embedded.sha256 !== packagedHash) {
      throw new Error(
        `Squirrel package compliance evidence differs from the verified payload: ${complianceName}.`,
      );
    }
  }
}

await verifyCompliance({
  artifactPath: packagedDirectory,
  projectRoot,
  outputPath: complianceDirectory,
  draft: true,
});

const notice = await readFile(noticePath, "utf8");
if (!notice.includes("UNSIGNED") || !notice.includes("non-sensitive")) {
  throw new Error("Packaged developer-preview notice is incomplete.");
}

const temporaryRoot = requireTemporaryRoot(
  await mkdtemp(join(tmpdir(), "owncontext-packaged-smoke-")),
);
const vaultPath = resolve(temporaryRoot, "vault.sqlite");
const fixtureDirectory = resolve(temporaryRoot, "fixture-source");
const fixtureToken = "packagedfixturetoken";

try {
  await runGuiSmoke(executable, temporaryRoot);
  await mkdir(fixtureDirectory);
  await writeFile(
    resolve(fixtureDirectory, "packaged-smoke.md"),
    `# Packaged smoke fixture\n\nThe ${fixtureToken} proves import, search, and fetch.\n`,
    "utf8",
  );
  const seedVault = openVault(vaultPath);
  try {
    const imported = await importDirectory(seedVault, fixtureDirectory, {
      collection: "packaged-smoke",
    });
    if (imported.imported !== 1 || imported.documents.length !== 1) {
      throw new Error("Packaged smoke fixture import did not create one document.");
    }
  } finally {
    seedVault.close();
  }

  const transport = new StdioClientTransport({
    command: executable,
    args: [mcpEntry],
    cwd: dirname(mcpEntry),
    env: {
      ...getDefaultEnvironment(),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_NO_WARNINGS: "1",
      OWNCONTEXT_VAULT_PATH: vaultPath,
    },
    stderr: "pipe",
  });
  const diagnostics = [];
  transport.stderr?.on("data", (chunk) => diagnostics.push(chunk.toString("utf8")));
  const client = new Client({
    name: "owncontext-packaged-smoke",
    version: "0.0.0",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (toolNames.join(",") !== "search,fetch") {
      throw new Error(`Unexpected packaged MCP tools: ${toolNames.join(",")}`);
    }
    const search = await client.callTool({
      name: "search",
      arguments: { query: fixtureToken, collection: "packaged-smoke" },
    });
    const results = search.structuredContent?.results;
    if (
      search.isError === true ||
      !Array.isArray(results) ||
      results.length !== 1 ||
      !/^[0-9a-f]{64}$/u.test(results[0]?.documentId) ||
      !/^[0-9a-f]{64}$/u.test(results[0]?.chunkId)
    ) {
      throw new Error("Packaged MCP search did not complete successfully.");
    }
    const issued = results[0];
    const fetched = await client.callTool({
      name: "fetch",
      arguments: {
        documentId: issued.documentId,
        chunkId: issued.chunkId,
        maxChars: 10_000,
      },
    });
    const document = fetched.structuredContent?.document;
    if (
      fetched.isError === true ||
      !document ||
      document.documentId !== issued.documentId ||
      !document.content.includes(fixtureToken)
    ) {
      throw new Error("Packaged MCP fetch did not return the search-issued document.");
    }
  } finally {
    await client.close();
  }

  if (diagnostics.join("").includes("startup failed")) {
    throw new Error("Packaged MCP emitted a startup failure diagnostic.");
  }
} finally {
  await rm(requireTemporaryRoot(temporaryRoot), { recursive: true, force: true });
}

const relativePackage = relative(desktopDirectory, packagedDirectory).split(sep).join("/");
process.stdout.write(`Packaged smoke passed: ${relativePackage}\n`);
