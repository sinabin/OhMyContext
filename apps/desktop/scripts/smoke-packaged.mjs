import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  open,
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
import {
  createNodeSqliteDevelopmentStorageProvider,
  importDirectory,
  openVault,
} from "@owncontext/core";
import {
  WINDOWS_KEY_STORAGE_BOUNDARY,
  isPackagedKeyStorageSmokeResult,
} from "../../../scripts/key-storage-evidence-policy.mjs";
import { verifyCompliance } from "../../../scripts/release-compliance.mjs";
import {
  ENCRYPTED_VAULT_SMOKE_ARGUMENT,
  ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES,
  ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME,
  ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME,
  ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME,
  isEncryptedVaultSmokeResult,
} from "../dist-electron/encrypted-vault-smoke.js";
import {
  FORGE_BUILD_ID_ENV,
  validateForgeBuildIdentifier,
} from "./forge-build-id.mjs";
import {
  ENCRYPTED_SQLITE_NATIVE_SHA256,
  ENCRYPTED_SQLITE_PACKAGE_VERSION,
  ENCRYPTED_SQLITE_RUNTIME_MANIFEST,
  verifyEncryptedSqliteRuntime,
} from "./encrypted-sqlite-runtime.mjs";
import { assertOfflineNuspecMetadata } from "./nuspec-offline-policy.mjs";
import { verifySquirrelMakerProvenance } from "./squirrel-maker-provenance.mjs";
import { verifySquirrelPackageInventory } from "./squirrel-package-inventory.mjs";
import { resolveReleaseProfile } from "./release-profile.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptsDirectory, "..");
const projectRoot = resolve(desktopDirectory, "..", "..");
const outDirectory = resolve(desktopDirectory, "out");
const requireMaker = process.argv.includes("--require-maker");
const releaseProfile = resolveReleaseProfile();
const squirrelPackageName = releaseProfile.squirrelName;
const projectVersion = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
).version;
if (
  typeof projectVersion !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(projectVersion)
) {
  throw new Error("The root package version is not a valid semver.");
}
const applicationExecutableName = `${releaseProfile.executableName}.exe`;
const setupFileName = releaseProfile.setupExe;
const fullPackageFileName = `${squirrelPackageName}-${releaseProfile.publicRelease ? releaseProfile.version : projectVersion}-full.nupkg`;
const productMetadata = Object.freeze({
  executableName: releaseProfile.executableName,
  squirrelName: releaseProfile.squirrelName,
  version: releaseProfile.publicRelease ? releaseProfile.version : projectVersion,
  productName: releaseProfile.productName,
  description: releaseProfile.description,
  copyright: releaseProfile.copyright,
});
const keyStorageEvidenceFileName = "WINDOWS-KEY-STORAGE-SMOKE.json";
const maxNupkgCompressedBytes = 2 * 1024 * 1024 * 1024;
const maxNupkgEntryBytes = 2 * 1024 * 1024 * 1024;
const maxNupkgUncompressedBytes = 8 * 1024 * 1024 * 1024;
const maxNupkgEntries = 20_000;
const nupkgInspectionTimeoutMs = 60_000;
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
      releaseProfile.packagedDirectoryName,
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
          fullPackageFileName,
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

function inspectNupkgEntries(nupkgPath) {
  const powershell = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$path = [Environment]::GetEnvironmentVariable('OWNCONTEXT_SMOKE_NUPKG_PATH')",
    `$maxCompressedBytes = [int64]${maxNupkgCompressedBytes}`,
    `$maxEntryBytes = [int64]${maxNupkgEntryBytes}`,
    `$maxUncompressedBytes = [int64]${maxNupkgUncompressedBytes}`,
    `$maxEntries = ${maxNupkgEntries}`,
    "if ((Get-Item -LiteralPath $path).Length -gt $maxCompressedBytes) { throw 'Squirrel package exceeds compressed-size limit.' }",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($path)",
    "try {",
    "  if ($archive.Entries.Count -gt $maxEntries) { throw 'Squirrel package exceeds entry-count limit.' }",
    "  $totalLength = [int64]0",
    "  $items = @()",
    "  foreach ($entry in $archive.Entries) {",
    "    if ($entry.Length -lt 0 -or $entry.Length -gt $maxEntryBytes) { throw 'Squirrel package entry exceeds size limit.' }",
    "    $totalLength += $entry.Length",
    "    if ($totalLength -gt $maxUncompressedBytes) { throw 'Squirrel package exceeds uncompressed-size limit.' }",
    "    $stream = $entry.Open()",
    "    $sha = [System.Security.Cryptography.SHA256]::Create()",
    "    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }",
    "    $nuspecText = $null",
    "    if ($entry.FullName -match '^[^/]+[.]nuspec$') {",
    "      if ($entry.Length -gt 65536) { throw 'Squirrel NuSpec exceeds metadata-size limit.' }",
    "      $textStream = $entry.Open()",
    "      $reader = [System.IO.StreamReader]::new($textStream, [System.Text.UTF8Encoding]::new($false, $true), $true, 4096, $false)",
    "      try { $nuspecText = $reader.ReadToEnd() } finally { $reader.Dispose(); $textStream.Dispose() }",
    "    }",
    "    $items += [PSCustomObject]@{ name = $entry.FullName; length = $entry.Length; sha256 = $hash; directory = ($entry.Name.Length -eq 0); nuspecText = $nuspecText }",
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
      timeout: nupkgInspectionTimeoutMs,
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
    typeof entry.sha256 === "string" &&
    typeof entry.directory === "boolean" &&
    (entry.nuspecText === null || typeof entry.nuspecText === "string")
  )) {
    throw new Error("The Squirrel package compliance inventory is malformed.");
  }
  // Preserve the archive spelling exactly. The verifier deliberately rejects
  // backslashes and other non-canonical ZIP paths instead of normalizing an
  // unsafe entry into an expected payload path.
  return entries;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readStableBoundedFile(path, maximumBytes) {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error("Packaged smoke evidence is not a bounded regular file.");
  }
  const handle = await open(path, "r");
  const bytes = Buffer.alloc(Number(before.size));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("Packaged smoke evidence changed before reading.");
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead <= 0) throw new Error("Packaged smoke evidence was truncated.");
      offset += bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size
    ) {
      throw new Error("Packaged smoke evidence changed while reading.");
    }
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
  const after = await lstat(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1n ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size
  ) {
    bytes.fill(0);
    throw new Error("Packaged smoke evidence changed after reading.");
  }
  return bytes;
}

async function inventoryPackagedFiles(root) {
  const files = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const metadata = await lstat(absolutePath);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (metadata.isSymbolicLink()) {
        throw new Error(`Packaged payload contains a symbolic link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        directories.push(absolutePath);
      } else if (metadata.isFile()) {
        files.push({
          relativePath,
          length: metadata.size,
          sha256: await sha256File(absolutePath),
        });
      } else {
        throw new Error(`Packaged payload contains a special file: ${relativePath}`);
      }
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(
    right.relativePath,
    "en-US",
  ));
  return files;
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
    result.status !== "first-run-sample-search-and-connections-preview-complete" ||
    result.nonce !== nonce ||
    result.isPackaged !== true ||
    result.sampleSourceReady !== true ||
    result.sampleSourceLabel !== "OwnContext Sample Library" ||
    result.suggestedQuery !== "weekly review" ||
    result.sampleProvenanceVerified !== true ||
    result.connectionsScreenReady !== true ||
    result.codexConnectionCardReady !== true ||
    result.claudeCodeConnectionCardReady !== true ||
    result.externalTransferBoundaryVisible !== true ||
    result.accessHistoryScreenReady !== true ||
    result.desktopHistoryEntryReady !== true ||
    result.contentFreeHistoryBoundaryVisible !== true ||
    !Number.isInteger(result.resultCardCount) ||
    result.resultCardCount < 1 ||
    result.resultCardCount > 12
  ) {
    throw new Error("Packaged GUI first-run journey evidence is invalid.");
  }
}

async function runWindowsKeyStorageSmoke(executable, temporaryRoot) {
  const smokeRoot = resolve(temporaryRoot, "windows-key-storage");
  await mkdir(smokeRoot);
  const nonce = randomUUID();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OWNCONTEXT_KEY_STORAGE_SMOKE_ROOT = smokeRoot;
  environment.OWNCONTEXT_KEY_STORAGE_SMOKE_NONCE = nonce;

  const child = spawn(executable, ["--owncontext-key-storage-smoke"], {
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
      rejectPromise(new Error(
        timedOut
          ? "Packaged Windows key-storage smoke timed out."
          : `Packaged Windows key-storage smoke failed (${signal ?? String(code)}).`,
      ));
    });
  });

  const resultPath = resolve(smokeRoot, "key-storage-smoke.json");
  const resultMetadata = await stat(resultPath);
  if (!resultMetadata.isFile() || resultMetadata.size < 1 || resultMetadata.size > 16 * 1024) {
    throw new Error("Packaged Windows key-storage evidence is not a bounded file.");
  }
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  if (!isPackagedKeyStorageSmokeResult(result, nonce)) {
    throw new Error("Packaged Windows key-storage evidence is invalid.");
  }
  return result;
}

async function runWindowsEncryptedVaultSmoke(executable, temporaryRoot) {
  const smokeRoot = resolve(temporaryRoot, "windows-encrypted-vault");
  await mkdir(smokeRoot);
  const nonce = randomUUID();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment[ENCRYPTED_VAULT_SMOKE_ROOT_ENVIRONMENT_NAME] = smokeRoot;
  environment[ENCRYPTED_VAULT_SMOKE_NONCE_ENVIRONMENT_NAME] = nonce;

  const child = spawn(executable, [ENCRYPTED_VAULT_SMOKE_ARGUMENT], {
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
    }, 60_000);
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
      rejectPromise(new Error(
        timedOut
          ? "Packaged Windows encrypted-vault smoke timed out."
          : `Packaged Windows encrypted-vault smoke failed (${signal ?? String(code)}).`,
      ));
    });
  });

  const resultPath = resolve(smokeRoot, ENCRYPTED_VAULT_SMOKE_RESULT_FILE_NAME);
  const bytes = await readStableBoundedFile(
    resultPath,
    ENCRYPTED_VAULT_SMOKE_MAX_RESULT_BYTES,
  );
  try {
    const result = JSON.parse(bytes.toString("utf8"));
    const canonical = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
    try {
      if (
        !bytes.equals(canonical) ||
        !isEncryptedVaultSmokeResult(result, nonce)
      ) {
        throw new Error("Packaged Windows encrypted-vault evidence is invalid.");
      }
      return result;
    } finally {
      canonical.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

async function writeWindowsKeyStorageEvidence(buildDirectory, result) {
  const evidence = {
    schemaVersion: 2,
    status: "DRAFT — NOT FOR PUBLIC RELEASE",
    control: "windows-safe-storage-key-envelope-spike",
    result: "PASS",
    runtime: {
      platform: result.platform,
      architecture: result.architecture,
      isPackaged: result.isPackaged,
    },
    protector: {
      providerId: result.providerId,
      asyncAvailable: result.safeStorageAsyncAvailable,
    },
    envelope: {
      schemaVersion: result.envelopeSchemaVersion,
      keyBytes: result.keyBytes,
      persisted: result.envelopePersisted,
      knownPlaintextEncodingsAbsent: result.knownPlaintextEncodingsAbsent,
      roundTripMatched: result.roundTripMatched,
      shouldReEncrypt: result.shouldReEncrypt,
    },
    boundary: WINDOWS_KEY_STORAGE_BOUNDARY,
  };
  await writeFile(
    resolve(buildDirectory, "evidence", keyStorageEvidenceFileName),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The packaged smoke test requires a Windows x64 host.");
}

const packagedDirectory = await findPackagedDirectory();
const buildDirectory = dirname(packagedDirectory);
const executable = resolve(packagedDirectory, applicationExecutableName);
const resources = resolve(packagedDirectory, "resources");
const asarPath = resolve(resources, "app.asar");
const mcpEntry = resolve(resources, "mcp-server", "cli.mjs");
const manifestPath = resolve(resources, "mcp-server", "runtime-manifest.json");
const encryptedSqliteRuntime = resolve(resources, "encrypted-sqlite-runtime");
const encryptedSqliteManifestPath = resolve(
  encryptedSqliteRuntime,
  ENCRYPTED_SQLITE_RUNTIME_MANIFEST,
);
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
  encryptedSqliteManifestPath,
  noticePath,
  ...compliancePaths,
]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Packaged runtime is missing ${basename(requiredPath)}.`);
  }
}

if (requireMaker) {
  const makerDirectory = resolve(buildDirectory, "make", "squirrel.windows", "x64");
  const nupkgPath = resolve(makerDirectory, fullPackageFileName);
  const nupkgEntries = inspectNupkgEntries(nupkgPath);
  const nuspecEntries = nupkgEntries.filter((entry) => entry.nuspecText !== null);
  if (nuspecEntries.length !== 1) {
    throw new Error(
      "Squirrel package metadata would make installation depend on an external icon download.",
    );
  }
  assertOfflineNuspecMetadata(nuspecEntries[0].nuspecText);
  const payloadFiles = await inventoryPackagedFiles(packagedDirectory);
  verifySquirrelPackageInventory({
    payloadFiles,
    nupkgEntries,
    packageName: squirrelPackageName,
    applicationExecutableName,
  });
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
  await verifySquirrelMakerProvenance({
    makerDirectory,
    electronWinstallerDirectory: resolve(projectRoot, "node_modules", "electron-winstaller"),
    manifestPath: resolve(desktopDirectory, "packaging", "squirrel-maker-inputs.json"),
    setupFileName,
    fullPackageFileName,
    applicationExecutableName,
    product: productMetadata,
    evidenceRoot: buildDirectory,
    evidencePath: resolve(
      buildDirectory,
      "evidence",
      "SQUIRREL-MAKER-PROVENANCE.json",
    ),
  });
}

const encryptedSqliteEvidence = await verifyEncryptedSqliteRuntime({
  targetDirectory: encryptedSqliteRuntime,
});
if (
  encryptedSqliteEvidence.packageVersion !== ENCRYPTED_SQLITE_PACKAGE_VERSION ||
  encryptedSqliteEvidence.nativeSha256 !== ENCRYPTED_SQLITE_NATIVE_SHA256 ||
  encryptedSqliteEvidence.manifest.boundary.publicDistributionApproved !== false
) {
  throw new Error("Packaged encrypted SQLite developer candidate is invalid.");
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
  await runWindowsEncryptedVaultSmoke(executable, temporaryRoot);
  const keyStorageResult = await runWindowsKeyStorageSmoke(
    executable,
    temporaryRoot,
  );
  if (requireMaker) {
    await writeWindowsKeyStorageEvidence(buildDirectory, keyStorageResult);
  }
  await runGuiSmoke(executable, temporaryRoot);
  await mkdir(fixtureDirectory);
  await writeFile(
    resolve(fixtureDirectory, "packaged-smoke.md"),
    `# Packaged smoke fixture\n\nThe ${fixtureToken} proves import, search, and fetch.\n`,
    "utf8",
  );
  const seedVault = openVault(
    vaultPath,
    createNodeSqliteDevelopmentStorageProvider(),
  );
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
      OWNCONTEXT_ALLOWED_COLLECTION: "packaged-smoke",
      OWNCONTEXT_CLIENT_KIND: "codex",
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
