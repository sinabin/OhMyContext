import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const PACKAGED_CLIENT_SMOKE_TIMEOUT_MS = 30_000;
export const PACKAGED_CLIENT_SMOKE_MAX_OUTPUT_BYTES = 64 * 1024;

const MAX_PATH_BYTES = 4096;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_ARGUMENTS = 32;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_RELEASE_EVIDENCE_BYTES = 128 * 1024;
const MAX_PAYLOAD_CHECKSUM_BYTES = 1024 * 1024;
const MAX_PACKAGED_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGED_MCP_BYTES = 256 * 1024 * 1024;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const CREDENTIAL_ENVIRONMENT_PATTERN =
  /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH_TOKEN|SESSION_TOKEN|SECRET)$/iu;

const CLIENT_ENVIRONMENT_KEYS = [
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "WINDIR",
];

export class PackagedClientSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "PackagedClientSmokeError";
    this.code = code;
  }
}

export async function resolveSourceBoundPackagedBuild({
  buildIdentifier,
  outDirectory,
  validateBuildIdentifier,
}) {
  const validatedIdentifier = validateBuildIdentifier(buildIdentifier);
  const publicBuild = validatedIdentifier.startsWith("public-");
  const packagedDirectoryName = publicBuild
    ? "OwnContext-win32-x64"
    : "OwnContext Developer Preview-win32-x64";
  const executableName = publicBuild ? "OwnContext.exe" : "OwnContextDeveloperPreview.exe";
  const canonicalOut = await resolveSafeWindowsDirectory(outDirectory);
  if (!canonicalOut) throw new PackagedClientSmokeError("unsafe_out_directory");

  const buildDirectory = await resolveSafeWindowsDirectory(
    join(canonicalOut, validatedIdentifier),
  );
  if (!buildDirectory || !isStrictDescendant(canonicalOut, buildDirectory)) {
    throw new PackagedClientSmokeError("missing_explicit_build");
  }

  const packagedDirectory = await resolveSafeWindowsDirectory(
    join(buildDirectory, packagedDirectoryName),
  );
  if (!packagedDirectory || !isStrictDescendant(buildDirectory, packagedDirectory)) {
    throw new PackagedClientSmokeError("missing_packaged_directory");
  }

  const executable = await resolveLocalRegularFileWithin(
    packagedDirectory,
    join(packagedDirectory, executableName),
  );
  const resourcesDirectory = await resolveSafeWindowsDirectory(
    join(packagedDirectory, "resources"),
  );
  if (
    !executable ||
    !resourcesDirectory ||
    !isStrictDescendant(packagedDirectory, resourcesDirectory)
  ) {
    throw new PackagedClientSmokeError("missing_packaged_runtime");
  }

  const mcpServerDirectory = await resolveSafeWindowsDirectory(
    join(resourcesDirectory, "mcp-server"),
  );
  if (
    !mcpServerDirectory ||
    !isStrictDescendant(resourcesDirectory, mcpServerDirectory)
  ) {
    throw new PackagedClientSmokeError("missing_packaged_mcp_entry");
  }
  const mcpEntry = await resolveLocalRegularFileWithin(
    mcpServerDirectory,
    join(mcpServerDirectory, "cli.mjs"),
  );
  if (!mcpEntry) {
    throw new PackagedClientSmokeError("missing_packaged_mcp_entry");
  }

  const evidenceDirectory = await resolveSafeWindowsDirectory(
    join(buildDirectory, "evidence"),
  );
  const evidencePath = evidenceDirectory && isStrictDescendant(
    buildDirectory,
    evidenceDirectory,
  ) ? await resolveLocalRegularFileWithin(
    evidenceDirectory,
    join(evidenceDirectory, "OWNCONTEXT-RELEASE-CANDIDATE.json"),
  ) : undefined;
  if (!evidencePath) {
    throw new PackagedClientSmokeError("missing_source_bound_evidence");
  }
  const evidence = await readBoundedJson(
    evidencePath,
    MAX_RELEASE_EVIDENCE_BYTES,
    "invalid_source_bound_evidence",
  );
  const commit = evidence?.source?.commit;
  const version = evidence?.release?.version;
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.status !== "DRAFT — NOT FOR PUBLIC RELEASE" ||
    evidence?.source?.trackedWorktreeClean !== true ||
    typeof commit !== "string" ||
    !SOURCE_COMMIT_PATTERN.test(commit) ||
    evidence?.release?.platform !== "Windows x64" ||
    evidence?.release?.publicRelease !== false ||
    typeof version !== "string" ||
    !SEMVER_PATTERN.test(version) ||
    evidence?.release?.releaseId !==
      `owncontext-v${version}-windows-x64-${commit.slice(0, 12)}-draft`
  ) {
    throw new PackagedClientSmokeError("invalid_source_bound_evidence");
  }
  await verifySourceBoundRuntime({
    evidence,
    packagedDirectory,
    resourcesDirectory,
    executable,
    mcpEntry,
  });

  return Object.freeze({
    buildDirectory,
    packagedDirectory,
    executable,
    mcpEntry,
    sourceCommit: commit,
  });
}

/**
 * Finds only a native Codex executable. Windows npm/cmd shims are deliberately
 * excluded so a bounded timeout can terminate the process it actually started.
 */
export async function discoverCodexNativeCommand({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") return undefined;
  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (!pathValue) return undefined;

  const configuredDirectories = [...new Set(
    pathValue
      .split(platform === "win32" ? ";" : ":")
      .filter((directory) => isSafeWindowsDrivePath(directory)),
  )];
  const directories = [];
  const seen = new Set();
  for (const configuredDirectory of configuredDirectories) {
    const directory = await resolveSafeWindowsDirectory(configuredDirectory);
    const key = directory?.toLocaleLowerCase("en-US");
    if (directory && key && !seen.has(key)) {
      directories.push(directory);
      seen.add(key);
    }
  }

  for (const directory of directories) {
    const executable = await resolveNpmCodexNativeExecutable(directory);
    if (executable) return Object.freeze({ commandPath: executable, prefixArgs: [] });
  }
  return undefined;
}

/**
 * Finds only the native Windows binary bound to the official Claude Code npm
 * package layout. A standalone claude.exe on PATH is intentionally rejected.
 */
export async function discoverClaudeNpmNativeCommand({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") return undefined;
  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (!pathValue) return undefined;

  const configuredDirectories = [...new Set(
    pathValue
      .split(";")
      .filter((directory) => isSafeWindowsDrivePath(directory)),
  )];
  const directories = [];
  const seen = new Set();
  for (const configuredDirectory of configuredDirectories) {
    const directory = await resolveSafeWindowsDirectory(configuredDirectory);
    const key = directory?.toLocaleLowerCase("en-US");
    if (directory && key && !seen.has(key)) {
      directories.push(directory);
      seen.add(key);
    }
  }

  for (const directory of directories) {
    const executable = await resolveNpmClaudeNativeExecutable(directory);
    if (executable) return Object.freeze({ commandPath: executable, prefixArgs: [] });
  }
  return undefined;
}

export function createIsolatedClientEnvironment(
  source,
  { homeDirectory, codexHome, claudeConfigDirectory },
) {
  if (
    !isSafeWindowsDrivePath(homeDirectory) ||
    (codexHome !== undefined && !isSafeWindowsDrivePath(codexHome)) ||
    (claudeConfigDirectory !== undefined &&
      !isSafeWindowsDrivePath(claudeConfigDirectory))
  ) {
    throw new PackagedClientSmokeError("invalid_isolated_environment");
  }

  const result = {};
  for (const key of CLIENT_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (
      value !== undefined &&
      !CREDENTIAL_ENVIRONMENT_PATTERN.test(key) &&
      !value.includes("\0") &&
      Buffer.byteLength(value, "utf8") <= MAX_ARGUMENT_BYTES
    ) {
      result[key] = value;
    }
  }
  result.HOME = homeDirectory;
  result.USERPROFILE = homeDirectory;
  result.APPDATA = join(homeDirectory, "AppData", "Roaming");
  result.LOCALAPPDATA = join(homeDirectory, "AppData", "Local");
  result.TEMP = join(homeDirectory, "Temp");
  result.TMP = join(homeDirectory, "Temp");
  if (codexHome !== undefined) result.CODEX_HOME = codexHome;
  if (claudeConfigDirectory !== undefined) {
    result.CLAUDE_CONFIG_DIR = claudeConfigDirectory;
    result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    result.DISABLE_AUTOUPDATER = "1";
    result.DISABLE_ERROR_REPORTING = "1";
    result.DISABLE_TELEMETRY = "1";
  }
  return Object.freeze(result);
}

export function runBoundedCommand({
  commandPath,
  args,
  environment,
  timeoutMs = PACKAGED_CLIENT_SMOKE_TIMEOUT_MS,
  maxStdoutBytes = PACKAGED_CLIENT_SMOKE_MAX_OUTPUT_BYTES,
  maxStderrBytes = PACKAGED_CLIENT_SMOKE_MAX_OUTPUT_BYTES,
}) {
  validateCommandRequest({
    commandPath,
    args,
    environment,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    let terminalSettleTimer;

    const child = spawn(commandPath, [...args], {
      env: { ...environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
        const taskkillPath = join(
          environment.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        );
        spawnSync(
          taskkillPath,
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", timeout: 5_000, windowsHide: true },
        );
      } else {
        child.kill("SIGKILL");
      }
    };
    const forceTerminalSettle = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.removeAllListeners("close");
      child.removeAllListeners("error");
      child.once("error", () => undefined);
      child.unref();
      finish({
        processId: Number.isSafeInteger(child.pid) ? child.pid : null,
        exitCode: null,
        timedOut,
        outputLimitExceeded,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminalSettleTimer !== undefined) clearTimeout(terminalSettleTimer);
      if (error) rejectPromise(new PackagedClientSmokeError("client_process_failed"));
      else resolvePromise(result);
    };
    const stopForOutputLimit = () => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      terminate();
      terminalSettleTimer = setTimeout(forceTerminalSettle, 5_000);
    };

    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes <= maxStdoutBytes) stdout.push(bytes);
      else stopForOutputLimit();
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes <= maxStderrBytes) stderr.push(bytes);
      else stopForOutputLimit();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
      terminalSettleTimer ??= setTimeout(forceTerminalSettle, 5_000);
    }, timeoutMs);
    child.once("error", (error) => finish(undefined, error));
    child.once("close", (exitCode) => finish({
      processId: Number.isSafeInteger(child.pid) ? child.pid : null,
      exitCode,
      timedOut,
      outputLimitExceeded,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

export function assertCodexConfigParse(output, expectedLaunch) {
  let record;
  try {
    record = JSON.parse(output);
  } catch {
    throw new PackagedClientSmokeError("codex_config_output_invalid");
  }
  if (!isJsonObject(record)) {
    throw new PackagedClientSmokeError("codex_config_output_invalid");
  }

  const transport = isJsonObject(record.transport) ? record.transport : record;
  const rawEnvironment = transport.env ?? transport.environment;
  const environment = normalizeStringMap(rawEnvironment);
  const expectedEnvironment = {
    ELECTRON_RUN_AS_NODE: "1",
    OWNCONTEXT_ALLOWED_COLLECTION: expectedLaunch.allowedCollection,
    OWNCONTEXT_CLIENT_KIND: "codex",
    OWNCONTEXT_VAULT_PATH: expectedLaunch.vaultPath,
  };
  if (
    (record.name !== undefined && record.name !== "owncontext") ||
    (record.enabled !== undefined && record.enabled !== true) ||
    (transport.type !== undefined && transport.type !== "stdio") ||
    transport.command !== expectedLaunch.commandPath ||
    !stringArraysEqual(transport.args, expectedLaunch.args) ||
    !stringMapsEqual(environment, expectedEnvironment)
  ) {
    throw new PackagedClientSmokeError("codex_config_mismatch");
  }
}

export function assertClaudeMcpHealth(output) {
  const lines = stripAnsi(output)
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const headers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^owncontext:\s*$/iu.test(line));
  if (headers.length !== 1) {
    throw new PackagedClientSmokeError("claude_mcp_health_unverified");
  }
  const start = headers[0].index + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].length > 0 && !/^\s/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const statuses = lines.slice(start, end).filter((line) => /^\s+Status\s*:/iu.test(line));
  if (
    statuses.length !== 1 ||
    !/^\s+Status\s*:\s*(?:√|✓|✔)\s+Connected\s*$/iu.test(statuses[0])
  ) {
    throw new PackagedClientSmokeError("claude_mcp_health_unverified");
  }
}

export async function listPackagedMcpProcessIds({
  executable,
  mcpEntry,
  environment,
}) {
  if (!isSafeWindowsDrivePath(executable) || !isSafeWindowsDrivePath(mcpEntry)) {
    throw new PackagedClientSmokeError("invalid_process_probe_target");
  }
  const powershell = [
    "$ErrorActionPreference = 'Stop'",
    "$targetExecutable = [Environment]::GetEnvironmentVariable('OWNCONTEXT_SMOKE_EXECUTABLE')",
    "$targetProcessName = [Environment]::GetEnvironmentVariable('OWNCONTEXT_SMOKE_PROCESS_NAME')",
    "$records = @(Get-CimInstance Win32_Process -Filter \"Name='$targetProcessName'\" | ForEach-Object {",
    "  if (-not $_.ExecutablePath -or -not $_.CommandLine) { return }",
    "  if ([string]::Equals($_.ExecutablePath, $targetExecutable, [StringComparison]::OrdinalIgnoreCase)) {",
    "    [ordered]@{",
    "      processId = [int]$_.ProcessId",
    "      parentProcessId = [int]$_.ParentProcessId",
    "      commandLine = [string]$_.CommandLine",
    "    }",
    "  }",
    "} | Sort-Object -Property processId -Unique)",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $records -Compress))",
  ].join("\n");
  const result = await runBoundedCommand({
    commandPath: join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell],
    environment: {
      ...environment,
      OWNCONTEXT_SMOKE_EXECUTABLE: executable,
      OWNCONTEXT_SMOKE_PROCESS_NAME: basename(executable),
  },
    timeoutMs: 10_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
    throw new PackagedClientSmokeError("process_probe_failed");
  }
  let records;
  try {
    records = JSON.parse(result.stdout || "[]");
  } catch {
    throw new PackagedClientSmokeError("process_probe_failed");
  }
  const values = Array.isArray(records) ? records : [records];
  if (!values.every((record) =>
    isJsonObject(record) &&
    Number.isSafeInteger(record.processId) &&
    record.processId > 0 &&
    Number.isSafeInteger(record.parentProcessId) &&
    record.parentProcessId >= 0 &&
    typeof record.commandLine === "string"
  )) {
    throw new PackagedClientSmokeError("process_probe_failed");
  }
  const exact = values.filter((record) => {
    const argumentsList = parseWindowsCommandLine(record.commandLine);
    return (
      argumentsList.length === 2 &&
      argumentsList[0].toLocaleLowerCase("en-US") ===
        executable.toLocaleLowerCase("en-US") &&
      argumentsList[1].toLocaleLowerCase("en-US") ===
        mcpEntry.toLocaleLowerCase("en-US")
    );
  });
  return new Map(exact.map((record) => [record.processId, record.parentProcessId]));
}

export async function assertNoNewPackagedMcpProcess(
  baseline,
  targets,
  { attempts = 20, intervalMs = 100 } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await listPackagedMcpProcessIds(targets);
    const newIds = [...current.keys()].filter((id) => !baseline.has(id));
    if (newIds.length === 0) return;
    if (attempt + 1 < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
    }
  }
  throw new PackagedClientSmokeError("packaged_mcp_process_remained");
}

export async function terminateNewPackagedMcpProcesses(baseline, targets) {
  let current = await listPackagedMcpProcessIds(targets);
  const newIds = [...current.keys()].filter((id) => !baseline.has(id));
  const taskkillPath = join(
    targets.environment.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  for (const id of newIds) {
    current = await listPackagedMcpProcessIds(targets);
    if (!current.has(id) || baseline.has(id)) continue;
    const parentProcessId = current.get(id);
    if (!targets.clientProcessIds?.has(parentProcessId)) {
      throw new PackagedClientSmokeError("packaged_mcp_cleanup_unowned");
    }
    const result = await runBoundedCommand({
      commandPath: taskkillPath,
      args: ["/PID", String(id), "/T", "/F"],
      environment: targets.environment,
      timeoutMs: 10_000,
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
    });
    if (result.timedOut || result.outputLimitExceeded) {
      throw new PackagedClientSmokeError("packaged_mcp_cleanup_failed");
    }
    // A process may exit between the exact-target recheck and taskkill. The
    // final probe below is authoritative, so a nonzero race is tolerated.
  }
  try {
    await assertNoNewPackagedMcpProcess(baseline, targets, {
      attempts: 20,
      intervalMs: 100,
    });
  } catch {
    throw new PackagedClientSmokeError("packaged_mcp_cleanup_failed");
  }
}

async function resolveNpmCodexNativeExecutable(npmBinDirectory) {
  try {
    const packageRoot = await resolveSafeWindowsDirectory(join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      "codex",
    ));
    if (!packageRoot || !isStrictDescendant(npmBinDirectory, packageRoot)) {
      return undefined;
    }
    const rootManifest = await readBoundedJson(
      join(packageRoot, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
      "invalid_codex_package",
    );
    const version = rootManifest?.version;
    if (
      rootManifest?.name !== "@openai/codex" ||
      typeof version !== "string" ||
      !SEMVER_PATTERN.test(version) ||
      rootManifest?.bin?.codex !== "bin/codex.js" ||
      rootManifest?.optionalDependencies?.["@openai/codex-win32-x64"] !==
        `npm:@openai/codex@${version}-win32-x64`
    ) {
      return undefined;
    }

    const nativeRoot = await resolveSafeWindowsDirectory(join(
      packageRoot,
      "node_modules",
      "@openai",
      "codex-win32-x64",
    ));
    if (!nativeRoot || !isStrictDescendant(packageRoot, nativeRoot)) {
      return undefined;
    }
    const nativeManifest = await readBoundedJson(
      join(nativeRoot, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
      "invalid_codex_native_package",
    );
    if (
      nativeManifest?.name !== "@openai/codex" ||
      nativeManifest?.version !== `${version}-win32-x64` ||
      !stringArraysEqual(nativeManifest?.os, ["win32"]) ||
      !stringArraysEqual(nativeManifest?.cpu, ["x64"])
    ) {
      return undefined;
    }
    const nativeBinaryDirectory = await resolveSafeWindowsDirectory(join(
      nativeRoot,
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
    ));
    if (
      !nativeBinaryDirectory ||
      !isStrictDescendant(nativeRoot, nativeBinaryDirectory)
    ) {
      return undefined;
    }
    return resolveLocalRegularFileWithin(
      nativeBinaryDirectory,
      join(nativeBinaryDirectory, "codex.exe"),
    );
  } catch {
    return undefined;
  }
}

async function resolveNpmClaudeNativeExecutable(npmBinDirectory) {
  try {
    const packageRoot = await resolveSafeWindowsDirectory(join(
      npmBinDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
    ));
    if (!packageRoot || !isStrictDescendant(npmBinDirectory, packageRoot)) {
      return undefined;
    }
    const rootManifest = await readBoundedJson(
      join(packageRoot, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
      "invalid_claude_package",
    );
    const version = rootManifest?.version;
    if (
      rootManifest?.name !== "@anthropic-ai/claude-code" ||
      typeof version !== "string" ||
      !SEMVER_PATTERN.test(version) ||
      rootManifest?.bin?.claude !== "bin/claude.exe" ||
      rootManifest?.optionalDependencies?.["@anthropic-ai/claude-code-win32-x64"] !==
        version
    ) {
      return undefined;
    }

    const nativeRoot = await resolveSafeWindowsDirectory(join(
      packageRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code-win32-x64",
    ));
    if (!nativeRoot || !isStrictDescendant(packageRoot, nativeRoot)) {
      return undefined;
    }
    const nativeManifest = await readBoundedJson(
      join(nativeRoot, "package.json"),
      MAX_PACKAGE_JSON_BYTES,
      "invalid_claude_native_package",
    );
    if (
      nativeManifest?.name !== "@anthropic-ai/claude-code-win32-x64" ||
      nativeManifest?.version !== version ||
      !stringArraysEqual(nativeManifest?.os, ["win32"]) ||
      !stringArraysEqual(nativeManifest?.cpu, ["x64"]) ||
      !Array.isArray(nativeManifest?.files) ||
      !nativeManifest.files.includes("claude.exe")
    ) {
      return undefined;
    }

    const binaryDirectory = await resolveSafeWindowsDirectory(join(packageRoot, "bin"));
    const installedBinary = binaryDirectory && isStrictDescendant(packageRoot, binaryDirectory)
      ? await resolveLocalRegularFileWithin(
        binaryDirectory,
        join(binaryDirectory, "claude.exe"),
      )
      : undefined;
    const nativeBinary = await resolveLocalRegularFileWithin(
      nativeRoot,
      join(nativeRoot, "claude.exe"),
    );
    if (!installedBinary || !nativeBinary) return undefined;
    const [installedHash, nativeHash] = await Promise.all([
      sha256BoundedFile(installedBinary, MAX_PACKAGED_EXECUTABLE_BYTES),
      sha256BoundedFile(nativeBinary, MAX_PACKAGED_EXECUTABLE_BYTES),
    ]);
    return installedHash === nativeHash ? installedBinary : undefined;
  } catch {
    return undefined;
  }
}

async function verifySourceBoundRuntime({
  evidence,
  packagedDirectory,
  resourcesDirectory,
  executable,
  mcpEntry,
}) {
  const checksumEvidence = Array.isArray(evidence.evidence)
    ? evidence.evidence.find((item) =>
      isJsonObject(item) && item.role === "payload-sha256sums"
    )
    : undefined;
  if (
    !isJsonObject(checksumEvidence) ||
    checksumEvidence.relativePath !==
      `${basename(packagedDirectory)}/resources/compliance/SHA256SUMS` ||
    !Number.isSafeInteger(checksumEvidence.size) ||
    checksumEvidence.size < 1 ||
    checksumEvidence.size > MAX_PAYLOAD_CHECKSUM_BYTES ||
    typeof checksumEvidence.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(checksumEvidence.sha256)
  ) {
    throw new PackagedClientSmokeError("invalid_source_bound_checksums");
  }

  const complianceDirectory = await resolveSafeWindowsDirectory(
    join(resourcesDirectory, "compliance"),
  );
  const checksumPath = complianceDirectory && isStrictDescendant(
    resourcesDirectory,
    complianceDirectory,
  ) ? await resolveLocalRegularFileWithin(
    complianceDirectory,
    join(complianceDirectory, "SHA256SUMS"),
  ) : undefined;
  if (!checksumPath) {
    throw new PackagedClientSmokeError("invalid_source_bound_checksums");
  }
  const checksumMetadata = await lstat(checksumPath);
  if (checksumMetadata.size !== checksumEvidence.size) {
    throw new PackagedClientSmokeError("invalid_source_bound_checksums");
  }
  const checksumBytes = await readFile(checksumPath);
  if (
    checksumBytes.byteLength !== checksumEvidence.size ||
    createHash("sha256").update(checksumBytes).digest("hex") !==
      checksumEvidence.sha256
  ) {
    throw new PackagedClientSmokeError("invalid_source_bound_checksums");
  }
  let checksumText;
  try {
    checksumText = new TextDecoder("utf-8", { fatal: true }).decode(checksumBytes);
  } catch {
    throw new PackagedClientSmokeError("invalid_source_bound_checksums");
  }
  const checksums = parsePayloadChecksums(checksumText);
  const executableRelativePath = relative(packagedDirectory, executable)
    .split(sep)
    .join("/");
  const mcpRelativePath = relative(packagedDirectory, mcpEntry)
    .split(sep)
    .join("/");
  const expectedExecutableHash = checksums.get(executableRelativePath);
  const expectedMcpHash = checksums.get(mcpRelativePath);
  if (!expectedExecutableHash || !expectedMcpHash) {
    throw new PackagedClientSmokeError("source_bound_runtime_missing");
  }
  const [executableHash, mcpHash] = await Promise.all([
    sha256BoundedFile(executable, MAX_PACKAGED_EXECUTABLE_BYTES),
    sha256BoundedFile(mcpEntry, MAX_PACKAGED_MCP_BYTES),
  ]);
  if (executableHash !== expectedExecutableHash || mcpHash !== expectedMcpHash) {
    throw new PackagedClientSmokeError("source_bound_runtime_mismatch");
  }
}

function parsePayloadChecksums(text) {
  const checksums = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    const path = match?.[2];
    if (
      !match ||
      !path ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      checksums.has(path)
    ) {
      throw new PackagedClientSmokeError("invalid_source_bound_checksums");
    }
    checksums.set(path, match[1]);
  }
  return checksums;
}

async function sha256BoundedFile(path, maxBytes) {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > maxBytes
    ) {
      throw new Error("invalid file");
    }
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    throw new PackagedClientSmokeError("source_bound_runtime_unreadable");
  }
}

async function readBoundedJson(path, maxBytes, errorCode) {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > maxBytes
    ) {
      throw new Error("invalid file");
    }
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) throw new Error("oversized file");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    if (!isJsonObject(parsed)) throw new Error("invalid JSON root");
    return parsed;
  } catch (error) {
    if (error instanceof PackagedClientSmokeError) throw error;
    throw new PackagedClientSmokeError(errorCode);
  }
}

async function resolveSafeWindowsDirectory(candidate) {
  if (!isSafeWindowsDrivePath(candidate)) return undefined;
  try {
    const absolute = resolve(candidate);
    const root = parse(absolute).root;
    let current = root;
    for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
      current = join(current, segment);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    }
    const canonical = await realpath(absolute);
    return isSafeWindowsDrivePath(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function resolveLocalRegularFileWithin(canonicalDirectory, candidate) {
  try {
    const directMetadata = await lstat(candidate);
    if (!directMetadata.isFile() || directMetadata.isSymbolicLink()) return undefined;
    const canonical = await realpath(candidate);
    if (
      !isSafeWindowsDrivePath(canonical) ||
      !isStrictDescendant(canonicalDirectory, canonical)
    ) {
      return undefined;
    }
    const metadata = await lstat(canonical);
    return metadata.isFile() && !metadata.isSymbolicLink() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function validateCommandRequest(request) {
  if (
    !isSafeWindowsDrivePath(request.commandPath) ||
    !Array.isArray(request.args) ||
    request.args.length === 0 ||
    request.args.length > MAX_ARGUMENTS ||
    request.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.includes("\0") ||
        Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES,
    ) ||
    !isJsonObject(request.environment) ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 60_000 ||
    !Number.isInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    request.maxStdoutBytes > 1024 * 1024 ||
    !Number.isInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1 ||
    request.maxStderrBytes > 1024 * 1024
  ) {
    throw new PackagedClientSmokeError("invalid_client_command");
  }
}

function normalizeStringMap(value) {
  if (!isJsonObject(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries);
}

function stringArraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function stringMapsEqual(left, right) {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    stringArraysEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function stripAnsi(value) {
  return String(value).replace(/\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/gu, "");
}

export function parseWindowsCommandLine(commandLine) {
  if (
    typeof commandLine !== "string" ||
    commandLine.includes("\0") ||
    Buffer.byteLength(commandLine, "utf8") > 64 * 1024
  ) {
    return [];
  }
  const result = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /[\t ]/u.test(commandLine[index])) index += 1;
    if (index >= commandLine.length) break;

    let argument = "";
    let inQuotes = false;
    while (index < commandLine.length) {
      if (!inQuotes && /[\t ]/u.test(commandLine[index])) break;
      let backslashes = 0;
      while (commandLine[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        argument += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          argument += '"';
          index += 1;
        } else {
          index += 1;
          if (inQuotes && commandLine[index] === '"') {
            argument += '"';
            index += 1;
          } else {
            inQuotes = !inQuotes;
          }
        }
        continue;
      }
      argument += "\\".repeat(backslashes);
      if (index >= commandLine.length) break;
      if (!inQuotes && /[\t ]/u.test(commandLine[index])) break;
      argument += commandLine[index];
      index += 1;
    }
    if (
      inQuotes ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES ||
      result.length >= MAX_ARGUMENTS + 1
    ) {
      return [];
    }
    result.push(argument);
  }
  return result;
}

function isStrictDescendant(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function isSafeWindowsDrivePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

function isJsonObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
