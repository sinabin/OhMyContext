import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";

export const DIRECTORY_IMPORT_TOKEN_BYTES = 32;
export const DIRECTORY_IMPORT_TOKEN_TTL_MS = 5 * 60 * 1_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_RETAINED_TOMBSTONES = 64;
const MAX_RENDERER_IMPORT_ISSUES = 8;

type EntryState =
  | "pending"
  | "confirming"
  | "imported"
  | "aborted"
  | "stale-scan"
  | "expired";

interface TokenEntry<TPrepared> {
  readonly token: string;
  readonly senderId: number;
  prepared: TPrepared | undefined;
  readonly issuedAt: number;
  readonly expiresAt: number;
  state: EntryState;
}

export type DirectoryImportTokenStatus =
  | "invalid"
  | "expired"
  | "aborted"
  | "imported"
  | "stale-scan";

export type DirectoryImportConfirmation<TPrepared> =
  | { status: "ready"; prepared: TPrepared }
  | { status: DirectoryImportTokenStatus };

export interface DirectoryImportTokenManagerOptions<TPrepared> {
  readonly createToken?: () => string;
  readonly ttlMs?: number;
  /** Optional lifecycle observation for cleanup verification and instrumentation. */
  readonly onPreparedReleased?: (prepared: TPrepared) => void;
}

export interface ImportResultForRenderer {
  readonly scanned: number;
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly issues: ReadonlyArray<{
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }>;
}

export interface RendererImportResult {
  readonly scanned: number;
  readonly imported: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly issueExamples: ReadonlyArray<{
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }>;
  readonly truncatedIssueCount: number;
}

/** Removes document IDs and absolute source metadata before crossing into the renderer. */
export function renderImportResult(result: ImportResultForRenderer): RendererImportResult {
  const issueExamples = result.issues.slice(0, MAX_RENDERER_IMPORT_ISSUES).map((issue) => {
    const code = rendererIssueCode(issue.code);
    return {
      code,
      path: safeRelativeIssuePath(issue.path),
      message: rendererIssueMessage(code),
    };
  });
  return {
    scanned: result.scanned,
    imported: result.imported,
    updated: result.updated,
    unchanged: result.unchanged,
    skipped: result.skipped,
    issueExamples,
    truncatedIssueCount: Math.max(0, result.issues.length - issueExamples.length),
  };
}

function rendererIssueCode(code: string): string {
  switch (code) {
    case "hardlink":
    case "invalid-utf8":
    case "outside-root":
    case "read-error":
    case "symlink":
    case "too-large":
      return code;
    default:
      return "read-error";
  }
}

function rendererIssueMessage(code: string): string {
  switch (code) {
    case "hardlink":
      return "Files with multiple hard links are not imported.";
    case "invalid-utf8":
      return "Only valid UTF-8 .md and .txt files are supported.";
    case "outside-root":
      return "The file moved outside the selected folder and was skipped.";
    case "symlink":
      return "Links are not imported.";
    case "too-large":
      return "The file exceeds the import size limit.";
    default:
      return "The file could not be read safely.";
  }
}

function safeRelativeIssuePath(value: string): string {
  if (
    value.length < 1 ||
    value.length > 512 ||
    /[\0\r\n]/u.test(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    return "(unavailable)";
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "(unavailable)";
  }
  return value.normalize("NFC");
}

function defaultCreateToken(): string {
  return randomBytes(DIRECTORY_IMPORT_TOKEN_BYTES).toString("base64url");
}

export function isValidDirectoryImportToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/**
 * Holds prepared imports exclusively in the trusted main process. Renderers see
 * only a short-lived opaque token; structured-cloning can never forge the core
 * prepared-import object identity.
 */
export class DirectoryImportTokenManager<TPrepared> {
  readonly #entries = new Map<string, TokenEntry<TPrepared>>();
  readonly #createToken: () => string;
  readonly #ttlMs: number;
  readonly #onPreparedReleased: ((prepared: TPrepared) => void) | undefined;

  public constructor(options: DirectoryImportTokenManagerOptions<TPrepared> = {}) {
    this.#createToken = options.createToken ?? defaultCreateToken;
    this.#ttlMs = options.ttlMs ?? DIRECTORY_IMPORT_TOKEN_TTL_MS;
    this.#onPreparedReleased = options.onPreparedReleased;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new RangeError("Directory import token TTL must be a positive safe integer.");
    }
  }

  public issue(senderId: number, prepared: TPrepared, now = Date.now()): string {
    assertSenderId(senderId);
    assertNow(now);
    this.abortPendingForSender(senderId, now);

    let token = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = this.#createToken();
      if (!isValidDirectoryImportToken(candidate)) {
        throw new Error("Directory import token generator returned an invalid token.");
      }
      if (!this.#entries.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) throw new Error("Directory import token generation collided repeatedly.");

    this.#entries.set(token, {
      token,
      senderId,
      prepared,
      issuedAt: now,
      expiresAt: now + this.#ttlMs,
      state: "pending",
    });
    this.#prune(now);
    return token;
  }

  public takeForConfirmation(
    token: unknown,
    senderId: number,
    now = Date.now(),
  ): DirectoryImportConfirmation<TPrepared> {
    assertSenderId(senderId);
    assertNow(now);
    const entry = this.#entryForSender(token, senderId);
    if (!entry) return { status: "invalid" };
    this.#expire(entry, now);

    switch (entry.state) {
      case "pending":
        entry.state = "confirming";
        if (entry.prepared === undefined) {
          throw new Error("Pending directory import lost its prepared state.");
        }
        return { status: "ready", prepared: entry.prepared };
      case "confirming":
      case "imported":
        return { status: "imported" };
      case "aborted":
        return { status: "aborted" };
      case "stale-scan":
        return { status: "stale-scan" };
      case "expired":
        return { status: "expired" };
    }
  }

  public cancel(
    token: unknown,
    senderId: number,
    now = Date.now(),
  ): { status: "aborted" | DirectoryImportTokenStatus } {
    assertSenderId(senderId);
    assertNow(now);
    const entry = this.#entryForSender(token, senderId);
    if (!entry) return { status: "invalid" };
    this.#expire(entry, now);

    switch (entry.state) {
      case "pending":
        this.#terminalize(entry, "aborted");
        return { status: "aborted" };
      case "confirming":
      case "imported":
        return { status: "imported" };
      case "aborted":
        return { status: "aborted" };
      case "stale-scan":
        return { status: "stale-scan" };
      case "expired":
        return { status: "expired" };
    }
  }

  public markImported(token: string): void {
    this.#setTerminalState(token, "imported");
  }

  public markStale(token: string): void {
    this.#setTerminalState(token, "stale-scan");
  }

  public markAborted(token: string): void {
    this.#setTerminalState(token, "aborted");
  }

  /** Called by the main-process expiry timer; it never exposes token state. */
  public expireIfDue(token: string, now = Date.now()): void {
    assertNow(now);
    if (!isValidDirectoryImportToken(token)) return;
    const entry = this.#entries.get(token);
    if (entry) this.#expire(entry, now);
    this.#prune(now);
  }

  public abortPendingForSender(senderId: number, now = Date.now()): void {
    assertSenderId(senderId);
    assertNow(now);
    for (const entry of this.#entries.values()) {
      this.#expire(entry, now);
      if (entry.senderId === senderId && entry.state === "pending") {
        this.#terminalize(entry, "aborted");
      }
    }
    this.#prune(now);
  }

  public abortAll(now = Date.now()): void {
    assertNow(now);
    for (const entry of this.#entries.values()) {
      this.#expire(entry, now);
      if (entry.state === "pending") this.#terminalize(entry, "aborted");
    }
    this.#prune(now);
  }

  #entryForSender(token: unknown, senderId: number): TokenEntry<TPrepared> | undefined {
    if (!isValidDirectoryImportToken(token)) return undefined;
    const entry = this.#entries.get(token);
    // Deliberately collapse a sender mismatch into the same response as an
    // unknown token so an untrusted sender gains no token-validity oracle.
    return entry?.senderId === senderId ? entry : undefined;
  }

  #expire(entry: TokenEntry<TPrepared>, now: number): void {
    if (entry.state === "pending" && now >= entry.expiresAt) {
      this.#terminalize(entry, "expired");
    }
  }

  #setTerminalState(token: string, state: Extract<EntryState, "imported" | "aborted" | "stale-scan">): void {
    const entry = this.#entries.get(token);
    if (entry?.state === "confirming" || entry?.state === "pending") {
      this.#terminalize(entry, state);
    }
  }

  #terminalize(
    entry: TokenEntry<TPrepared>,
    state: Extract<EntryState, "imported" | "aborted" | "stale-scan" | "expired">,
  ): void {
    const prepared = entry.prepared;
    entry.prepared = undefined;
    entry.state = state;
    if (prepared !== undefined) this.#onPreparedReleased?.(prepared);
  }

  #prune(now: number): void {
    const tombstones: TokenEntry<TPrepared>[] = [];
    for (const entry of this.#entries.values()) {
      this.#expire(entry, now);
      if (entry.state !== "pending" && entry.state !== "confirming") tombstones.push(entry);
    }
    tombstones.sort((left, right) => left.issuedAt - right.issuedAt);
    while (tombstones.length > MAX_RETAINED_TOMBSTONES) {
      const oldest = tombstones.shift();
      if (oldest) this.#entries.delete(oldest.token);
    }
  }
}

function assertSenderId(senderId: number): void {
  if (!Number.isSafeInteger(senderId) || senderId < 1) {
    throw new RangeError("Renderer sender ID must be a positive safe integer.");
  }
}

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Directory import token time must be a non-negative safe integer.");
  }
}
