import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const CLAUDE_CODE_SERVER_NAME = "owncontext";
export const CLAUDE_CODE_MANAGED_MARKER = "owncontext-desktop-v1";
export const MAX_CLAUDE_CODE_CONFIG_BYTES = 4 * 1024 * 1024;
export const CLAUDE_CODE_TIMEOUT_MS = 10_000;
export const MAX_CLAUDE_CODE_STDOUT_BYTES = 64 * 1024;
export const MAX_CLAUDE_CODE_STDERR_BYTES = 64 * 1024;

const MAX_PATH_BYTES = 4096;
const MAX_COMMAND_ARGUMENT_BYTES = 32 * 1024;
const MAX_COMMAND_ARGUMENTS = 32;
const MAX_CLAUDE_NPM_PACKAGE_JSON_BYTES = 64 * 1024;
const CLAUDE_COMMAND_ENVIRONMENT_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "USERPROFILE",
  "WINDIR",
] as const;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export interface ClaudeCodeMcpLaunch {
  /** Absolute Node.js or Electron executable path. */
  commandPath: string;
  /** Absolute paths only, normally the bundled MCP entry point. */
  args: readonly string[];
  /** Absolute path to the private OwnContext SQLite vault. */
  vaultPath: string;
  /** Single collection this Claude Code connection may search. */
  allowedCollection: string;
  runtime: "node" | "electron";
}

export interface ClaudeCodeMcpConfig extends JsonObject {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeCodeCommand {
  /** Absolute executable path. Scripts use an explicit trusted interpreter here. */
  commandPath: string;
  /** Fixed interpreter arguments, such as PowerShell's `-File` and a script path. */
  prefixArgs: readonly string[];
}

export interface ClaudeCodeCommandRequest {
  commandPath: string;
  args: readonly string[];
  environment: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface ClaudeCodeCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export type ClaudeCodeCommandDiscovery = () =>
  | ClaudeCodeCommand
  | undefined
  | Promise<ClaudeCodeCommand | undefined>;

export type ClaudeCodeCommandRunner = (
  request: ClaudeCodeCommandRequest,
) => Promise<ClaudeCodeCommandResult>;

export type ClaudeCodeConfigStatus =
  | "absent"
  | "managed"
  | "managed_stale"
  | "unmanaged_conflict"
  | "config_too_large"
  | "invalid_encoding"
  | "invalid_json"
  | "invalid_structure"
  | "read_failed"
  | "invalid_config_target"
  | "invalid_launch";

export type ClaudeCodeMutationCode =
  | "applied"
  | "removed"
  | "unchanged"
  | "invalid_launch"
  | "cli_unavailable"
  | "unmanaged_conflict"
  | "config_too_large"
  | "invalid_encoding"
  | "invalid_json"
  | "invalid_structure"
  | "read_failed"
  | "invalid_config_target"
  | "backup_failed"
  | "busy"
  | "concurrent_change"
  | "cli_failed"
  | "cli_timeout"
  | "cli_output_limit"
  | "update_removed_retry_required"
  | "recovery_required"
  | "write_failed"
  | "verification_failed";

export interface ClaudeCodeConfigPreview {
  status: ClaudeCodeConfigStatus;
  canApply: boolean;
  canRemove: boolean;
  cliAvailable: boolean;
  configExists: boolean;
  /** Generated OwnContext JSON only. No existing Claude configuration is returned. */
  snippet: string;
}

export interface ClaudeCodeMutationResult {
  ok: boolean;
  code: ClaudeCodeMutationCode;
  changed: boolean;
  backupCreated: boolean;
  /** A basename only; the user's home/config path is not returned. */
  backupFileName?: string | undefined;
  /** True when a failed CLI mutation was safely returned to its prior bytes. */
  restored?: boolean | undefined;
  /** Generated OwnContext JSON only. */
  snippet?: string | undefined;
}

export interface ClaudeCodeConfigService {
  preview(launch: ClaudeCodeMcpLaunch): Promise<ClaudeCodeConfigPreview>;
  apply(launch: ClaudeCodeMcpLaunch): Promise<ClaudeCodeMutationResult>;
  /** Refreshes an existing recognizable entry but never creates a grant. */
  refreshManaged(launch: ClaudeCodeMcpLaunch): Promise<ClaudeCodeMutationResult>;
  remove(): Promise<ClaudeCodeMutationResult>;
}

export interface ClaudeCodeConfigServiceOptions {
  /** Trusted main-process path; never populate this from renderer input. */
  configPath?: string;
  /** Captured once so CLI target selection cannot drift between backup and mutation. */
  environment?: Readonly<NodeJS.ProcessEnv>;
  homeDirectory?: string;
  discoverCommand?: ClaudeCodeCommandDiscovery;
  runCommand?: ClaudeCodeCommandRunner;
  now?: () => Date;
}

export interface ClaudeCodeDiscoveryOptions {
  environment?: Readonly<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
}

interface LoadedConfig {
  exists: boolean;
  bytes: Buffer<ArrayBufferLike>;
  mode: number;
  root: JsonObject;
  /** True only when the managed entry already equals this launch exactly. */
  exactManaged: boolean;
  status: Exclude<
    ClaudeCodeConfigStatus,
    "invalid_launch" | "invalid_config_target" | "managed_stale"
  >;
}

class InternalClaudeCodePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalClaudeCodePathError";
  }
}

export function defaultClaudeCodeConfigPath(
  homeDirectory = homedir(),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  if (!isSafeLocalClaudePath(homeDirectory)) {
    throw new InternalClaudeCodePathError("Invalid Claude Code home directory.");
  }
  const override = resolveClaudeConfigDirectory(environment);
  return override === undefined
    ? join(homeDirectory, ".claude.json")
    : join(override, ".claude.json");
}

function resolveClaudeConfigDirectory(
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  const raw = environment.CLAUDE_CONFIG_DIR?.trim();
  if (!raw) return undefined;
  if (!isSafeLocalClaudePath(raw)) {
    throw new InternalClaudeCodePathError("CLAUDE_CONFIG_DIR must be absolute.");
  }
  return join(raw, ".");
}

function createClaudeCodeCommandEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  homeDirectory: string,
  configDirectory: string | undefined,
): Readonly<NodeJS.ProcessEnv> {
  if (!isSafeLocalClaudePath(homeDirectory)) {
    throw new InternalClaudeCodePathError("Invalid Claude Code home directory.");
  }
  const result: NodeJS.ProcessEnv = {};
  for (const key of CLAUDE_COMMAND_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (
      value !== undefined &&
      !value.includes("\0") &&
      Buffer.byteLength(value, "utf8") <= MAX_COMMAND_ARGUMENT_BYTES
    ) {
      result[key] = value;
    }
  }
  result.HOME = homeDirectory;
  if (process.platform === "win32") result.USERPROFILE = homeDirectory;
  if (configDirectory !== undefined) {
    if (!isSafeLocalClaudePath(configDirectory)) {
      throw new InternalClaudeCodePathError("Invalid Claude Code config directory.");
    }
    result.CLAUDE_CONFIG_DIR = configDirectory;
  }
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  result.DISABLE_AUTOUPDATER = "1";
  result.DISABLE_ERROR_REPORTING = "1";
  result.DISABLE_TELEMETRY = "1";
  return Object.freeze(result);
}

/**
 * Finds a directly executable Claude Code command without constructing a shell
 * command. Windows accepts a native `claude.exe` on PATH or the native binary
 * installed beneath the official npm shim directory. Script shims are not run:
 * killing their parent on timeout would not reliably stop the child process.
 */
export async function discoverClaudeCodeCommand(
  options: ClaudeCodeDiscoveryOptions = {},
): Promise<ClaudeCodeCommand | undefined> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (!pathValue) return undefined;

  const pathDelimiter = platform === "win32" ? ";" : ":";
  const configuredDirectories = [
    ...new Set(
      pathValue
        .split(pathDelimiter)
        .filter(
          (directory) =>
            isSafeAbsolutePath(directory) &&
            (platform !== "win32" || /^[A-Za-z]:[\\/]/u.test(directory)),
        ),
    ),
  ];
  if (platform === "win32") {
    const directories: string[] = [];
    const seen = new Set<string>();
    for (const configuredDirectory of configuredDirectories) {
      const directory = await resolveSafeWindowsDirectory(configuredDirectory);
      const key = directory?.toLocaleLowerCase("en-US");
      if (directory && key && !seen.has(key)) {
        directories.push(directory);
        seen.add(key);
      }
    }

    for (const directory of directories) {
      const executable = await resolveLocalRegularFileWithin(
        directory,
        join(directory, "claude.exe"),
      );
      if (executable) return { commandPath: executable, prefixArgs: [] };
    }

    for (const directory of directories) {
      const npmNativeExecutable = await resolveNpmClaudeNativeExecutable(directory);
      if (npmNativeExecutable) {
        return { commandPath: npmNativeExecutable, prefixArgs: [] };
      }
    }
    return undefined;
  }

  for (const directory of configuredDirectories) {
    const candidate = join(directory, "claude");
    try {
      await access(candidate, fsConstants.X_OK);
      const executable = await resolveRegularFile(candidate);
      if (executable) return { commandPath: executable, prefixArgs: [] };
    } catch {
      // Continue searching PATH without revealing individual filesystem errors.
    }
  }
  return undefined;
}

async function resolveNpmClaudeNativeExecutable(
  npmBinDirectory: string,
): Promise<string | undefined> {
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
    const packageJsonPath = join(packageRoot, "package.json");
    const packageMetadata = await lstat(packageJsonPath);
    if (
      !packageMetadata.isFile() ||
      packageMetadata.isSymbolicLink() ||
      packageMetadata.size > MAX_CLAUDE_NPM_PACKAGE_JSON_BYTES
    ) {
      return undefined;
    }
    const packageText = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(packageJsonPath),
    );
    const manifest = JSON.parse(packageText) as unknown;
    if (
      !isJsonObject(manifest) ||
      manifest.name !== "@anthropic-ai/claude-code" ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
      !isJsonObject(manifest.bin) ||
      manifest.bin.claude !== "bin/claude.exe"
    ) {
      return undefined;
    }

    const binaryDirectory = await resolveSafeWindowsDirectory(join(packageRoot, "bin"));
    if (!binaryDirectory || !isStrictDescendant(packageRoot, binaryDirectory)) {
      return undefined;
    }
    const executable = await resolveLocalRegularFileWithin(
      binaryDirectory,
      join(binaryDirectory, "claude.exe"),
    );
    if (!executable) return undefined;
    return executable;
  } catch {
    return undefined;
  }
}

/** Runs an already separated executable/argv tuple with no shell. */
export function runClaudeCodeCommand(
  request: ClaudeCodeCommandRequest,
): Promise<ClaudeCodeCommandResult> {
  validateCommandRequest(request);

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child = spawn(request.commandPath, [...request.args], {
      env: { ...request.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (
      result?: ClaudeCodeCommandResult,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else if (result) resolvePromise(result);
      else rejectPromise(new Error("Claude Code command ended without a result."));
    };

    const stopForOutputLimit = (): void => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      child.kill();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > request.maxStdoutBytes) stopForOutputLimit();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > request.maxStderrBytes) stopForOutputLimit();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);

    child.once("error", (error) => finish(undefined, error));
    child.once("close", (exitCode) => {
      finish({ exitCode, timedOut, outputLimitExceeded });
    });
  });
}

export function renderClaudeCodeMcpConfig(
  launch: ClaudeCodeMcpLaunch,
): ClaudeCodeMcpConfig {
  validateLaunch(launch);

  const env: Record<string, string> = {
    OWNCONTEXT_ALLOWED_COLLECTION: launch.allowedCollection,
    OWNCONTEXT_CLIENT_KIND: "claude-code",
    OWNCONTEXT_MANAGED_BY: CLAUDE_CODE_MANAGED_MARKER,
    OWNCONTEXT_VAULT_PATH: launch.vaultPath,
  };
  if (launch.runtime === "electron") {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  return {
    type: "stdio",
    command: launch.commandPath,
    args: [...launch.args],
    env,
  };
}

export function createClaudeCodeConfigService(
  options: ClaudeCodeConfigServiceOptions = {},
): ClaudeCodeConfigService {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  let configPath: string;
  let commandEnvironment: Readonly<NodeJS.ProcessEnv>;
  try {
    configPath = options.configPath ?? defaultClaudeCodeConfigPath(
      homeDirectory,
      environment,
    );
    if (
      !isSafeLocalClaudePath(configPath) ||
      basename(configPath).toLocaleLowerCase("en-US") !== ".claude.json"
    ) {
      throw new InternalClaudeCodePathError(
        "Invalid internal Claude Code configuration path.",
      );
    }
    commandEnvironment = createClaudeCodeCommandEnvironment(
      environment,
      homeDirectory,
      options.configPath === undefined
        ? resolveClaudeConfigDirectory(environment)
        : dirname(configPath),
    );
  } catch {
    return invalidConfigTargetService();
  }

  const discoverCommand = options.discoverCommand ?? (() =>
    discoverClaudeCodeCommand({ environment }));
  const runCommand = options.runCommand ?? runClaudeCodeCommand;
  const now = options.now ?? (() => new Date());
  let mutationActive = false;

  const commandRequest = (
    command: ClaudeCodeCommand,
    args: readonly string[],
  ): ClaudeCodeCommandRequest => ({
    commandPath: command.commandPath,
    args: [...command.prefixArgs, ...args],
    environment: commandEnvironment,
    timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
    maxStdoutBytes: MAX_CLAUDE_CODE_STDOUT_BYTES,
    maxStderrBytes: MAX_CLAUDE_CODE_STDERR_BYTES,
  });

  type InvocationOutcome =
    | "ok"
    | "nonzero"
    | "cli_failed"
    | "cli_timeout"
    | "cli_output_limit";

  const runInvocation = async (
    command: ClaudeCodeCommand,
    args: readonly string[],
  ): Promise<InvocationOutcome> => {
    try {
      const result = await runCommand(commandRequest(command, args));
      if (result.timedOut) return "cli_timeout";
      if (result.outputLimitExceeded) return "cli_output_limit";
      return result.exitCode === 0 ? "ok" : "nonzero";
    } catch {
      return "cli_failed";
    }
  };

  const invokeMutation = async (
    command: ClaudeCodeCommand,
    args: readonly string[],
  ): Promise<ClaudeCodeMutationCode | "ok"> => {
    const outcome = await runInvocation(command, args);
    return outcome === "nonzero" ? "cli_failed" : outcome;
  };

  const replaceManagedEntry = async (
    loaded: LoadedConfig,
    generated: { config: ClaudeCodeMcpConfig; snippet: string },
  ): Promise<ClaudeCodeMutationResult> => {
    const backup = await prepareBackup(configPath, loaded, now);
    if (backup.status === "failed") {
      return mutationFailure("backup_failed", generated.snippet);
    }
    if (!(await snapshotStillMatches(configPath, loaded))) {
      return mutationFailure(
        "concurrent_change",
        generated.snippet,
        backup.fileName,
      );
    }

    const writeCode = await writeConfigRoot(
      configPath,
      loaded,
      withManagedEntry(loaded.root, generated.config),
    );
    if (writeCode !== "ok") {
      return mutationFailure(
        writeCode,
        generated.snippet,
        backup.fileName,
        await snapshotChanged(configPath, loaded),
      );
    }
    const after = await loadConfig(configPath, generated.config);
    if (
      after.status === "managed" &&
      after.exactManaged &&
      unrelatedConfigMatches(loaded.root, after.root)
    ) {
      return mutationSuccess(
        "applied",
        true,
        generated.snippet,
        backup.fileName,
      );
    }
    return mutationFailure(
      "recovery_required",
      generated.snippet,
      backup.fileName,
      await snapshotChanged(configPath, loaded),
    );
  };

  return {
    async preview(launch) {
      const generated = safeGeneratedConfig(launch);
      if (!generated) {
        return {
          status: "invalid_launch",
          canApply: false,
          canRemove: false,
          cliAvailable: false,
          configExists: false,
          snippet: "",
        };
      }

      const [loaded, command] = await Promise.all([
        loadConfig(configPath, generated.config),
        safeDiscoverCommand(discoverCommand),
      ]);
      return {
        status:
          loaded.status === "managed" && !loaded.exactManaged
            ? "managed_stale"
            : loaded.status,
        canApply:
          loaded.status === "managed" ||
          (loaded.status === "absent" && command !== undefined),
        canRemove: loaded.status === "managed",
        cliAvailable: command !== undefined,
        configExists: loaded.exists,
        snippet: generated.snippet,
      };
    },

    async apply(launch) {
      const generated = safeGeneratedConfig(launch);
      if (!generated) return mutationFailure("invalid_launch");
      if (mutationActive) return mutationFailure("busy", generated.snippet);
      mutationActive = true;

      try {
        const loaded = await loadConfig(configPath, generated.config);
        if (loaded.status === "managed" && loaded.exactManaged) {
          return mutationSuccess("unchanged", false, generated.snippet);
        }
        const blocked = statusToMutationCode(loaded.status);
        if (blocked) return mutationFailure(blocked, generated.snippet);
        if (loaded.status === "managed") {
          return replaceManagedEntry(loaded, generated);
        }

        const command = await safeDiscoverCommand(discoverCommand);
        if (!command) return mutationFailure("cli_unavailable", generated.snippet);

        const backup = await prepareBackup(configPath, loaded, now);
        if (backup.status === "failed") {
          return mutationFailure("backup_failed", generated.snippet);
        }
        if (!(await snapshotStillMatches(configPath, loaded))) {
          return mutationFailure(
            "concurrent_change",
            generated.snippet,
            backup.fileName,
          );
        }

        const addCode = await invokeMutation(command, [
          "mcp",
          "add-json",
          "--scope",
          "user",
          CLAUDE_CODE_SERVER_NAME,
          generated.snippet,
        ]);
        if (addCode !== "ok") {
          const afterFailure = await loadConfig(configPath, generated.config);
          if (
            afterFailure.status === "managed" &&
            afterFailure.exactManaged &&
            unrelatedConfigPreservesBaseline(loaded.root, afterFailure.root)
          ) {
            return mutationSuccess(
              "applied",
              true,
              generated.snippet,
              backup.fileName,
            );
          }
          if (await snapshotStillMatches(configPath, loaded)) {
            return mutationFailure(
              addCode,
              generated.snippet,
              backup.fileName,
            );
          }
          const restored = await restoreSnapshotIfOwnedProjectionOnly(
            configPath,
            loaded,
            afterFailure,
          );
          if (restored) {
            return mutationFailure(
              addCode,
              generated.snippet,
              backup.fileName,
              false,
              true,
            );
          }
          return mutationFailure(
            "recovery_required",
            generated.snippet,
            backup.fileName,
            await snapshotChanged(configPath, loaded),
          );
        }

        const after = await loadConfig(configPath, generated.config);
        if (
          after.status !== "managed" ||
          !after.exactManaged ||
          !unrelatedConfigPreservesBaseline(loaded.root, after.root)
        ) {
          if (await snapshotStillMatches(configPath, loaded)) {
            return mutationFailure(
              "verification_failed",
              generated.snippet,
              backup.fileName,
            );
          }
          const restored = await restoreSnapshotIfOwnedProjectionOnly(
            configPath,
            loaded,
            after,
          );
          if (restored) {
            return mutationFailure(
              "verification_failed",
              generated.snippet,
              backup.fileName,
              false,
              true,
            );
          }
          return mutationFailure(
            "recovery_required",
            generated.snippet,
            backup.fileName,
            await snapshotChanged(configPath, loaded),
          );
        }

        return mutationSuccess("applied", true, generated.snippet, backup.fileName);
      } finally {
        mutationActive = false;
      }
    },

    async refreshManaged(launch) {
      const generated = safeGeneratedConfig(launch);
      if (!generated) return mutationFailure("invalid_launch");
      if (mutationActive) return mutationFailure("busy", generated.snippet);
      mutationActive = true;

      try {
        const loaded = await loadConfig(configPath, generated.config);
        if (loaded.status === "absent") {
          return mutationSuccess("unchanged", false, generated.snippet);
        }
        if (loaded.status === "managed" && loaded.exactManaged) {
          return mutationSuccess("unchanged", false, generated.snippet);
        }
        const blocked = statusToMutationCode(loaded.status);
        if (blocked || loaded.status !== "managed") {
          return mutationFailure(
            blocked ?? "unmanaged_conflict",
            generated.snippet,
          );
        }
        return replaceManagedEntry(loaded, generated);
      } finally {
        mutationActive = false;
      }
    },

    async remove() {
      if (mutationActive) return mutationFailure("busy");
      mutationActive = true;

      try {
        const loaded = await loadConfig(configPath);
        if (loaded.status === "absent") {
          return mutationSuccess("unchanged", false);
        }
        if (loaded.status !== "managed") {
          const blocked = statusToMutationCode(loaded.status) ?? "unmanaged_conflict";
          return mutationFailure(blocked);
        }

        const backup = await prepareBackup(configPath, loaded, now);
        if (backup.status === "failed") {
          return mutationFailure("backup_failed");
        }
        if (!(await snapshotStillMatches(configPath, loaded))) {
          return mutationFailure(
            "concurrent_change",
            undefined,
            backup.fileName,
          );
        }

        const removeCode = await writeConfigRoot(
          configPath,
          loaded,
          withoutManagedEntry(loaded.root),
        );
        if (removeCode !== "ok") {
          return mutationFailure(
            removeCode,
            undefined,
            backup.fileName,
            await snapshotChanged(configPath, loaded),
          );
        }

        const after = await loadConfig(configPath);
        if (
          after.status !== "absent" ||
          !unrelatedConfigMatches(loaded.root, after.root)
        ) {
          return mutationFailure(
            "verification_failed",
            undefined,
            backup.fileName,
            await snapshotChanged(configPath, loaded),
          );
        }

        return mutationSuccess("removed", true, undefined, backup.fileName);
      } finally {
        mutationActive = false;
      }
    },
  };
}

function invalidConfigTargetService(): ClaudeCodeConfigService {
  return {
    async preview(launch) {
      const generated = safeGeneratedConfig(launch);
      if (!generated) {
        return {
          status: "invalid_launch",
          canApply: false,
          canRemove: false,
          cliAvailable: false,
          configExists: false,
          snippet: "",
        };
      }
      return {
        status: "invalid_config_target",
        canApply: false,
        canRemove: false,
        cliAvailable: false,
        configExists: false,
        snippet: generated.snippet,
      };
    },
    async apply(launch) {
      const generated = safeGeneratedConfig(launch);
      return mutationFailure(
        generated ? "invalid_config_target" : "invalid_launch",
        generated?.snippet,
      );
    },
    async refreshManaged(launch) {
      const generated = safeGeneratedConfig(launch);
      return mutationFailure(
        generated ? "invalid_config_target" : "invalid_launch",
        generated?.snippet,
      );
    },
    async remove() {
      return mutationFailure("invalid_config_target");
    },
  };
}

async function resolveRegularFile(candidate: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidate);
    const metadata = await lstat(resolved);
    return metadata.isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rejects Windows directory junctions before walking through them. This keeps a
 * local-looking PATH entry from resolving to, probing, or executing an SMB path.
 */
async function resolveSafeWindowsDirectory(
  candidate: string,
): Promise<string | undefined> {
  if (!isSafeWindowsDrivePath(candidate)) return undefined;
  try {
    const absolute = resolve(candidate);
    const root = parse(absolute).root;
    let current = root;
    const segments = relative(root, absolute).split(sep).filter(Boolean);
    for (const segment of segments) {
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

async function resolveLocalRegularFileWithin(
  canonicalDirectory: string,
  candidate: string,
): Promise<string | undefined> {
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
    return metadata.isFile() && !metadata.isSymbolicLink()
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function isSafeWindowsDrivePath(value: unknown): value is string {
  return isSafeAbsolutePath(value) && /^[A-Za-z]:[\\/]/u.test(value);
}

function validateLaunch(launch: ClaudeCodeMcpLaunch): void {
  if (
    !launch ||
    (launch.runtime !== "node" && launch.runtime !== "electron") ||
    !isSafeAbsolutePath(launch.commandPath) ||
    !isSafeAbsolutePath(launch.vaultPath) ||
    !isSafeCollection(launch.allowedCollection) ||
    !Array.isArray(launch.args) ||
    launch.args.length === 0 ||
    launch.args.length > 8 ||
    launch.args.some((argument) => !isSafeAbsolutePath(argument))
  ) {
    throw new InternalClaudeCodePathError("Invalid OwnContext MCP launch.");
  }
}

function isSafeCollection(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim().normalize("NFC") === value &&
    !/\p{Cc}/u.test(value)
  );
}

function validateCommandRequest(request: ClaudeCodeCommandRequest): void {
  if (
    !isSafeAbsolutePath(request.commandPath) ||
    !Array.isArray(request.args) ||
    request.args.length === 0 ||
    request.args.length > MAX_COMMAND_ARGUMENTS ||
    request.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.includes("\0") ||
        Buffer.byteLength(argument, "utf8") > MAX_COMMAND_ARGUMENT_BYTES,
    ) ||
    !request.environment ||
    typeof request.environment !== "object" ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 60_000 ||
    !Number.isInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 0 ||
    request.maxStdoutBytes > 1024 * 1024 ||
    !Number.isInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 0 ||
    request.maxStderrBytes > 1024 * 1024
  ) {
    throw new InternalClaudeCodePathError("Invalid Claude Code command request.");
  }
}

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

function isSafeLocalClaudePath(value: unknown): value is string {
  return (
    isSafeAbsolutePath(value) &&
    (process.platform !== "win32" || /^[A-Za-z]:[\\/]/u.test(value))
  );
}

function safeGeneratedConfig(
  launch: ClaudeCodeMcpLaunch,
): { config: ClaudeCodeMcpConfig; snippet: string } | undefined {
  try {
    const config = renderClaudeCodeMcpConfig(launch);
    return { config, snippet: JSON.stringify(config) };
  } catch {
    return undefined;
  }
}

async function safeDiscoverCommand(
  discover: ClaudeCodeCommandDiscovery,
): Promise<ClaudeCodeCommand | undefined> {
  try {
    const command = await discover();
    if (
      !command ||
      !isSafeAbsolutePath(command.commandPath) ||
      !Array.isArray(command.prefixArgs) ||
      command.prefixArgs.length > 16 ||
      command.prefixArgs.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.includes("\0") ||
          Buffer.byteLength(argument, "utf8") > MAX_COMMAND_ARGUMENT_BYTES,
      )
    ) {
      return undefined;
    }
    return {
      commandPath: command.commandPath,
      prefixArgs: [...command.prefixArgs],
    };
  } catch {
    return undefined;
  }
}

async function loadConfig(
  configPath: string,
  expected?: ClaudeCodeMcpConfig,
): Promise<LoadedConfig> {
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyConfig();
    }
    return failedConfig("read_failed");
  }

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return failedConfig("read_failed", true, metadata.mode);
  }
  if (metadata.size > MAX_CLAUDE_CODE_CONFIG_BYTES) {
    return failedConfig("config_too_large", true, metadata.mode);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(configPath);
  } catch {
    return failedConfig("read_failed", true, metadata.mode);
  }
  if (bytes.byteLength > MAX_CLAUDE_CODE_CONFIG_BYTES) {
    return failedConfig("config_too_large", true, metadata.mode);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failedConfig("invalid_encoding", true, metadata.mode, bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failedConfig("invalid_json", true, metadata.mode, bytes);
  }
  if (!hasSafeJsonRewriteSemantics(text)) {
    return failedConfig("invalid_structure", true, metadata.mode, bytes);
  }
  if (!isJsonObject(parsed)) {
    return failedConfig("invalid_structure", true, metadata.mode, bytes);
  }

  const servers = parsed.mcpServers;
  if (servers !== undefined && !isJsonObject(servers)) {
    return {
      exists: true,
      bytes,
      mode: metadata.mode,
      root: parsed,
      exactManaged: false,
      status: "invalid_structure",
    };
  }

  if (!servers || !Object.hasOwn(servers, CLAUDE_CODE_SERVER_NAME)) {
    return {
      exists: true,
      bytes,
      mode: metadata.mode,
      root: parsed,
      exactManaged: false,
      status: "absent",
    };
  }

  const entry = servers[CLAUDE_CODE_SERVER_NAME];
  const exactManaged = expected !== undefined && jsonEqual(entry, expected);
  return {
    exists: true,
    bytes,
    mode: metadata.mode,
    root: parsed,
    exactManaged,
    status:
      exactManaged || isRecognizableManagedConfig(entry)
        ? "managed"
        : "unmanaged_conflict",
  };
}

/**
 * Direct revoke/refresh rewrites JSON. Refuse documents whose values would be
 * changed by JavaScript number coercion or whose duplicate keys would be lost.
 * Whitespace and escape spelling may change, but represented values do not.
 */
function hasSafeJsonRewriteSemantics(text: string): boolean {
  let cursor = 0;
  let safe = true;

  const whitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const stringValue = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
      } else if (text[cursor] === '"') {
        cursor += 1;
        return JSON.parse(text.slice(start, cursor)) as string;
      } else {
        cursor += 1;
      }
    }
    throw new SyntaxError("Unterminated JSON string.");
  };
  const value = (): void => {
    whitespace();
    const character = text[cursor];
    if (character === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        whitespace();
        const key = stringValue();
        if (keys.has(key)) safe = false;
        keys.add(key);
        whitespace();
        cursor += 1; // JSON.parse already proved this is a colon.
        value();
        whitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        cursor += 1; // comma
      }
      return;
    }
    if (character === "[") {
      cursor += 1;
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < text.length) {
        value();
        whitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        cursor += 1; // comma
      }
      return;
    }
    if (character === '"') {
      stringValue();
      return;
    }
    if (character === "t") {
      cursor += 4;
      return;
    }
    if (character === "f") {
      cursor += 5;
      return;
    }
    if (character === "n") {
      cursor += 4;
      return;
    }

    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
    numberPattern.lastIndex = cursor;
    const match = numberPattern.exec(text);
    if (!match) throw new SyntaxError("Invalid JSON number.");
    const token = match[0];
    cursor = numberPattern.lastIndex;
    const numeric = Number(token);
    if (
      !/^-?\d+$/u.test(token) ||
      !Number.isFinite(numeric) ||
      Object.is(numeric, -0) ||
      !Number.isSafeInteger(numeric)
    ) {
      safe = false;
    }
  };

  try {
    value();
    whitespace();
    return safe && cursor === text.length;
  } catch {
    return false;
  }
}

function emptyConfig(): LoadedConfig {
  return {
    exists: false,
    bytes: Buffer.alloc(0),
    mode: 0o600,
    root: {},
    exactManaged: false,
    status: "absent",
  };
}

function failedConfig(
  status: Extract<
    LoadedConfig["status"],
    | "config_too_large"
    | "invalid_encoding"
    | "invalid_json"
    | "invalid_structure"
    | "read_failed"
  >,
  exists = false,
  mode = 0o600,
  bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): LoadedConfig {
  return { exists, bytes, mode, root: {}, exactManaged: false, status };
}

/**
 * Recognizes only the exact shape emitted by an earlier OwnContext release.
 * Paths and collection values may be stale after an application update, but
 * extra fields or a copied marker in an arbitrary entry remain a conflict.
 */
function isRecognizableManagedConfig(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  if (!hasExactKeys(value, ["args", "command", "env", "type"])) return false;
  if (
    value.type !== "stdio" ||
    !isSafeAbsolutePath(value.command) ||
    !Array.isArray(value.args) ||
    value.args.length === 0 ||
    value.args.length > 8 ||
    value.args.some((argument) => !isSafeAbsolutePath(argument)) ||
    !isJsonObject(value.env)
  ) {
    return false;
  }

  const env = value.env;
  const envKeys = Object.keys(env).sort();
  const nodeKeys = [
    "OWNCONTEXT_ALLOWED_COLLECTION",
    "OWNCONTEXT_MANAGED_BY",
    "OWNCONTEXT_VAULT_PATH",
  ];
  const currentNodeKeys = [...nodeKeys, "OWNCONTEXT_CLIENT_KIND"].sort();
  const electronKeys = [...nodeKeys, "ELECTRON_RUN_AS_NODE"].sort();
  const currentElectronKeys = [...currentNodeKeys, "ELECTRON_RUN_AS_NODE"].sort();
  const hasKnownEnvironmentShape =
    jsonEqual(envKeys, nodeKeys) ||
    jsonEqual(envKeys, electronKeys) ||
    jsonEqual(envKeys, currentNodeKeys) ||
    jsonEqual(envKeys, currentElectronKeys);

  return (
    hasKnownEnvironmentShape &&
    env.OWNCONTEXT_MANAGED_BY === CLAUDE_CODE_MANAGED_MARKER &&
    (env.OWNCONTEXT_CLIENT_KIND === undefined ||
      env.OWNCONTEXT_CLIENT_KIND === "claude-code") &&
    isSafeAbsolutePath(env.OWNCONTEXT_VAULT_PATH) &&
    isSafeCollection(env.OWNCONTEXT_ALLOWED_COLLECTION) &&
    (env.ELECTRON_RUN_AS_NODE === undefined || env.ELECTRON_RUN_AS_NODE === "1")
  );
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  return jsonEqual(Object.keys(value).sort(), [...expected].sort());
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

function unrelatedConfigMatches(before: JsonObject, after: JsonObject): boolean {
  return jsonEqual(withoutManagedEntry(before), withoutManagedEntry(after));
}

function unrelatedConfigPreservesBaseline(
  before: JsonObject,
  after: JsonObject,
): boolean {
  const baseline = withoutManagedEntry(before);
  const current = withoutManagedEntry(after);

  for (const [key, value] of Object.entries(baseline)) {
    if (
      !Object.prototype.hasOwnProperty.call(current, key) ||
      !jsonEqual(value, current[key])
    ) {
      return false;
    }
  }

  return Object.entries(current).every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(baseline, key) ||
      isKnownClaudeBootstrapMetadata(key, value),
  );
}

function isKnownClaudeBootstrapMetadata(key: string, value: unknown): boolean {
  switch (key) {
    case "firstStartTime":
      return (
        typeof value === "string" &&
        value.length <= 64 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      );
    case "machineID":
      return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
    case "migrationVersion":
      return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
    case "opusProMigrationComplete":
    case "sonnet1m45MigrationComplete":
      return value === true;
    case "seenNotifications":
      return isJsonObject(value) && Object.keys(value).length === 0;
    default:
      return false;
  }
}

function withManagedEntry(
  root: JsonObject,
  config: ClaudeCodeMcpConfig,
): JsonObject {
  const copy = cloneJsonObject(root);
  const existingServers = copy.mcpServers;
  const servers = isJsonObject(existingServers)
    ? existingServers
    : (Object.create(null) as JsonObject);
  servers[CLAUDE_CODE_SERVER_NAME] = cloneJsonObject(config);
  copy.mcpServers = servers;
  return copy;
}

function withoutManagedEntry(root: JsonObject): JsonObject {
  const copy = cloneJsonObject(root);
  const servers = copy.mcpServers;
  if (isJsonObject(servers)) {
    delete servers[CLAUDE_CODE_SERVER_NAME];
    if (Object.keys(servers).length === 0) delete copy.mcpServers;
  }
  return copy;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const result: JsonObject = Object.create(null) as JsonObject;
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneJsonValue(item);
  }
  return result;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isJsonObject(value)) return cloneJsonObject(value);
  return value;
}

async function prepareBackup(
  configPath: string,
  loaded: LoadedConfig,
  now: () => Date,
): Promise<
  | { status: "ready"; fileName?: string | undefined }
  | { status: "failed" }
> {
  if (!loaded.exists) return { status: "ready" };
  try {
    return {
      status: "ready",
      fileName: await createExclusiveBackup(configPath, loaded.bytes, loaded.mode, now),
    };
  } catch {
    return { status: "failed" };
  }
}

async function createExclusiveBackup(
  configPath: string,
  bytes: Buffer<ArrayBufferLike>,
  mode: number,
  now: () => Date,
): Promise<string> {
  const timestamp = now().toISOString().replaceAll(":", "-");
  const parent = dirname(configPath);
  const fileName = `${basename(configPath)}.owncontext-backup-${timestamp}-${randomUUID()}`;
  const backupPath = join(parent, fileName);
  const handle = await open(backupPath, "wx", mode);
  let completed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    completed = true;
  } finally {
    if (!completed) {
      await handle.close().catch(() => undefined);
      await unlink(backupPath).catch(() => undefined);
    }
  }
  return fileName;
}

async function snapshotStillMatches(
  configPath: string,
  loaded: LoadedConfig,
): Promise<boolean> {
  try {
    const metadata = await lstat(configPath);
    if (!loaded.exists || !metadata.isFile() || metadata.isSymbolicLink()) return false;
    if (metadata.size !== loaded.bytes.byteLength) return false;

    const handle = await open(configPath, "r");
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile() || openedMetadata.size !== loaded.bytes.byteLength) {
        return false;
      }
      const current = Buffer.allocUnsafe(loaded.bytes.byteLength + 1);
      let bytesRead = 0;
      while (bytesRead < current.byteLength) {
        const result = await handle.read(
          current,
          bytesRead,
          current.byteLength - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      return (
        bytesRead === loaded.bytes.byteLength &&
        current.subarray(0, bytesRead).equals(loaded.bytes)
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    return !loaded.exists && isNodeError(error) && error.code === "ENOENT";
  }
}

async function snapshotChanged(
  configPath: string,
  loaded: LoadedConfig,
): Promise<boolean> {
  return !(await snapshotStillMatches(configPath, loaded));
}

async function writeConfigRoot(
  configPath: string,
  loaded: LoadedConfig,
  root: JsonObject,
): Promise<"ok" | "concurrent_change" | "write_failed"> {
  const bytes = Buffer.from(`${JSON.stringify(root, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_CLAUDE_CODE_CONFIG_BYTES) return "write_failed";
  return writeConfigBytes(configPath, loaded, bytes);
}

async function writeConfigBytes(
  configPath: string,
  loaded: LoadedConfig,
  bytes: Buffer<ArrayBufferLike>,
): Promise<"ok" | "concurrent_change" | "write_failed"> {
  if (bytes.byteLength > MAX_CLAUDE_CODE_CONFIG_BYTES) return "write_failed";
  const temporaryPath = join(
    dirname(configPath),
    `.${basename(configPath)}.owncontext-${randomUUID()}.tmp`,
  );

  try {
    const handle = await open(temporaryPath, "wx", loaded.mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await snapshotStillMatches(configPath, loaded))) {
      await unlink(temporaryPath).catch(() => undefined);
      return "concurrent_change";
    }
    await rename(temporaryPath, configPath);
    return "ok";
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    return "write_failed";
  }
}

async function restoreSnapshotIfOwnedProjectionOnly(
  configPath: string,
  baseline: LoadedConfig,
  current: LoadedConfig,
): Promise<boolean> {
  if (
    current.status !== "absent" ||
    !unrelatedConfigMatches(baseline.root, current.root) ||
    !(await snapshotStillMatches(configPath, current))
  ) {
    return false;
  }

  if (baseline.exists) {
    const restored = await writeConfigBytes(configPath, current, baseline.bytes);
    return restored === "ok" && await snapshotStillMatches(configPath, baseline);
  }

  if (!current.exists) return true;
  try {
    if (!(await snapshotStillMatches(configPath, current))) return false;
    await unlink(configPath);
    return await snapshotStillMatches(configPath, baseline);
  } catch {
    return false;
  }
}

function statusToMutationCode(
  status: LoadedConfig["status"],
): ClaudeCodeMutationCode | undefined {
  switch (status) {
    case "unmanaged_conflict":
    case "config_too_large":
    case "invalid_encoding":
    case "invalid_json":
    case "invalid_structure":
    case "read_failed":
      return status;
    case "absent":
    case "managed":
      return undefined;
  }
}

function mutationFailure(
  code: ClaudeCodeMutationCode,
  snippet?: string,
  backupFileName?: string,
  changed = false,
  restored = false,
): ClaudeCodeMutationResult {
  const result: ClaudeCodeMutationResult = {
    ok: false,
    code,
    changed,
    backupCreated: backupFileName !== undefined,
  };
  if (snippet !== undefined) result.snippet = snippet;
  if (backupFileName !== undefined) result.backupFileName = backupFileName;
  if (restored) result.restored = true;
  return result;
}

function mutationSuccess(
  code: Extract<ClaudeCodeMutationCode, "applied" | "removed" | "unchanged">,
  changed: boolean,
  snippet?: string,
  backupFileName?: string,
): ClaudeCodeMutationResult {
  const result: ClaudeCodeMutationResult = {
    ok: true,
    code,
    changed,
    backupCreated: backupFileName !== undefined,
  };
  if (snippet !== undefined) result.snippet = snippet;
  if (backupFileName !== undefined) result.backupFileName = backupFileName;
  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
