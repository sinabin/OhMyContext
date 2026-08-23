import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chunkDocument, normalizeText, titleFromText } from "./chunking.js";
import { assertHashId, contentHash, deterministicId } from "./ids.js";
import {
  OWNCONTEXT_SAMPLE_LIBRARY_COLLECTION,
  OWNCONTEXT_SAMPLE_LIBRARY_FILES,
  OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
  OWNCONTEXT_SAMPLE_LIBRARY_SOURCE_LABEL,
  verifyOwnContextSampleLibraryDirectory,
} from "./sample.js";
import { assertSupportedSchemaVersion, initializeSchema } from "./schema.js";
import {
  snapshotVaultStorageDescriptor,
  validateVaultStorageProvider,
  type VaultStorageConnection,
  type VaultStorageDescriptor,
  type VaultStorageProvider,
  type VaultStorageValue,
} from "./storage.js";
import type {
  DeletionReceipt,
  DeletionReceiptVerification,
  CommitPreparedDirectoryImportOptions,
  DirectoryImportPreview,
  DirectoryImportPreviewIssue,
  FetchDocumentInput,
  FetchedChunk,
  ImportDirectoryOptions,
  ImportDirectoryResult,
  ImportProgress,
  ImportIssue,
  ImportedDocument,
  PreparedDirectoryImport,
  PrepareSourcePurgeResult,
  PurgeSourceInput,
  PurgeSourceResult,
  SearchVaultInput,
  SourcePurgePreview,
  Vault,
  VaultFetchResult,
  VaultSearchResult,
  VaultSource,
} from "./types.js";

const DEFAULT_COLLECTION = "default";
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_CHUNK_SIZE = 1_400;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_SCOPED_RANK_TERMS = 16;
const DEFAULT_NEIGHBORS = 1;
const MAX_NEIGHBORS = 5;
const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 50_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SUPPORTED_DIRECTORY_EXTENSIONS = Object.freeze([".md", ".txt"] as const);
const MAX_PREVIEW_EXTENSION_GROUPS = 16;
const MAX_PREVIEW_ISSUE_EXAMPLES = 20;
const MAX_PREVIEW_PATH_CHARS = 512;
const OWNCONTEXT_SAMPLE_IMPORT_FILES = new Map(
  OWNCONTEXT_SAMPLE_LIBRARY_FILES
    .filter((file) => /\.(?:md|txt)$/iu.test(file.name))
    .map((file) => [file.name, Buffer.from(file.content, "utf8")] as const),
);

interface InternalImportOptions {
  provenanceRootUri?: string;
  exactFiles?: ReadonlyMap<string, Buffer<ArrayBufferLike>>;
}

interface VaultState {
  db: VaultStorageConnection;
  closed: boolean;
  importingSources: Set<string>;
}

interface CandidateFile {
  absolutePath: string;
  relativePath: string;
}

interface ScannedCandidateFile extends CandidateFile {
  byteLength: number;
  rawContentHash: string;
}

interface PreparedFile extends CandidateFile {
  byteLength: number;
  content: string;
  contentHash: string;
  createdAt: string;
  modifiedAt: string;
  rawContentHash: string;
  sourceUri: string;
  title: string;
}

interface ResolvedDirectoryImport {
  root: string;
  rootIdentity: string;
  rootUri: string;
  sourceName: string;
  sourceId: string;
  collection: string;
  maxFileBytes: number;
  maxFiles: number;
  maxEntries: number;
  chunkSize: number;
}

interface DirectoryInventoryScan {
  /** Bounded metadata and hashes only; source bodies are never retained by preflight. */
  files: ScannedCandidateFile[];
  supportedFileCount: number;
  visitedEntryCount: number;
  candidateBytes: number;
  unsupportedFileCount: number;
  oversizedFileCount: number;
  rejectedLinkCount: number;
  readErrorCount: number;
  unsupportedExtensions: Map<string, number>;
  previewIssues: DirectoryImportPreviewIssue[];
  previewIssueCount: number;
  issues: ImportIssue[];
  fingerprint: string;
}

interface PreparedDirectoryImportState {
  resolved: ResolvedDirectoryImport;
  fingerprint: string;
  preview: DirectoryImportPreview;
}

type CandidateInspection =
  | { status: "candidate"; file: ScannedCandidateFile }
  | {
      status: "issue";
      code: ImportIssue["code"];
      message: string;
      fingerprintDetail: readonly (string | number)[];
    };

interface DocumentRow {
  id: string;
  current_revision_id: string | null;
  content_hash: string | null;
  ordinal: number | null;
}

interface SearchRow {
  document_id: string;
  chunk_id: string;
  title: string;
  snippet: string;
  source_uri: string;
  created_at: string;
  modified_at: string;
  score: number;
}

interface FetchRow {
  document_id: string;
  chunk_id: string;
  chunk_index: number;
  heading_path: string;
  content: string;
  title: string;
  source_uri: string;
  created_at: string;
  modified_at: string;
}

interface SourceRow {
  id: string;
  display_name: string;
  root_uri: string;
  collection: string;
  created_at: string;
  last_scanned_at: string | null;
  document_count: number | bigint;
}

interface SourcePurgeRow {
  id: string;
  display_name: string;
  root_uri: string;
  last_scanned_at: string | null;
}

interface SourceLineageRow {
  id: string;
  current_revision_id: string | null;
}

interface SourcePurgeSnapshot {
  preview: SourcePurgePreview;
}

interface PurgeCounts {
  sourceCount: number;
  documentCount: number;
  revisionCount: number;
  chunkCount: number;
  ftsEntryCount: number;
  retrievalEventCount: number;
}

interface DeletionReceiptRow {
  id: string;
  target_kind: "source";
  target_id: string;
  completed_at: string;
  source_count: number | bigint;
  document_count: number | bigint;
  revision_count: number | bigint;
  chunk_count: number | bigint;
  fts_entry_count: number | bigint;
  retrieval_event_count: number | bigint;
  assurance: "logical-non-addressability";
  original_files_modified: number | bigint;
  secure_erase_claimed: number | bigint;
}

const states = new WeakMap<Vault, VaultState>();
const preparedDirectoryImports = new WeakMap<
  PreparedDirectoryImport,
  PreparedDirectoryImportState
>();

class PreparedDirectoryImportHandle implements PreparedDirectoryImport {
  public readonly preview: DirectoryImportPreview;

  public constructor(state: PreparedDirectoryImportState) {
    this.preview = state.preview;
    preparedDirectoryImports.set(this, state);
    Object.freeze(this);
  }
}

export class DirectoryImportScopeChangedError extends Error {
  public readonly code = "IMPORT_SCOPE_CHANGED" as const;

  public constructor() {
    super("The selected folder changed after its import preview. Scan it again.");
    this.name = "DirectoryImportScopeChangedError";
  }
}

class DirectoryImportEntryLimitError extends RangeError {
  public constructor(limit: number) {
    super(`Import exceeds the maxEntries limit of ${limit}`);
    this.name = "DirectoryImportEntryLimitError";
  }
}

class VaultHandle implements Vault {
  public readonly path: string;
  public readonly storage;

  public constructor(
    path: string,
    db: VaultStorageConnection,
    storage: VaultStorageDescriptor,
  ) {
    this.path = path;
    this.storage = storage;
    states.set(this, { db, closed: false, importingSources: new Set() });
  }

  public close(): void {
    const state = states.get(this);
    if (!state || state.closed) return;
    state.db.close();
    state.closed = true;
  }
}

export function openVault(
  dbPath: string,
  storageProvider: VaultStorageProvider,
): Vault {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
    throw new TypeError("dbPath must be a non-empty path or :memory:");
  }
  const provider = validateVaultStorageProvider(storageProvider);
  const storage = snapshotVaultStorageDescriptor(provider.descriptor);
  const resolvedPath = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  const inspectedSchemaVersion = provider.inspectSchemaVersion(resolvedPath);
  assertSupportedSchemaVersion(inspectedSchemaVersion);
  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }
  const db = provider.open(resolvedPath);
  try {
    initializeSchema(db, inspectedSchemaVersion);
  } catch (error) {
    db.close();
    throw error;
  }
  return new VaultHandle(resolvedPath, db, storage);
}

export function importDirectory(
  vault: Vault,
  directoryPath: string,
  options: ImportDirectoryOptions = {},
): Promise<ImportDirectoryResult> {
  return importDirectoryInternal(vault, directoryPath, options);
}

export async function prepareDirectoryImport(
  directoryPath: string,
  options: ImportDirectoryOptions = {},
): Promise<PreparedDirectoryImport> {
  const resolved = await resolveDirectoryImport(directoryPath, options);
  const scan = await scanDirectoryInventory(resolved, options);
  const preview = freezeDirectoryImportPreview(
    createDirectoryImportPreview(resolved, scan),
  );
  const state: PreparedDirectoryImportState = Object.freeze({
    resolved: Object.freeze({ ...resolved }),
    fingerprint: scan.fingerprint,
    preview,
  });
  return new PreparedDirectoryImportHandle(state);
}

export async function commitPreparedDirectoryImport(
  vault: Vault,
  prepared: PreparedDirectoryImport,
  options: CommitPreparedDirectoryImportOptions = {},
): Promise<ImportDirectoryResult> {
  if (!prepared || typeof prepared !== "object") {
    throw new TypeError("prepared must be returned by prepareDirectoryImport");
  }
  const preparedState = preparedDirectoryImports.get(prepared);
  if (!preparedState) {
    throw new TypeError("prepared must be returned by prepareDirectoryImport");
  }
  if (!preparedState.preview.canImport) {
    throw new RangeError("Prepared directory import has no candidate files");
  }

  const state = stateFor(vault);
  if (state.importingSources.size > 0) {
    throw new Error("Another import is already running for this vault");
  }
  const runtimeOptions: ImportDirectoryOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
  const { resolved } = preparedState;
  state.importingSources.add(resolved.sourceId);

  try {
    return await transactionAsync(state.db, async () => {
      let scan: DirectoryInventoryScan;
      try {
        const currentRoot = await safeRoot(resolved.root);
        if (
          currentRoot.root !== resolved.root ||
          currentRoot.rootIdentity !== resolved.rootIdentity
        ) {
          throw new DirectoryImportScopeChangedError();
        }
        scan = await scanDirectoryInventory(resolved, runtimeOptions);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof DirectoryImportScopeChangedError) throw error;
        throw new DirectoryImportScopeChangedError();
      }
      if (scan.fingerprint !== preparedState.fingerprint) {
        throw new DirectoryImportScopeChangedError();
      }
      return applyDirectoryInventory(
        state.db,
        resolved,
        scan,
        runtimeOptions,
      );
    }, options.signal);
  } finally {
    state.importingSources.delete(resolved.sourceId);
  }
}

export async function importOwnContextSampleLibrary(
  vault: Vault,
  directoryPath: string,
  options: Pick<ImportDirectoryOptions, "signal" | "onProgress"> = {},
): Promise<ImportDirectoryResult> {
  const verifiedDirectory = await verifyOwnContextSampleLibraryDirectory(
    directoryPath,
  );
  return importDirectoryInternal(
    vault,
    verifiedDirectory,
    {
      ...options,
      collection: OWNCONTEXT_SAMPLE_LIBRARY_COLLECTION,
      sourceName: OWNCONTEXT_SAMPLE_LIBRARY_SOURCE_LABEL,
      maxFiles: OWNCONTEXT_SAMPLE_IMPORT_FILES.size,
    },
    {
      provenanceRootUri: OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
      exactFiles: OWNCONTEXT_SAMPLE_IMPORT_FILES,
    },
  );
}

async function importDirectoryInternal(
  vault: Vault,
  directoryPath: string,
  options: ImportDirectoryOptions,
  internal: InternalImportOptions = {},
): Promise<ImportDirectoryResult> {
  const state = stateFor(vault);
  const resolved = await resolveDirectoryImport(directoryPath, options, internal);
  if (state.importingSources.size > 0) {
    throw new Error("Another import is already running for this vault");
  }
  state.importingSources.add(resolved.sourceId);

  try {
    return await transactionAsync(state.db, async () => {
      const scan = await scanDirectoryInventory(resolved, options, internal);
      if (internal.exactFiles) {
        const actualNames = scan.files.map((candidate) => candidate.relativePath);
        const expectedNames = [...internal.exactFiles.keys()].sort(compareNames);
        if (
          actualNames.length !== expectedNames.length ||
          actualNames.some((name, index) => name !== expectedNames[index])
        ) {
          throw new Error("Built-in sample import inventory changed during verification.");
        }
      }
      return applyDirectoryInventory(
        state.db,
        resolved,
        scan,
        options,
        internal,
      );
    }, options.signal);
  } finally {
    state.importingSources.delete(resolved.sourceId);
  }
}

async function resolveDirectoryImport(
  directoryPath: string,
  options: ImportDirectoryOptions,
  internal: InternalImportOptions = {},
): Promise<ResolvedDirectoryImport> {
  throwIfAborted(options.signal);
  const collection = boundedText(
    options.collection ?? DEFAULT_COLLECTION,
    "collection",
    128,
  );
  const maxFileBytes = boundedInteger(
    options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    "maxFileBytes",
    1,
    1024 * 1024 * 1024,
  );
  const maxFiles = boundedInteger(
    options.maxFiles ?? DEFAULT_MAX_FILES,
    "maxFiles",
    1,
    DEFAULT_MAX_ENTRIES,
  );
  const maxEntries = boundedInteger(
    options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    "maxEntries",
    1,
    DEFAULT_MAX_ENTRIES,
  );
  const chunkSize = boundedInteger(
    options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    "chunkSize",
    64,
    100_000,
  );
  const safe = await safeRoot(directoryPath);
  throwIfAborted(options.signal);
  const { root, rootIdentity } = safe;
  const rootUri = internal.provenanceRootUri === undefined
    ? directoryUri(root)
    : sampleProvenanceRootUri(internal.provenanceRootUri);
  const sourceName = boundedText(
    options.sourceName ?? (basename(root) || "Selected folder"),
    "sourceName",
    512,
  );
  return {
    root,
    rootIdentity,
    rootUri,
    sourceName,
    sourceId: deterministicId("source", "folder", rootUri, collection),
    collection,
    maxFileBytes,
    maxFiles,
    maxEntries,
    chunkSize,
  };
}

async function directoryIdentity(root: string): Promise<string> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The import root identity changed");
  }
  return fileIdentity(info);
}

async function assertDirectoryRootIdentity(
  resolved: Pick<ResolvedDirectoryImport, "root" | "rootIdentity">,
): Promise<void> {
  try {
    if (await directoryIdentity(resolved.root) !== resolved.rootIdentity) {
      throw new DirectoryImportScopeChangedError();
    }
  } catch (error) {
    if (error instanceof DirectoryImportScopeChangedError) throw error;
    throw new DirectoryImportScopeChangedError();
  }
}

async function scanDirectoryInventory(
  resolved: ResolvedDirectoryImport,
  options: Pick<ImportDirectoryOptions, "signal" | "onProgress">,
  internal: InternalImportOptions = {},
): Promise<DirectoryInventoryScan> {
  const directories = [resolved.root];
  const files: ScannedCandidateFile[] = [];
  const issues: ImportIssue[] = [];
  const previewIssues: DirectoryImportPreviewIssue[] = [];
  const unsupportedExtensions = new Map<string, number>();
  const seenRelativePaths = new Set<string>();
  const inventoryHash = createHash("sha256");
  inventoryHash.update("owncontext-directory-inventory-v1\0");
  let discoveredEntryCount = 0;
  let visitedEntryCount = 0;
  let supportedFileCount = 0;
  let candidateBytes = 0;
  let unsupportedFileCount = 0;
  let oversizedFileCount = 0;
  let rejectedLinkCount = 0;
  let readErrorCount = 0;
  let previewIssueCount = 0;

  const addPreviewIssue = (
    code: DirectoryImportPreviewIssue["code"],
    path: string,
  ): void => {
    previewIssueCount += 1;
    if (previewIssues.length >= MAX_PREVIEW_ISSUE_EXAMPLES) return;
    previewIssues.push(Object.freeze({
      code,
      path: previewPath(path),
      message: previewIssueMessage(code),
    }));
  };
  const progress = (total: number | null): void => {
    reportProgress(options, {
      phase: "discovering",
      processed: visitedEntryCount,
      total,
      imported: 0,
      updated: 0,
      unchanged: 0,
      skipped: issues.length,
    });
  };

  progress(null);
  while (directories.length > 0) {
    throwIfAborted(options.signal);
    await assertDirectoryRootIdentity(resolved);
    const directory = directories.pop();
    if (!directory) continue;
    const entries = [];
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        throwIfAborted(options.signal);
        if (discoveredEntryCount >= resolved.maxEntries) {
          throw new DirectoryImportEntryLimitError(resolved.maxEntries);
        }
        discoveredEntryCount += 1;
        entries.push(entry);
      }
    } catch (error) {
      throwIfAborted(options.signal);
      if (error instanceof DirectoryImportEntryLimitError) throw error;
      const displayPath = normalizeRelative(resolved.root, directory) || ".";
      readErrorCount += 1;
      issues.push({ code: "read-error", path: displayPath, message: errorMessage(error) });
      addPreviewIssue("read-error", displayPath);
      updateInventoryHash(inventoryHash, ["directory-read-error", displayPath]);
      progress(null);
      continue;
    }
    entries.sort((left, right) => compareNames(left.name, right.name));

    for (const entry of entries) {
      throwIfAborted(options.signal);
      visitedEntryCount += 1;
      const absolutePath = resolve(directory, entry.name);
      const displayPath = normalizeRelative(resolved.root, absolutePath);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        readErrorCount += 1;
        issues.push({ code: "read-error", path: displayPath, message: errorMessage(error) });
        addPreviewIssue("read-error", displayPath);
        updateInventoryHash(inventoryHash, ["read-error", displayPath]);
        progress(null);
        continue;
      }

      if (info.isSymbolicLink()) {
        rejectedLinkCount += 1;
        issues.push({
          code: "symlink",
          path: displayPath,
          message: "Symbolic links and junctions are not followed",
        });
        addPreviewIssue("symlink", displayPath);
        updateInventoryHash(inventoryHash, ["link", displayPath]);
        progress(null);
        continue;
      }

      let actualPath: string;
      try {
        actualPath = await realpath(absolutePath);
      } catch (error) {
        readErrorCount += 1;
        issues.push({ code: "read-error", path: displayPath, message: errorMessage(error) });
        addPreviewIssue("read-error", displayPath);
        updateInventoryHash(inventoryHash, ["read-error", displayPath]);
        progress(null);
        continue;
      }
      if (!isWithin(resolved.root, actualPath)) {
        readErrorCount += 1;
        issues.push({
          code: "outside-root",
          path: displayPath,
          message: "Resolved path is outside the selected import root",
        });
        addPreviewIssue("outside-root", displayPath);
        updateInventoryHash(inventoryHash, ["outside-root", displayPath]);
        progress(null);
        continue;
      }

      if (info.isDirectory()) {
        updateInventoryHash(inventoryHash, ["directory", displayPath]);
        directories.push(actualPath);
        progress(null);
        continue;
      }
      if (!info.isFile()) {
        updateInventoryHash(inventoryHash, [
          "other",
          displayPath,
          Number(info.mode),
          Number(info.size),
        ]);
        progress(null);
        continue;
      }

      if (info.nlink > 1) {
        rejectedLinkCount += 1;
        issues.push({
          code: "hardlink",
          path: displayPath,
          message: "Files with multiple hard links are not imported",
        });
        addPreviewIssue("hardlink", displayPath);
        updateInventoryHash(inventoryHash, [
          "hardlink",
          displayPath,
          Number(info.nlink),
          Number(info.size),
          Number(info.mtimeMs),
        ]);
        progress(null);
        continue;
      }

      if (!isSupportedTextFile(entry.name)) {
        unsupportedFileCount += 1;
        const extension = previewExtension(entry.name);
        recordUnsupportedExtension(unsupportedExtensions, extension);
        addPreviewIssue("unsupported-file", displayPath);
        updateInventoryHash(inventoryHash, [
          "unsupported",
          displayPath,
          extension,
          Number(info.size),
          Number(info.mtimeMs),
        ]);
        progress(null);
        continue;
      }

      supportedFileCount += 1;
      if (supportedFileCount > resolved.maxFiles) {
        throw new RangeError(`Import exceeds the maxFiles limit of ${resolved.maxFiles}`);
      }
      if (seenRelativePaths.has(displayPath)) {
        readErrorCount += 1;
        issues.push({
          code: "read-error",
          path: displayPath,
          message: "Another file has the same normalized relative path",
        });
        addPreviewIssue("read-error", displayPath);
        updateInventoryHash(inventoryHash, ["normalized-path-collision", displayPath]);
        progress(null);
        continue;
      }
      seenRelativePaths.add(displayPath);

      if (info.size > resolved.maxFileBytes) {
        oversizedFileCount += 1;
        issues.push({
          code: "too-large",
          path: displayPath,
          message: `File is ${info.size} bytes; limit is ${resolved.maxFileBytes}`,
        });
        addPreviewIssue("too-large", displayPath);
        updateInventoryHash(inventoryHash, [
          "too-large",
          displayPath,
          Number(info.size),
          Number(info.mtimeMs),
        ]);
        progress(null);
        continue;
      }

      const candidate: CandidateFile = {
        absolutePath: actualPath,
        relativePath: displayPath,
      };
      const inspection = await inspectCandidateFile(
        resolved.root,
        candidate,
        resolved.maxFileBytes,
        options.signal,
      );
      if (inspection.status === "issue") {
        if (inspection.code === "too-large") oversizedFileCount += 1;
        else if (
          inspection.code === "symlink" ||
          inspection.code === "hardlink"
        ) rejectedLinkCount += 1;
        else if (
          inspection.code === "read-error" ||
          inspection.code === "outside-root"
        ) readErrorCount += 1;
        issues.push({
          code: inspection.code,
          path: displayPath,
          message: inspection.message,
        });
        addPreviewIssue(inspection.code, displayPath);
        updateInventoryHash(inventoryHash, [
          inspection.code,
          displayPath,
          ...inspection.fingerprintDetail,
        ]);
        progress(null);
        continue;
      }

      if (
        internal.exactFiles &&
        !internal.exactFiles.has(inspection.file.relativePath)
      ) {
        updateInventoryHash(inventoryHash, [
          "unexpected-sample-file",
          inspection.file.relativePath,
          inspection.file.byteLength,
          inspection.file.rawContentHash,
        ]);
      } else {
        updateInventoryHash(inventoryHash, [
          "candidate",
          inspection.file.relativePath,
          inspection.file.byteLength,
          inspection.file.rawContentHash,
        ]);
      }
      files.push(inspection.file);
      candidateBytes += inspection.file.byteLength;
      progress(null);
    }
  }
  files.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  await assertDirectoryRootIdentity(resolved);
  progress(visitedEntryCount);

  return {
    files,
    supportedFileCount,
    visitedEntryCount,
    candidateBytes,
    unsupportedFileCount,
    oversizedFileCount,
    rejectedLinkCount,
    readErrorCount,
    unsupportedExtensions,
    previewIssues,
    previewIssueCount,
    issues,
    fingerprint: inventoryHash.digest("hex"),
  };
}

async function inspectCandidateFile(
  root: string,
  candidate: CandidateFile,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
): Promise<CandidateInspection> {
  let fileHandle;
  try {
    throwIfAborted(signal);
    const noFollow = "O_NOFOLLOW" in constants
      ? (constants as typeof constants & { O_NOFOLLOW: number }).O_NOFOLLOW
      : 0;
    fileHandle = await open(candidate.absolutePath, constants.O_RDONLY | noFollow);
    const opened = await fileHandle.stat();
    if (!opened.isFile()) {
      return inspectionIssue("read-error", "Path is no longer a regular file", [
        Number(opened.size),
      ]);
    }
    if (opened.nlink > 1) {
      return inspectionIssue("hardlink", "Files with multiple hard links are not imported", [
        Number(opened.nlink),
        Number(opened.size),
        Number(opened.mtimeMs),
      ]);
    }
    if (opened.size > maxFileBytes) {
      return inspectionIssue(
        "too-large",
        `File is ${opened.size} bytes; limit is ${maxFileBytes}`,
        [Number(opened.size), Number(opened.mtimeMs)],
      );
    }
    const openedPathStatus = await openedPathBoundaryStatus(
      root,
      candidate.absolutePath,
      opened,
    );
    if (openedPathStatus === "outside-root") {
      return inspectionIssue(
        "outside-root",
        "File moved outside the import root while it was being scanned",
        [],
      );
    }
    if (openedPathStatus === "identity-changed") {
      return inspectionIssue(
        "read-error",
        "The opened file no longer matches its path",
        [],
      );
    }

    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    let invalidUtf8 = false;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxFileBytes) {
        return inspectionIssue(
          "too-large",
          `File grew beyond the ${maxFileBytes} byte limit while being scanned`,
          [offset],
        );
      }
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (!invalidUtf8) {
        try {
          decoder.decode(bytes, { stream: true });
        } catch {
          invalidUtf8 = true;
        }
      }
    }
    if (!invalidUtf8) {
      try {
        decoder.decode();
      } catch {
        invalidUtf8 = true;
      }
    }
    const closedOver = await fileHandle.stat();
    if (closedOver.nlink > 1) {
      return inspectionIssue("hardlink", "Files with multiple hard links are not imported", [
        Number(closedOver.nlink),
        offset,
        hash.copy().digest("hex"),
      ]);
    }
    if (invalidUtf8) {
      return inspectionIssue("invalid-utf8", "Only valid UTF-8 .md and .txt files are supported", [
        offset,
        hash.copy().digest("hex"),
      ]);
    }
    if (
      closedOver.size !== opened.size ||
      closedOver.mtimeMs !== opened.mtimeMs ||
      closedOver.dev !== opened.dev ||
      closedOver.ino !== opened.ino ||
      closedOver.size !== offset
    ) {
      return inspectionIssue("read-error", "File changed while it was being scanned", [
        offset,
        hash.copy().digest("hex"),
      ]);
    }
    const closedPathStatus = await openedPathBoundaryStatus(
      root,
      candidate.absolutePath,
      closedOver,
    );
    if (closedPathStatus === "outside-root") {
      return inspectionIssue(
        "outside-root",
        "File moved outside the import root while it was being scanned",
        [],
      );
    }
    if (closedPathStatus === "identity-changed") {
      return inspectionIssue(
        "read-error",
        "The opened file no longer matches its path",
        [],
      );
    }
    return {
      status: "candidate",
      file: {
        ...candidate,
        byteLength: offset,
        rawContentHash: hash.digest("hex"),
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return inspectionIssue("read-error", errorMessage(error), []);
  } finally {
    await fileHandle?.close();
  }
}

function inspectionIssue(
  code: ImportIssue["code"],
  message: string,
  fingerprintDetail: readonly (string | number)[],
): CandidateInspection {
  return { status: "issue", code, message, fingerprintDetail };
}

async function applyDirectoryInventory(
  db: VaultStorageConnection,
  resolved: ResolvedDirectoryImport,
  scan: DirectoryInventoryScan,
  options: Pick<ImportDirectoryOptions, "signal" | "onProgress">,
  internal: InternalImportOptions = {},
): Promise<ImportDirectoryResult> {
  const issues = [...scan.issues];
  const startedAt = new Date().toISOString();
  const documents: ImportedDocument[] = [];
  let imported = 0;
  let updated = 0;
  let unchanged = 0;
  let processed = 0;
  const progress = (phase: ImportProgress["phase"]): void => {
    reportProgress(options, {
      phase,
      processed,
      total: scan.files.length,
      imported,
      updated,
      unchanged,
      skipped: issues.length,
    });
  };

  db.prepare(`
    INSERT INTO sources(
      id, kind, root_uri, collection, display_name, created_at, last_scanned_at
    ) VALUES (?, 'folder', ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      last_scanned_at = NULL
  `).run(
    resolved.sourceId,
    resolved.rootUri,
    resolved.collection,
    resolved.sourceName,
    startedAt,
  );

  progress("importing");
  for (const candidate of scan.files) {
    throwIfAborted(options.signal);
    const file = await prepareFile(
      resolved.root,
      candidate,
      resolved.maxFileBytes,
      issues,
      options.signal,
      internal.provenanceRootUri === undefined ? undefined : resolved.rootUri,
      internal.exactFiles?.get(candidate.relativePath),
    );
    if (!file) {
      if (internal.exactFiles) {
        throw new Error("Built-in sample bytes changed during import.");
      }
      throw new DirectoryImportScopeChangedError();
    }

    const importedDocument = importPreparedFile(
      db,
      resolved.sourceId,
      file,
      resolved.chunkSize,
      startedAt,
    );
    documents.push(importedDocument);
    if (importedDocument.status === "created") imported += 1;
    else if (importedDocument.status === "updated") updated += 1;
    else unchanged += 1;
    processed += 1;
    progress("importing");
  }

  if (internal.exactFiles) {
    const expectedNames = [...internal.exactFiles.keys()];
    const placeholders = expectedNames.map(() => "?").join(", ");
    db.prepare(`
      DELETE FROM documents
      WHERE source_id = ?
        AND relative_path NOT IN (${placeholders})
    `).run(resolved.sourceId, ...expectedNames);
  }

  progress("finalizing");
  throwIfAborted(options.signal);
  await assertDirectoryRootIdentity(resolved);
  throwIfAborted(options.signal);
  db.prepare("UPDATE sources SET last_scanned_at = ? WHERE id = ?")
    .run(new Date().toISOString(), resolved.sourceId);
  throwIfAborted(options.signal);
  return {
    sourceId: resolved.sourceId,
    rootUri: resolved.rootUri,
    collection: resolved.collection,
    scanned: scan.supportedFileCount,
    imported,
    updated,
    unchanged,
    skipped: issues.length,
    documents,
    issues,
  };
}

function createDirectoryImportPreview(
  resolved: ResolvedDirectoryImport,
  scan: DirectoryInventoryScan,
): DirectoryImportPreview {
  return {
    schemaVersion: 1,
    sourceName: resolved.sourceName,
    collection: resolved.collection,
    supportedExtensions: [...SUPPORTED_DIRECTORY_EXTENSIONS],
    visitedEntryCount: scan.visitedEntryCount,
    candidateFileCount: scan.files.length,
    candidateBytes: scan.candidateBytes,
    unsupportedFileCount: scan.unsupportedFileCount,
    oversizedFileCount: scan.oversizedFileCount,
    rejectedLinkCount: scan.rejectedLinkCount,
    readErrorCount: scan.readErrorCount,
    unsupportedByExtension: [...scan.unsupportedExtensions.entries()]
      .map(([extension, count]) => ({ extension, count }))
      .sort((left, right) => compareNames(left.extension, right.extension)),
    issueExamples: [...scan.previewIssues],
    truncatedIssueCount: scan.previewIssueCount - scan.previewIssues.length,
    canImport: scan.files.length > 0,
  };
}

function freezeDirectoryImportPreview(
  preview: DirectoryImportPreview,
): DirectoryImportPreview {
  const unsupportedByExtension = Object.freeze(
    preview.unsupportedByExtension.map((item) => Object.freeze({ ...item })),
  );
  const issueExamples = Object.freeze(
    preview.issueExamples.map((item) => Object.freeze({ ...item })),
  );
  return Object.freeze({
    ...preview,
    supportedExtensions: Object.freeze([...preview.supportedExtensions]),
    unsupportedByExtension,
    issueExamples,
  });
}

function updateInventoryHash(
  hash: ReturnType<typeof createHash>,
  value: readonly (string | number)[],
): void {
  const serialized = JSON.stringify(value);
  hash.update(String(Buffer.byteLength(serialized, "utf8")));
  hash.update(":");
  hash.update(serialized);
}

function recordUnsupportedExtension(counts: Map<string, number>, extension: string): void {
  const existing = counts.get(extension);
  if (existing !== undefined) {
    counts.set(extension, existing + 1);
    return;
  }
  if (counts.size < MAX_PREVIEW_EXTENSION_GROUPS - 1) {
    counts.set(extension, 1);
    return;
  }
  counts.set("(other)", (counts.get("(other)") ?? 0) + 1);
}

function previewExtension(name: string): string {
  const extension = extname(name).toLocaleLowerCase("en-US");
  if (extension.length === 0) return "(none)";
  return extension.length <= 32 ? extension : "(long extension)";
}

function previewPath(path: string): string {
  if (path.length <= MAX_PREVIEW_PATH_CHARS) return path;
  return `${path.slice(0, MAX_PREVIEW_PATH_CHARS - 1)}…`;
}

function previewIssueMessage(code: DirectoryImportPreviewIssue["code"]): string {
  switch (code) {
    case "hardlink":
      return "Files with multiple hard links are not imported.";
    case "invalid-utf8":
      return "Supported text file is not valid UTF-8.";
    case "outside-root":
      return "Entry resolved outside the selected folder.";
    case "read-error":
      return "Entry could not be inspected safely.";
    case "symlink":
      return "Symbolic links and junctions are not followed.";
    case "too-large":
      return "Supported file exceeds the configured size limit.";
    case "unsupported-file":
      return "File type is not supported.";
  }
}

export function listSources(vault: Vault): VaultSource[] {
  const rows = databaseFor(vault).prepare(`
    SELECT
      s.id,
      s.display_name,
      s.root_uri,
      s.collection,
      s.created_at,
      s.last_scanned_at,
      count(d.id) AS document_count
    FROM sources s
    LEFT JOIN documents d ON d.source_id = s.id
    GROUP BY s.id
    ORDER BY s.display_name COLLATE NOCASE, s.id
  `).all() as unknown as SourceRow[];

  return rows.map((row) => ({
    sourceId: row.id,
    name: row.display_name,
    rootUri: row.root_uri,
    collection: row.collection,
    createdAt: row.created_at,
    lastScannedAt: row.last_scanned_at,
    status: row.last_scanned_at === null ? "incomplete" : "ready",
    documentCount: Number(row.document_count),
  }));
}

export function prepareSourcePurge(
  vault: Vault,
  sourceId: string,
): PrepareSourcePurgeResult {
  const state = stateFor(vault);
  assertHashId(sourceId, "sourceId");
  if (state.importingSources.size > 0) {
    return { status: "import-in-progress" };
  }

  const snapshot = sourcePurgeSnapshot(state.db, sourceId);
  return snapshot
    ? { status: "ready", preview: snapshot.preview }
    : { status: "not-found" };
}

export function purgeSource(
  vault: Vault,
  input: PurgeSourceInput,
): PurgeSourceResult {
  const state = stateFor(vault);
  validatePurgeSourceInput(input);
  if (state.importingSources.size > 0) {
    return { status: "import-in-progress" };
  }

  return transactionImmediate(state.db, () => {
    // JavaScript execution is synchronous inside this transaction, but retain
    // the guard here so future callers cannot accidentally nest purge inside an
    // asynchronous import transaction.
    if (state.importingSources.size > 0) {
      return { status: "import-in-progress" };
    }

    const snapshot = sourcePurgeSnapshot(state.db, input.sourceId);
    if (!snapshot) return { status: "not-found" };
    if (
      snapshot.preview.documentCount !== input.expectedDocumentCount ||
      snapshot.preview.lastScannedAt !== input.expectedLastScannedAt ||
      snapshot.preview.confirmationToken !== input.confirmationToken
    ) {
      return { status: "stale-confirmation" };
    }

    const targetCounts = sourcePurgeCounts(state.db, input.sourceId);
    const before = databaseTotals(state.db);
    if (targetCounts.sourceCount !== 1) {
      throw new Error("Source purge precondition failed");
    }

    // Retrieval audit rows linked to the source are removed instead of being
    // retained with query hashes after their document/chunk references become
    // NULL. The content-free deletion receipt retains only the number removed.
    state.db.prepare(`
      DELETE FROM retrieval_events
      WHERE document_id IN (
        SELECT id FROM documents WHERE source_id = ?
      ) OR chunk_id IN (
        SELECT c.id
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = ?
      )
    `).run(input.sourceId, input.sourceId);

    // Delete all index rows tied to the source explicitly. The chunk trigger
    // then becomes an idempotent defense-in-depth cleanup during the cascade.
    state.db.prepare(`
      DELETE FROM chunks_fts
      WHERE document_id IN (
        SELECT id FROM documents WHERE source_id = ?
      )
    `).run(input.sourceId);

    const deletedSource = state.db.prepare("DELETE FROM sources WHERE id = ?")
      .run(input.sourceId);
    if (Number(deletedSource.changes) !== 1) {
      throw new Error("Source purge did not delete exactly one source");
    }

    const after = databaseTotals(state.db);
    assertPurgeDeltas(before, after, targetCounts);
    if (state.db.prepare("SELECT 1 FROM sources WHERE id = ?").get(input.sourceId)) {
      throw new Error("Source remains addressable after purge");
    }
    if (state.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Source purge left a foreign-key integrity error");
    }

    const receipt: DeletionReceipt = {
      receiptId: randomBytes(32).toString("hex"),
      targetKind: "source",
      targetId: input.sourceId,
      completedAt: new Date().toISOString(),
      ...targetCounts,
      assurance: "logical-non-addressability",
      originalFilesModified: false,
      secureEraseClaimed: false,
    };
    insertDeletionReceipt(state.db, receipt);
    return { status: "purged", receipt };
  });
}

export function listDeletionReceipts(
  vault: Vault,
  limit = 20,
): DeletionReceipt[] {
  const boundedLimit = boundedInteger(limit, "limit", 1, 100);
  const rows = databaseFor(vault).prepare(`
    SELECT
      id, target_kind, target_id, completed_at, source_count,
      document_count, revision_count, chunk_count, fts_entry_count,
      retrieval_event_count, assurance, original_files_modified,
      secure_erase_claimed
    FROM deletion_receipts
    ORDER BY completed_at DESC, id DESC
    LIMIT ?
  `).all(boundedLimit) as unknown as DeletionReceiptRow[];
  return rows.map(deletionReceiptFromRow);
}

export function verifyDeletionReceipt(
  vault: Vault,
  receiptId: string,
): DeletionReceiptVerification {
  assertHashId(receiptId, "receiptId");
  const db = databaseFor(vault);
  const row = db.prepare(`
    SELECT
      id, target_kind, target_id, completed_at, source_count,
      document_count, revision_count, chunk_count, fts_entry_count,
      retrieval_event_count, assurance, original_files_modified,
      secure_erase_claimed
    FROM deletion_receipts
    WHERE id = ?
  `).get(receiptId) as unknown as DeletionReceiptRow | undefined;
  if (!row) return { status: "not-found" };

  const receipt = deletionReceiptFromRow(row);
  if (hasVaultProjectionIntegrityError(db)) {
    return { status: "integrity-error", receipt };
  }
  if (db.prepare("SELECT 1 FROM sources WHERE id = ?").get(receipt.targetId)) {
    return { status: "target-reintroduced", receipt };
  }
  return { status: "verified", receipt };
}

export function searchVault(vault: Vault, input: SearchVaultInput): VaultSearchResult[] {
  const db = databaseFor(vault);
  if (!input || typeof input.query !== "string") {
    throw new TypeError("query must be a string");
  }
  const query = input.query.trim();
  if (query.length === 0 || query.length > 2_000) {
    throw new RangeError("query must contain between 1 and 2,000 characters");
  }
  const limit = boundedInteger(
    input.limit ?? DEFAULT_SEARCH_LIMIT,
    "limit",
    1,
    MAX_SEARCH_LIMIT,
  );
  const conditions = [
    "chunks_fts MATCH ?",
    "d.current_revision_id = c.revision_id",
    "s.last_scanned_at IS NOT NULL",
  ];
  const whereParameters: VaultStorageValue[] = [literalFtsQuery(query)];
  const scoreParameters: VaultStorageValue[] = [];
  const collectionScoped = input.collection !== undefined;

  if (collectionScoped) {
    conditions.push("s.collection = ?");
    whereParameters.push(boundedText(input.collection!, "collection", 128));
  }
  addDateFilter(conditions, whereParameters, "d.created_at", ">=", input.createdFrom, "createdFrom");
  addDateFilter(conditions, whereParameters, "d.created_at", "<=", input.createdTo, "createdTo");
  addDateFilter(conditions, whereParameters, "d.modified_at", ">=", input.modifiedFrom, "modifiedFrom");
  addDateFilter(conditions, whereParameters, "d.modified_at", "<=", input.modifiedTo, "modifiedTo");

  const scopedScoreTerms = collectionScoped
    ? query.split(/\s+/u).filter(Boolean).slice(0, MAX_SCOPED_RANK_TERMS)
    : [];
  const scopedScoreParts = scopedScoreTerms.map((term) => {
    scoreParameters.push(term, term, term);
    return [
      "CASE WHEN instr(lower(chunks_fts.title), lower(?)) > 0 THEN 4 ELSE 0 END",
      "CASE WHEN instr(lower(chunks_fts.heading_path), lower(?)) > 0 THEN 2 ELSE 0 END",
      "CASE WHEN instr(lower(chunks_fts.content), lower(?)) > 0 THEN 1 ELSE 0 END",
    ].join(" + ");
  });
  const scoreExpression = collectionScoped
    ? `0.0 - (${scopedScoreParts.join(" + ")})`
    : "bm25(chunks_fts, 0.0, 0.0, 0.0, 0.3, 0.1, 1.0)";

  let rows: SearchRow[];
  try {
    rows = db.prepare(`
      SELECT
        d.id AS document_id,
        c.id AS chunk_id,
        d.title,
        snippet(chunks_fts, 5, '', '', ' … ', 24) AS snippet,
        d.source_uri,
        d.created_at,
        d.modified_at,
        ${scoreExpression} AS score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.chunk_id
      JOIN documents d ON d.id = c.document_id
      JOIN sources s ON s.id = d.source_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY score, d.modified_at DESC, d.id, c.chunk_index
      LIMIT ?
    `).all(...scoreParameters, ...whereParameters, limit) as unknown as SearchRow[];
  } catch (error) {
    if (isFtsSyntaxError(error)) rows = [];
    else throw error;
  }

  const createdAt = new Date().toISOString();
  transaction(db, () => {
    const insertEvent = db.prepare(`
      INSERT INTO retrieval_events(
        event_type, query_hash, document_id, chunk_id, result_count, created_at
      ) VALUES ('search', ?, ?, ?, ?, ?)
    `);
    const queryHash = deterministicId("retrieval-query", query);
    if (rows.length === 0) {
      insertEvent.run(queryHash, null, null, 0, createdAt);
    } else {
      for (const row of rows) {
        insertEvent.run(queryHash, row.document_id, row.chunk_id, rows.length, createdAt);
      }
    }
  });

  return rows.map((row) => ({
    documentId: row.document_id,
    chunkId: row.chunk_id,
    title: row.title,
    snippet: row.snippet,
    sourceUri: row.source_uri,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    score: row.score,
  }));
}

export function fetchDocument(
  vault: Vault,
  input: FetchDocumentInput,
): VaultFetchResult | null {
  const db = databaseFor(vault);
  if (!input || typeof input.documentId !== "string") {
    throw new TypeError("documentId is required");
  }
  assertHashId(input.documentId, "documentId");
  if (input.chunkId !== undefined) assertHashId(input.chunkId, "chunkId");
  const before = boundedInteger(input.before ?? DEFAULT_NEIGHBORS, "before", 0, MAX_NEIGHBORS);
  const after = boundedInteger(input.after ?? DEFAULT_NEIGHBORS, "after", 0, MAX_NEIGHBORS);
  const maxChars = boundedInteger(
    input.maxChars ?? DEFAULT_FETCH_CHARS,
    "maxChars",
    1,
    MAX_FETCH_CHARS,
  );

  const allRows = db.prepare(`
    SELECT
      d.id AS document_id,
      c.id AS chunk_id,
      c.chunk_index,
      c.heading_path,
      c.content,
      d.title,
      d.source_uri,
      d.created_at,
      d.modified_at
    FROM documents d
    JOIN chunks c ON c.revision_id = d.current_revision_id
    JOIN sources s ON s.id = d.source_id
    WHERE d.id = ? AND s.last_scanned_at IS NOT NULL
    ORDER BY c.chunk_index
  `).all(input.documentId) as unknown as FetchRow[];
  if (allRows.length === 0) return null;

  const anchorPosition = input.chunkId === undefined
    ? 0
    : allRows.findIndex((row) => row.chunk_id === input.chunkId);
  if (anchorPosition < 0) return null;

  const selected = allRows.slice(
    Math.max(0, anchorPosition - before),
    Math.min(allRows.length, anchorPosition + after + 1),
  );
  const bounded = boundFetchedChunks(selected, anchorPosition, allRows, maxChars);
  const anchor = allRows[anchorPosition];
  const first = allRows[0];
  if (!anchor || !first) return null;
  const content = bounded.map((chunk) => chunk.content).join("\n\n");
  const result: VaultFetchResult = {
    documentId: first.document_id,
    chunkId: anchor.chunk_id,
    title: first.title,
    snippet: content,
    sourceUri: first.source_uri,
    createdAt: first.created_at,
    modifiedAt: first.modified_at,
    content,
    chunks: bounded,
  };

  db.prepare(`
    INSERT INTO retrieval_events(
      event_type, query_hash, document_id, chunk_id, result_count, created_at
    ) VALUES ('fetch', NULL, ?, ?, 1, ?)
  `).run(result.documentId, result.chunkId, new Date().toISOString());
  return result;
}

export function purgeDocument(vault: Vault, documentId: string): boolean {
  const db = databaseFor(vault);
  assertHashId(documentId, "documentId");
  let deleted = false;
  transaction(db, () => {
    const result = db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
    deleted = Number(result.changes) > 0;
  });
  return deleted;
}

function sourcePurgeSnapshot(
  db: VaultStorageConnection,
  sourceId: string,
): SourcePurgeSnapshot | null {
  const source = db.prepare(`
    SELECT id, display_name, root_uri, last_scanned_at
    FROM sources
    WHERE id = ?
  `).get(sourceId) as unknown as SourcePurgeRow | undefined;
  if (!source) return null;

  const lineage = db.prepare(`
    SELECT id, current_revision_id
    FROM documents
    WHERE source_id = ?
    ORDER BY id
  `).all(sourceId) as unknown as SourceLineageRow[];
  const lineageDigestInput = lineage
    .map((document) => `${document.id}:${document.current_revision_id ?? "none"}`)
    .join("\n");
  const confirmationToken = deterministicId(
    "source-purge-confirmation",
    source.id,
    source.last_scanned_at ?? "none",
    String(lineage.length),
    lineageDigestInput,
  );

  return {
    preview: {
      sourceId: source.id,
      name: source.display_name,
      rootUri: source.root_uri,
      documentCount: lineage.length,
      lastScannedAt: source.last_scanned_at,
      confirmationToken,
    },
  };
}

function validatePurgeSourceInput(input: PurgeSourceInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("purge source input is required");
  }
  assertHashId(input.sourceId, "sourceId");
  assertHashId(input.confirmationToken, "confirmationToken");
  boundedInteger(input.expectedDocumentCount, "expectedDocumentCount", 0, 1_000_000);
  if (
    input.expectedLastScannedAt !== null &&
    (
      typeof input.expectedLastScannedAt !== "string" ||
      input.expectedLastScannedAt.length === 0 ||
      input.expectedLastScannedAt.length > 64
    )
  ) {
    throw new TypeError("expectedLastScannedAt must be a bounded timestamp or null");
  }
}

function sourcePurgeCounts(db: VaultStorageConnection, sourceId: string): PurgeCounts {
  return {
    sourceCount: countRows(db, "SELECT count(*) AS count FROM sources WHERE id = ?", sourceId),
    documentCount: countRows(
      db,
      "SELECT count(*) AS count FROM documents WHERE source_id = ?",
      sourceId,
    ),
    revisionCount: countRows(db, `
      SELECT count(*) AS count
      FROM revisions r
      JOIN documents d ON d.id = r.document_id
      WHERE d.source_id = ?
    `, sourceId),
    chunkCount: countRows(db, `
      SELECT count(*) AS count
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.source_id = ?
    `, sourceId),
    ftsEntryCount: countRows(db, `
      SELECT count(*) AS count
      FROM chunks_fts f
      JOIN documents d ON d.id = f.document_id
      WHERE d.source_id = ?
    `, sourceId),
    retrievalEventCount: countRows(db, `
      SELECT count(*) AS count
      FROM retrieval_events
      WHERE document_id IN (
        SELECT id FROM documents WHERE source_id = ?
      ) OR chunk_id IN (
        SELECT c.id
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.source_id = ?
      )
    `, sourceId, sourceId),
  };
}

function databaseTotals(db: VaultStorageConnection): PurgeCounts {
  return {
    sourceCount: countRows(db, "SELECT count(*) AS count FROM sources"),
    documentCount: countRows(db, "SELECT count(*) AS count FROM documents"),
    revisionCount: countRows(db, "SELECT count(*) AS count FROM revisions"),
    chunkCount: countRows(db, "SELECT count(*) AS count FROM chunks"),
    ftsEntryCount: countRows(db, "SELECT count(*) AS count FROM chunks_fts"),
    retrievalEventCount: countRows(db, "SELECT count(*) AS count FROM retrieval_events"),
  };
}

function countRows(
  db: VaultStorageConnection,
  sql: string,
  ...parameters: VaultStorageValue[]
): number {
  const row = db.prepare(sql).get(...parameters) as
    | { count: number | bigint }
    | undefined;
  return Number(row?.count ?? 0);
}

function assertPurgeDeltas(
  before: PurgeCounts,
  after: PurgeCounts,
  removed: PurgeCounts,
): void {
  const fields = [
    "sourceCount",
    "documentCount",
    "revisionCount",
    "chunkCount",
    "ftsEntryCount",
    "retrievalEventCount",
  ] as const;
  for (const field of fields) {
    if (after[field] !== before[field] - removed[field]) {
      throw new Error(`Source purge postcondition failed for ${field}`);
    }
  }
}

function insertDeletionReceipt(db: VaultStorageConnection, receipt: DeletionReceipt): void {
  db.prepare(`
    INSERT INTO deletion_receipts(
      id, target_kind, target_id, completed_at, source_count,
      document_count, revision_count, chunk_count, fts_entry_count,
      retrieval_event_count, assurance, original_files_modified,
      secure_erase_claimed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(
    receipt.receiptId,
    receipt.targetKind,
    receipt.targetId,
    receipt.completedAt,
    receipt.sourceCount,
    receipt.documentCount,
    receipt.revisionCount,
    receipt.chunkCount,
    receipt.ftsEntryCount,
    receipt.retrievalEventCount,
    receipt.assurance,
  );
}

function deletionReceiptFromRow(row: DeletionReceiptRow): DeletionReceipt {
  if (
    row.target_kind !== "source" ||
    row.assurance !== "logical-non-addressability" ||
    Number(row.original_files_modified) !== 0 ||
    Number(row.secure_erase_claimed) !== 0
  ) {
    throw new Error("Stored deletion receipt violates its content-free contract");
  }
  return {
    receiptId: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    completedAt: row.completed_at,
    sourceCount: Number(row.source_count),
    documentCount: Number(row.document_count),
    revisionCount: Number(row.revision_count),
    chunkCount: Number(row.chunk_count),
    ftsEntryCount: Number(row.fts_entry_count),
    retrievalEventCount: Number(row.retrieval_event_count),
    assurance: row.assurance,
    originalFilesModified: false,
    secureEraseClaimed: false,
  };
}

function hasVaultProjectionIntegrityError(db: VaultStorageConnection): boolean {
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) return true;

  // FTS5 virtual tables cannot carry foreign keys. Check both directions so a
  // receipt is not presented as current when the content-bearing search
  // projection has an orphan, mismatch, duplicate, or missing chunk row.
  const orphanOrMismatch = db.prepare(`
    SELECT 1
    FROM chunks_fts f
    LEFT JOIN chunks c ON c.id = f.chunk_id
    WHERE c.id IS NULL
       OR f.document_id IS NOT c.document_id
       OR f.revision_id IS NOT c.revision_id
       OR f.title IS NOT c.title
       OR f.heading_path IS NOT c.heading_path
       OR f.content IS NOT c.content
    LIMIT 1
  `).get();
  if (orphanOrMismatch) return true;

  return Boolean(db.prepare(`
    SELECT 1
    FROM chunks c
    LEFT JOIN chunks_fts f ON f.chunk_id = c.id
    GROUP BY c.id
    HAVING count(f.rowid) <> 1
    LIMIT 1
  `).get());
}

function stateFor(vault: Vault): VaultState {
  const state = states.get(vault);
  if (!state) throw new TypeError("vault was not created by openVault");
  if (state.closed) throw new Error("vault is closed");
  return state;
}

function databaseFor(vault: Vault): VaultStorageConnection {
  return stateFor(vault).db;
}

function importPreparedFile(
  db: VaultStorageConnection,
  sourceId: string,
  file: PreparedFile,
  chunkSize: number,
  importedAt: string,
): ImportedDocument {
  const documentId = deterministicId("document", sourceId, file.relativePath);
  const existing = db.prepare(`
    SELECT
      d.id,
      d.current_revision_id,
      r.content_hash,
      r.ordinal
    FROM documents d
    LEFT JOIN revisions r ON r.id = d.current_revision_id
    WHERE d.id = ?
  `).get(documentId) as unknown as DocumentRow | undefined;

  if (existing && existing.content_hash === file.contentHash) {
    if (!existing.current_revision_id) {
      throw new Error(`Document ${documentId} has no current revision`);
    }
    db.prepare(`
      UPDATE documents SET
        source_uri = ?, title = ?, created_at = ?, modified_at = ?
      WHERE id = ?
    `).run(file.sourceUri, file.title, file.createdAt, file.modifiedAt, documentId);
    return {
      documentId,
      revisionId: existing.current_revision_id,
      sourceUri: file.sourceUri,
      relativePath: file.relativePath,
      status: "unchanged",
    };
  }

  if (!existing) {
    db.prepare(`
      INSERT INTO documents(
        id, source_id, relative_path, source_uri, title,
        created_at, modified_at, current_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      documentId,
      sourceId,
      file.relativePath,
      file.sourceUri,
      file.title,
      file.createdAt,
      file.modifiedAt,
    );
  } else {
    db.prepare(`
      UPDATE documents SET
        source_uri = ?, title = ?, created_at = ?, modified_at = ?
      WHERE id = ?
    `).run(file.sourceUri, file.title, file.createdAt, file.modifiedAt, documentId);
  }

  const ordinal = (existing?.ordinal ?? 0) + 1;
  const revisionId = deterministicId(
    "revision",
    documentId,
    String(ordinal),
    file.contentHash,
  );
  db.prepare(`
    INSERT INTO revisions(
      id, document_id, ordinal, content_hash, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(revisionId, documentId, ordinal, file.contentHash, file.content, importedAt);

  const chunks = chunkDocument(revisionId, file.content, chunkSize);
  const insertChunk = db.prepare(`
    INSERT INTO chunks(
      id, revision_id, document_id, chunk_index, heading_path,
      start_offset, end_offset, content, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const chunk of chunks) {
    insertChunk.run(
      chunk.id,
      revisionId,
      documentId,
      chunk.index,
      JSON.stringify(chunk.headingPath),
      chunk.startOffset,
      chunk.endOffset,
      chunk.content,
      file.title,
    );
  }
  db.prepare("UPDATE documents SET current_revision_id = ? WHERE id = ?")
    .run(revisionId, documentId);

  return {
    documentId,
    revisionId,
    sourceUri: file.sourceUri,
    relativePath: file.relativePath,
    status: existing ? "updated" : "created",
  };
}

async function safeRoot(
  directoryPath: string,
): Promise<{ root: string; rootIdentity: string }> {
  if (typeof directoryPath !== "string" || directoryPath.trim().length === 0) {
    throw new TypeError("directoryPath must be a non-empty path");
  }
  const requested = resolve(directoryPath);
  const before = await lstat(requested);
  if (before.isSymbolicLink()) {
    throw new Error("The import root must not be a symbolic link");
  }
  if (!before.isDirectory()) {
    throw new Error("The import root must be a directory");
  }
  const root = await realpath(requested);
  const [after, canonical] = await Promise.all([lstat(requested), lstat(root)]);
  if (
    after.isSymbolicLink() ||
    canonical.isSymbolicLink() ||
    !after.isDirectory() ||
    !canonical.isDirectory() ||
    fileIdentity(before) !== fileIdentity(after) ||
    fileIdentity(before) !== fileIdentity(canonical)
  ) {
    throw new Error("The import root changed while it was being resolved");
  }
  return { root, rootIdentity: fileIdentity(before) };
}

function fileIdentity(info: { dev: number | bigint; ino: number | bigint; birthtimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

async function openedPathBoundaryStatus(
  root: string,
  path: string,
  opened: {
    dev: number | bigint;
    ino: number | bigint;
    birthtimeMs: number;
    nlink: number;
    isFile(): boolean;
  },
): Promise<"within-root" | "outside-root" | "identity-changed"> {
  const canonical = await realpath(path);
  if (!isWithin(root, canonical)) return "outside-root";
  const current = await lstat(canonical);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !opened.isFile() ||
    current.nlink > 1 ||
    opened.nlink > 1 ||
    fileIdentity(current) !== fileIdentity(opened)
  ) {
    return "identity-changed";
  }
  return "within-root";
}

async function prepareFile(
  root: string,
  candidate: ScannedCandidateFile,
  maxFileBytes: number,
  issues: ImportIssue[],
  signal: AbortSignal | undefined,
  provenanceRootUri: string | undefined,
  exactBytes: Buffer<ArrayBufferLike> | undefined,
): Promise<PreparedFile | null> {
  let fileHandle;
  try {
    throwIfAborted(signal);
    const noFollow = "O_NOFOLLOW" in constants
      ? (constants as typeof constants & { O_NOFOLLOW: number }).O_NOFOLLOW
      : 0;
    fileHandle = await open(candidate.absolutePath, constants.O_RDONLY | noFollow);
    throwIfAborted(signal);
    const info = await fileHandle.stat();
    throwIfAborted(signal);
    if (!info.isFile()) {
      issues.push({
        code: "read-error",
        path: candidate.relativePath,
        message: "Path is no longer a regular file",
      });
      return null;
    }
    if (info.nlink > 1) {
      throw new DirectoryImportScopeChangedError();
    }
    if (info.size > maxFileBytes) {
      issues.push({
        code: "too-large",
        path: candidate.relativePath,
        message: `File is ${info.size} bytes; limit is ${maxFileBytes}`,
      });
      return null;
    }
    if (
      await openedPathBoundaryStatus(root, candidate.absolutePath, info) !== "within-root"
    ) {
      throw new DirectoryImportScopeChangedError();
    }
    throwIfAborted(signal);
    const chunks: Buffer[] = [];
    const readBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxFileBytes + 1));
    let offset = 0;
    while (true) {
      throwIfAborted(signal);
      const remainingWithSentinel = maxFileBytes - offset + 1;
      const { bytesRead } = await fileHandle.read(
        readBuffer,
        0,
        Math.min(readBuffer.byteLength, remainingWithSentinel),
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxFileBytes) {
        throw new DirectoryImportScopeChangedError();
      }
      chunks.push(Buffer.from(readBuffer.subarray(0, bytesRead)));
    }
    const buffer = Buffer.concat(chunks, offset);
    throwIfAborted(signal);
    const closedOver = await fileHandle.stat();
    throwIfAborted(signal);
    if (closedOver.nlink > 1) {
      throw new DirectoryImportScopeChangedError();
    }
    if (
      await openedPathBoundaryStatus(root, candidate.absolutePath, closedOver) !== "within-root"
    ) {
      throw new DirectoryImportScopeChangedError();
    }
    const rawContentHash = createHash("sha256").update(buffer).digest("hex");
    if (
      buffer.byteLength !== candidate.byteLength ||
      rawContentHash !== candidate.rawContentHash
    ) {
      throw new DirectoryImportScopeChangedError();
    }
    if (exactBytes !== undefined && !buffer.equals(exactBytes)) {
      issues.push({
        code: "read-error",
        path: candidate.relativePath,
        message: "Built-in sample bytes changed during import",
      });
      return null;
    }
    if (buffer.byteLength > maxFileBytes) {
      issues.push({
        code: "too-large",
        path: candidate.relativePath,
        message: `File grew to ${buffer.byteLength} bytes while being read; limit is ${maxFileBytes}`,
      });
      return null;
    }
    let decoded: string;
    try {
      decoded = UTF8_DECODER.decode(buffer);
    } catch {
      issues.push({
        code: "invalid-utf8",
        path: candidate.relativePath,
        message: "Only valid UTF-8 .md and .txt files are supported",
      });
      return null;
    }
    const content = normalizeText(decoded);
    const fallbackTitle = basename(candidate.relativePath, extname(candidate.relativePath));
    const birth = info.birthtimeMs > 0 ? info.birthtime : info.ctime;
    return {
      ...candidate,
      byteLength: buffer.byteLength,
      content,
      contentHash: contentHash(content),
      createdAt: validIso(birth),
      modifiedAt: validIso(info.mtime),
      rawContentHash,
      sourceUri: provenanceRootUri === undefined
        ? pathToFileURL(candidate.absolutePath).href
        : provenanceDocumentUri(provenanceRootUri, candidate.relativePath),
      title: titleFromText(content, fallbackTitle),
    };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof DirectoryImportScopeChangedError) throw error;
    issues.push({
      code: "read-error",
      path: candidate.relativePath,
      message: errorMessage(error),
    });
    return null;
  } finally {
    await fileHandle?.close();
  }
}

function normalizeRelative(root: string, child: string): string {
  return relative(root, child).split(sep).join("/").normalize("NFC");
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function directoryUri(root: string): string {
  return pathToFileURL(root.endsWith(sep) ? root : `${root}${sep}`).href;
}

function sampleProvenanceRootUri(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 2048 ||
    value.includes("\0")
  ) {
    throw new TypeError("provenanceRootUri must be a bounded sample URI");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("provenanceRootUri must be an absolute sample URI");
  }
  if (
    parsed.protocol !== "owncontext-sample:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname.length === 0 ||
    !parsed.pathname.endsWith("/") ||
    parsed.href !== value
  ) {
    throw new TypeError("provenanceRootUri must be a canonical owncontext-sample URI");
  }
  return parsed.href;
}

function provenanceDocumentUri(rootUri: string, relativePath: string): string {
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const uri = new URL(encodedPath, rootUri).href;
  if (!uri.startsWith(rootUri)) {
    throw new Error("Virtual provenance path escaped its sample root");
  }
  return uri;
}

function isSupportedTextFile(name: string): boolean {
  const extension = extname(name).toLocaleLowerCase("en-US");
  return extension === ".md" || extension === ".txt";
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function transaction<T>(db: VaultStorageConnection, operation: () => T): T {
  const name = `owncontext_savepoint_${nextSavepointId++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

let nextSavepointId = 1;

function transactionImmediate<T>(db: VaultStorageConnection, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function transactionAsync<T>(
  db: VaultStorageConnection,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    throwIfAborted(signal);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reportProgress(
  options: ImportDirectoryOptions,
  progress: ImportProgress,
): void {
  throwIfAborted(options.signal);
  options.onProgress?.(progress);
  throwIfAborted(options.signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function literalFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function addDateFilter(
  conditions: string[],
  parameters: VaultStorageValue[],
  column: string,
  operator: ">=" | "<=",
  value: string | undefined,
  name: string,
): void {
  if (value === undefined) return;
  conditions.push(`${column} ${operator} ?`);
  parameters.push(parseDate(value, name));
}

function parseDate(value: string, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a date string`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`${name} must be a valid date`);
  return date.toISOString();
}

function boundedText(value: string, name: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new RangeError(`${name} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validIso(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
}

function boundFetchedChunks(
  selectedRows: FetchRow[],
  anchorPosition: number,
  allRows: FetchRow[],
  maxChars: number,
): FetchedChunk[] {
  const anchorIndex = allRows[anchorPosition]?.chunk_index ?? 0;
  let rows = [...selectedRows];
  const payloadLength = () => rows.reduce((total, row) => total + row.content.length, 0)
    + Math.max(0, rows.length - 1) * 2;

  while (rows.length > 1 && payloadLength() > maxChars) {
    const firstDistance = Math.abs((rows[0]?.chunk_index ?? anchorIndex) - anchorIndex);
    const lastDistance = Math.abs((rows.at(-1)?.chunk_index ?? anchorIndex) - anchorIndex);
    if (lastDistance >= firstDistance) rows.pop();
    else rows.shift();
  }

  let remaining = maxChars;
  return rows.map((row, index) => {
    if (index > 0) remaining = Math.max(0, remaining - 2);
    const content = row.content.slice(0, remaining);
    remaining = Math.max(0, remaining - content.length);
    return {
      chunkId: row.chunk_id,
      index: row.chunk_index,
      headingPath: parseHeadingPath(row.heading_path),
      content,
    };
  });
}

function parseHeadingPath(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((part) => typeof part === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function isFtsSyntaxError(error: unknown): boolean {
  return error instanceof Error && /fts5|syntax error/iu.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
