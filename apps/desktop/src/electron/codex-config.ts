import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from "node:path";

export const OWNCONTEXT_MARKER_START =
  "# >>> owncontext managed MCP server (do not edit) >>>";
export const OWNCONTEXT_MARKER_END =
  "# <<< owncontext managed MCP server <<<";

export const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
export const MAX_MANAGED_BLOCK_BYTES = 16 * 1024;

export type CodexConfigStatus =
  | "absent"
  | "managed"
  | "managed_stale"
  | "unmanaged_conflict"
  | "malformed_managed_block"
  | "config_too_large"
  | "invalid_encoding"
  | "read_failed";

export type CodexConfigResultCode =
  | "applied"
  | "removed"
  | "unchanged"
  | "invalid_path"
  | "invalid_launch"
  | "unmanaged_conflict"
  | "malformed_managed_block"
  | "config_too_large"
  | "invalid_encoding"
  | "read_failed"
  | "backup_failed"
  | "concurrent_change"
  | "write_failed";

export interface OwnContextMcpLaunch {
  /** Absolute Node.js or Electron executable path. */
  commandPath: string;
  /** Every argument is an absolute filesystem path, normally the MCP entry file. */
  args: readonly string[];
  /** Absolute path to the private OwnContext SQLite vault. */
  vaultPath: string;
  /** Single collection this AI-client connection may search. */
  allowedCollection: string;
  runtime: "node" | "electron";
}

export interface CodexConfigPreview {
  status: CodexConfigStatus;
  canApply: boolean;
  canRemove: boolean;
  configExists: boolean;
  /** Only the proposed OwnContext block; existing Codex config is never returned. */
  snippet: string;
}

export interface CodexConfigMutationResult {
  ok: boolean;
  code: CodexConfigResultCode;
  changed: boolean;
  backupCreated: boolean;
  /** A basename only. The service never returns a user's full config path. */
  backupFileName?: string | undefined;
  /** Present for apply/update, and never contains existing config text. */
  snippet?: string | undefined;
}

export interface CodexConfigService {
  preview(launch: OwnContextMcpLaunch): Promise<CodexConfigPreview>;
  apply(launch: OwnContextMcpLaunch): Promise<CodexConfigMutationResult>;
  /** Update an existing managed block without recreating a removed connection. */
  refreshManaged(launch: OwnContextMcpLaunch): Promise<CodexConfigMutationResult>;
  remove(): Promise<CodexConfigMutationResult>;
}

interface LoadedConfig {
  exists: boolean;
  bytes: Buffer;
  text: string;
  mode: number;
  status: CodexConfigStatus;
  managedRange?: { start: number; end: number };
}

interface ServiceOptions {
  /** Internal main-process dependency. Never populate this from renderer input. */
  configPath?: string;
  /** @internal Deterministic seam for race-condition tests. */
  beforeReplaceCheck?: () => void | Promise<void>;
}

class InternalPathError extends Error {
  constructor() {
    super("Invalid internal Codex configuration path.");
    this.name = "InternalPathError";
  }
}

const START_LINE = escapeRegExp(OWNCONTEXT_MARKER_START);
const END_LINE = escapeRegExp(OWNCONTEXT_MARKER_END);
const START_PATTERN = new RegExp(`^[\\t ]*${START_LINE}[\\t ]*\\r?$`, "gm");
const END_PATTERN = new RegExp(`^[\\t ]*${END_LINE}[\\t ]*\\r?$`, "gm");
const OWNCONTEXT_TABLE_PATTERN =
  /^[\t ]*\[\[?[\t ]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[\t ]*\.[\t ]*(?:owncontext|"owncontext"|'owncontext')(?:[\t ]*\.|[\t ]*\])/gm;
const OWNCONTEXT_DOTTED_ASSIGNMENT_PATTERN =
  /^[\t ]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[\t ]*\.[\t ]*(?:owncontext|"owncontext"|'owncontext')[\t ]*=/gm;
const MCP_SERVERS_PARENT_HEADER_PATTERN =
  /^\[[\t ]*(?:mcp_servers|"mcp_servers"|'mcp_servers')[\t ]*\][\t ]*(?:#.*)?$/;
const ANY_TABLE_HEADER_PATTERN = /^\[\[?/;
const OWNCONTEXT_KEY_ASSIGNMENT_PATTERN =
  /^(?:owncontext|"owncontext"|'owncontext')[\t ]*=/;

export function defaultCodexConfigPath(homeDirectory = homedir()): string {
  if (!isAbsolute(homeDirectory)) {
    throw new InternalPathError();
  }

  return join(homeDirectory, ".codex", "config.toml");
}

/**
 * Creates a main-process-only service bound to one trusted Codex config path.
 * Renderer messages may supply launch details, but never a config file target.
 */
export function createCodexConfigService(
  options: ServiceOptions = {},
): CodexConfigService {
  const configPath = options.configPath ?? defaultCodexConfigPath();
  if (!isAbsolute(configPath) || basename(configPath) !== "config.toml") {
    throw new InternalPathError();
  }

  return {
    async preview(launch) {
      const snippet = safeSnippet(launch);
      const loaded = await loadConfig(configPath);
      const status = loaded.status === "managed" && snippet !== undefined && loaded.managedRange
        ? managedBlockMatches(loaded, snippet)
          ? "managed"
          : "managed_stale"
        : loaded.status;

      return {
        status,
        canApply:
          snippet !== undefined && (
            status === "absent" ||
            status === "managed" ||
            status === "managed_stale"
          ),
        canRemove: status === "managed" || status === "managed_stale",
        configExists: loaded.exists,
        snippet: snippet ?? "",
      };
    },

    async apply(launch) {
      const snippet = safeSnippet(launch);
      if (snippet === undefined) {
        return mutationFailure("invalid_path");
      }

      const loaded = await loadConfig(configPath);
      const blockedCode = statusToFailureCode(loaded.status);
      if (blockedCode) {
        return { ...mutationFailure(blockedCode), snippet };
      }

      const newline = loaded.text.includes("\r\n") ? "\r\n" : "\n";
      const normalizedSnippet = snippet.replaceAll("\n", newline);
      const nextText = loaded.managedRange
        ? replaceManagedBlock(loaded.text, loaded.managedRange, normalizedSnippet)
        : appendManagedBlock(loaded.text, normalizedSnippet, newline);

      if (nextText === loaded.text) {
        return {
          ok: true,
          code: "unchanged",
          changed: false,
          backupCreated: false,
          snippet,
        };
      }

      return mutateConfig(
        configPath,
        loaded,
        nextText,
        "applied",
        snippet,
        options.beforeReplaceCheck,
      );
    },

    async refreshManaged(launch) {
      const snippet = safeSnippet(launch);
      if (snippet === undefined) {
        return mutationFailure("invalid_path");
      }

      const loaded = await loadConfig(configPath);
      const blockedCode = statusToFailureCode(loaded.status);
      if (blockedCode) {
        return { ...mutationFailure(blockedCode), snippet };
      }

      if (!loaded.managedRange) {
        return {
          ok: true,
          code: "unchanged",
          changed: false,
          backupCreated: false,
          snippet,
        };
      }

      const newline = loaded.text.includes("\r\n") ? "\r\n" : "\n";
      const normalizedSnippet = snippet.replaceAll("\n", newline);
      const nextText = replaceManagedBlock(
        loaded.text,
        loaded.managedRange,
        normalizedSnippet,
      );

      if (nextText === loaded.text) {
        return {
          ok: true,
          code: "unchanged",
          changed: false,
          backupCreated: false,
          snippet,
        };
      }

      return mutateConfig(
        configPath,
        loaded,
        nextText,
        "applied",
        snippet,
        options.beforeReplaceCheck,
      );
    },

    async remove() {
      const loaded = await loadConfig(configPath);
      const blockedCode = statusToFailureCode(loaded.status);
      if (blockedCode) {
        return mutationFailure(blockedCode);
      }

      if (!loaded.managedRange) {
        return {
          ok: true,
          code: "unchanged",
          changed: false,
          backupCreated: false,
        };
      }

      const nextText = removeManagedBlock(loaded.text, loaded.managedRange);
      return mutateConfig(
        configPath,
        loaded,
        nextText,
        "removed",
        undefined,
        options.beforeReplaceCheck,
      );
    },
  };
}

export function renderOwnContextMcpBlock(launch: OwnContextMcpLaunch): string {
  validateLaunch(launch);

  const args = launch.args.map(tomlString).join(", ");
  const envEntries = [
    `OWNCONTEXT_VAULT_PATH = ${tomlString(launch.vaultPath)}`,
    `OWNCONTEXT_ALLOWED_COLLECTION = ${tomlString(launch.allowedCollection)}`,
    'OWNCONTEXT_CLIENT_KIND = "codex"',
  ];
  if (launch.runtime === "electron") {
    envEntries.push('ELECTRON_RUN_AS_NODE = "1"');
  }

  return [
    OWNCONTEXT_MARKER_START,
    "[mcp_servers.owncontext]",
    `command = ${tomlString(launch.commandPath)}`,
    `args = [${args}]`,
    `env = { ${envEntries.join(", ")} }`,
    OWNCONTEXT_MARKER_END,
  ].join("\n");
}

function safeSnippet(launch: OwnContextMcpLaunch): string | undefined {
  try {
    return renderOwnContextMcpBlock(launch);
  } catch {
    return undefined;
  }
}

function validateLaunch(launch: OwnContextMcpLaunch): void {
  if (
    (launch.runtime !== "node" && launch.runtime !== "electron") ||
    !isSafeAbsolutePath(launch.commandPath) ||
    !isSafeAbsolutePath(launch.vaultPath) ||
    !isSafeCollection(launch.allowedCollection) ||
    !Array.isArray(launch.args) ||
    launch.args.length === 0 ||
    launch.args.length > 8 ||
    launch.args.some((argument) => !isSafeAbsolutePath(argument))
  ) {
    throw new InternalPathError();
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

function isSafeAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function loadConfig(configPath: string): Promise<LoadedConfig> {
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyConfig();
    }
    return failedConfig("read_failed");
  }

  if (!metadata.isFile()) {
    return failedConfig("read_failed", true);
  }
  if (metadata.size > MAX_CODEX_CONFIG_BYTES) {
    return failedConfig("config_too_large", true, metadata.mode);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(configPath);
  } catch {
    return failedConfig("read_failed", true, metadata.mode);
  }

  if (bytes.byteLength > MAX_CODEX_CONFIG_BYTES) {
    return failedConfig("config_too_large", true, metadata.mode);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      exists: true,
      bytes,
      text: "",
      mode: metadata.mode,
      status: "invalid_encoding",
    };
  }

  const inspection = inspectConfigText(text);
  return {
    exists: true,
    bytes,
    text,
    mode: metadata.mode,
    ...inspection,
  };
}

function inspectConfigText(
  text: string,
): Pick<LoadedConfig, "status" | "managedRange"> {
  const starts = collectMatches(text, START_PATTERN);
  const ends = collectMatches(text, END_PATTERN);

  if (starts.length === 0 && ends.length === 0) {
    return {
      status: hasOwnContextTable(text) ? "unmanaged_conflict" : "absent",
    };
  }

  const startMatch = starts[0];
  const endMatch = ends[0];
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    !startMatch ||
    !endMatch ||
    endMatch.index < startMatch.index
  ) {
    return { status: "malformed_managed_block" };
  }

  const range = {
    start: startMatch.index,
    end: endMatch.index + endMatch[0].length,
  };
  const block = text.slice(range.start, range.end);
  if (
    Buffer.byteLength(block, "utf8") > MAX_MANAGED_BLOCK_BYTES ||
    !isWellFormedManagedBlock(block)
  ) {
    return { status: "malformed_managed_block" };
  }

  const outside = text.slice(0, range.start) + text.slice(range.end);
  if (hasOwnContextTable(outside)) {
    return { status: "unmanaged_conflict" };
  }

  return { status: "managed", managedRange: range };
}

function managedBlockMatches(loaded: LoadedConfig, snippet: string): boolean {
  if (!loaded.managedRange) return false;
  const block = loaded.text.slice(
    loaded.managedRange.start,
    loaded.managedRange.end,
  );
  const normalizeLineEndings = (value: string) =>
    value.replaceAll("\r\n", "\n").replace(/\r$/u, "");
  return normalizeLineEndings(block) === normalizeLineEndings(snippet);
}

function isWellFormedManagedBlock(block: string): boolean {
  const lines = block.split(/\r?\n/).map((line) => line.trim());
  return (
    lines.length === 6 &&
    lines[0]! === OWNCONTEXT_MARKER_START &&
    lines[1]! === "[mcp_servers.owncontext]" &&
    lines[2]!.startsWith("command = ") &&
    lines[2]!.length > "command = ".length &&
    lines[3]!.startsWith("args = [") &&
    lines[3]!.endsWith("]") &&
    lines[4]!.startsWith("env = { ") &&
    lines[4]!.endsWith(" }") &&
    lines[5]! === OWNCONTEXT_MARKER_END
  );
}

function hasOwnContextTable(text: string): boolean {
  OWNCONTEXT_TABLE_PATTERN.lastIndex = 0;
  if (OWNCONTEXT_TABLE_PATTERN.test(text)) {
    return true;
  }

  OWNCONTEXT_DOTTED_ASSIGNMENT_PATTERN.lastIndex = 0;
  if (OWNCONTEXT_DOTTED_ASSIGNMENT_PATTERN.test(text)) {
    return true;
  }

  let insideMcpServersParent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (MCP_SERVERS_PARENT_HEADER_PATTERN.test(line)) {
      insideMcpServersParent = true;
      continue;
    }
    if (ANY_TABLE_HEADER_PATTERN.test(line)) {
      insideMcpServersParent = false;
      continue;
    }
    if (
      insideMcpServersParent &&
      OWNCONTEXT_KEY_ASSIGNMENT_PATTERN.test(line)
    ) {
      return true;
    }
  }

  return false;
}

function collectMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(match);
  }
  return matches;
}

function appendManagedBlock(text: string, block: string, newline: string): string {
  if (text.length === 0) {
    return `${block}${newline}`;
  }

  const separator = text.endsWith(`${newline}${newline}`)
    ? ""
    : text.endsWith(newline)
      ? newline
      : `${newline}${newline}`;
  return `${text}${separator}${block}${newline}`;
}

function replaceManagedBlock(
  text: string,
  range: { start: number; end: number },
  block: string,
): string {
  return text.slice(0, range.start) + block + text.slice(range.end);
}

function removeManagedBlock(
  text: string,
  range: { start: number; end: number },
): string {
  let end = range.end;
  if (text.slice(end, end + 2) === "\r\n") {
    end += 2;
  } else if (text[end] === "\n") {
    end += 1;
  }
  return text.slice(0, range.start) + text.slice(end);
}

async function mutateConfig(
  configPath: string,
  loaded: LoadedConfig,
  nextText: string,
  successCode: "applied" | "removed",
  snippet?: string,
  beforeReplaceCheck?: () => void | Promise<void>,
): Promise<CodexConfigMutationResult> {
  const parent = dirname(configPath);
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  } catch {
    return { ...mutationFailure("write_failed"), snippet };
  }

  let backupFileName: string | undefined;
  if (loaded.exists) {
    try {
      backupFileName = await createExclusiveBackup(
        configPath,
        loaded.bytes,
        loaded.mode,
      );
    } catch {
      return { ...mutationFailure("backup_failed"), snippet };
    }
  }

  const tempPath = join(parent, `.${basename(configPath)}.owncontext-${randomUUID()}.tmp`);
  try {
    const handle = await open(tempPath, "wx", loaded.exists ? loaded.mode : 0o600);
    try {
      await handle.writeFile(nextText, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await beforeReplaceCheck?.();
    if (!(await snapshotStillMatches(configPath, loaded))) {
      await unlink(tempPath).catch(() => undefined);
      return {
        ...mutationFailure("concurrent_change"),
        backupCreated: backupFileName !== undefined,
        backupFileName,
        snippet,
      };
    }

    await rename(tempPath, configPath);
    if (!loaded.exists) {
      await chmod(configPath, 0o600).catch(() => undefined);
    }
  } catch {
    await unlink(tempPath).catch(() => undefined);
    return {
      ...mutationFailure("write_failed"),
      backupCreated: backupFileName !== undefined,
      backupFileName,
      snippet,
    };
  }

  return {
    ok: true,
    code: successCode,
    changed: true,
    backupCreated: backupFileName !== undefined,
    backupFileName,
    snippet,
  };
}

async function snapshotStillMatches(
  configPath: string,
  loaded: LoadedConfig,
): Promise<boolean> {
  try {
    const metadata = await lstat(configPath);
    if (!loaded.exists || !metadata.isFile() || metadata.isSymbolicLink()) {
      return false;
    }
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
    return (
      !loaded.exists && isNodeError(error) && error.code === "ENOENT"
    );
  }
}

async function createExclusiveBackup(
  configPath: string,
  bytes: Buffer,
  mode: number,
): Promise<string> {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const parent = dirname(configPath);
  const stem = `${basename(configPath)}.owncontext-backup-${timestamp}`;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const fileName = attempt === 0 ? stem : `${stem}-${attempt}`;
    const backupPath = join(parent, fileName);
    try {
      const handle = await open(backupPath, "wx", mode);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return fileName;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Backup name allocation failed.");
}

function statusToFailureCode(
  status: CodexConfigStatus,
): CodexConfigResultCode | undefined {
  switch (status) {
    case "unmanaged_conflict":
    case "malformed_managed_block":
    case "config_too_large":
    case "invalid_encoding":
    case "read_failed":
      return status;
    case "absent":
    case "managed":
    case "managed_stale":
      return undefined;
  }
}

function mutationFailure(code: CodexConfigResultCode): CodexConfigMutationResult {
  return {
    ok: false,
    code,
    changed: false,
    backupCreated: false,
  };
}

function emptyConfig(): LoadedConfig {
  return {
    exists: false,
    bytes: Buffer.alloc(0),
    text: "",
    mode: 0o600,
    status: "absent",
  };
}

function failedConfig(
  status: Extract<
    CodexConfigStatus,
    "read_failed" | "config_too_large" | "invalid_encoding"
  >,
  exists = false,
  mode = 0o600,
): LoadedConfig {
  return {
    exists,
    bytes: Buffer.alloc(0),
    text: "",
    mode,
    status,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
