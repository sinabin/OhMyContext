import { randomBytes } from "node:crypto";
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
  FetchDocumentInput,
  FetchedChunk,
  ImportDirectoryOptions,
  ImportDirectoryResult,
  ImportProgress,
  ImportIssue,
  ImportedDocument,
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
const DEFAULT_CHUNK_SIZE = 1_400;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_SCOPED_RANK_TERMS = 16;
const DEFAULT_NEIGHBORS = 1;
const MAX_NEIGHBORS = 5;
const DEFAULT_FETCH_CHARS = 12_000;
const MAX_FETCH_CHARS = 50_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
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

interface PreparedFile extends CandidateFile {
  content: string;
  contentHash: string;
  createdAt: string;
  modifiedAt: string;
  sourceUri: string;
  title: string;
}

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

interface DiscoveredFiles {
  files: CandidateFile[];
  visited: number;
}

const states = new WeakMap<Vault, VaultState>();

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
  const db = state.db;
  throwIfAborted(options.signal);
  const collection = boundedText(options.collection ?? DEFAULT_COLLECTION, "collection", 128);
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
    1_000_000,
  );
  const chunkSize = boundedInteger(
    options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    "chunkSize",
    64,
    100_000,
  );
  const root = await safeRoot(directoryPath);
  const rootUri = internal.provenanceRootUri === undefined
    ? directoryUri(root)
    : sampleProvenanceRootUri(internal.provenanceRootUri);
  const sourceName = boundedText(
    options.sourceName ?? (basename(root) || root),
    "sourceName",
    512,
  );
  const sourceId = deterministicId("source", "folder", rootUri, collection);
  if (state.importingSources.size > 0) {
    throw new Error("Another import is already running for this vault");
  }
  state.importingSources.add(sourceId);

  try {
    return await transactionAsync(db, async () => {
      const issues: ImportIssue[] = [];
      const startedAt = new Date().toISOString();
      const documents: ImportedDocument[] = [];
      let imported = 0;
      let updated = 0;
      let unchanged = 0;

      const progress = (
        phase: ImportProgress["phase"],
        processed: number,
        total: number | null,
      ): void => {
        reportProgress(options, {
          phase,
          processed,
          total,
          imported,
          updated,
          unchanged,
          skipped: issues.length,
        });
      };

      // Incompleteness is visible to reads on this connection. Other database
      // connections continue seeing the last committed snapshot until COMMIT.
      db.prepare(`
        INSERT INTO sources(
          id, kind, root_uri, collection, display_name, created_at, last_scanned_at
        ) VALUES (?, 'folder', ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          last_scanned_at = NULL
      `).run(sourceId, rootUri, collection, sourceName, startedAt);

      progress("discovering", 0, null);
      const discovery = await discoverFiles(
        root,
        maxFiles,
        issues,
        options.signal,
        (processed) => progress("discovering", processed, null),
      );
      const candidates = discovery.files;
      if (internal.exactFiles) {
        const actualNames = candidates.map((candidate) => candidate.relativePath);
        const expectedNames = [...internal.exactFiles.keys()].sort(compareNames);
        if (
          actualNames.length !== expectedNames.length ||
          actualNames.some((name, index) => name !== expectedNames[index])
        ) {
          throw new Error("Built-in sample import inventory changed during verification.");
        }
      }
      progress("discovering", discovery.visited, discovery.visited);
      const seenRelativePaths = new Set<string>();
      let processed = 0;
      progress("importing", processed, candidates.length);
      for (const candidate of candidates) {
        throwIfAborted(options.signal);
        if (seenRelativePaths.has(candidate.relativePath)) {
          issues.push({
            code: "read-error",
            path: candidate.relativePath,
            message: "Another file has the same normalized relative path",
          });
          processed += 1;
          progress("importing", processed, candidates.length);
          continue;
        }
        seenRelativePaths.add(candidate.relativePath);
        const file = await prepareFile(
          root,
          candidate,
          maxFileBytes,
          issues,
          options.signal,
          internal.provenanceRootUri === undefined ? undefined : rootUri,
          internal.exactFiles?.get(candidate.relativePath),
        );
        if (!file) {
          if (internal.exactFiles) {
            throw new Error("Built-in sample bytes changed during import.");
          }
          processed += 1;
          progress("importing", processed, candidates.length);
          continue;
        }

        const importedDocument = importPreparedFile(
          db,
          sourceId,
          file,
          chunkSize,
          startedAt,
        );
        documents.push(importedDocument);
        if (importedDocument.status === "created") imported += 1;
        else if (importedDocument.status === "updated") updated += 1;
        else unchanged += 1;
        processed += 1;
        progress("importing", processed, candidates.length);
      }

      if (internal.exactFiles) {
        const expectedNames = [...internal.exactFiles.keys()];
        const placeholders = expectedNames.map(() => "?").join(", ");
        db.prepare(`
          DELETE FROM documents
          WHERE source_id = ?
            AND relative_path NOT IN (${placeholders})
        `).run(sourceId, ...expectedNames);
      }

      progress("finalizing", processed, candidates.length);
      throwIfAborted(options.signal);
      db.prepare("UPDATE sources SET last_scanned_at = ? WHERE id = ?")
        .run(new Date().toISOString(), sourceId);
      throwIfAborted(options.signal);

      return {
        sourceId,
        rootUri,
        collection,
        scanned: candidates.length,
        imported,
        updated,
        unchanged,
        skipped: issues.length,
        documents,
        issues,
      };
    }, options.signal);
  } finally {
    state.importingSources.delete(sourceId);
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

async function safeRoot(directoryPath: string): Promise<string> {
  if (typeof directoryPath !== "string" || directoryPath.trim().length === 0) {
    throw new TypeError("directoryPath must be a non-empty path");
  }
  const requested = resolve(directoryPath);
  const linkInfo = await lstat(requested);
  if (linkInfo.isSymbolicLink()) {
    throw new Error("The import root must not be a symbolic link");
  }
  if (!linkInfo.isDirectory()) {
    throw new Error("The import root must be a directory");
  }
  return realpath(requested);
}

async function discoverFiles(
  root: string,
  maxFiles: number,
  issues: ImportIssue[],
  signal: AbortSignal | undefined,
  onVisited: (processed: number) => void,
): Promise<DiscoveredFiles> {
  const directories = [root];
  const files: CandidateFile[] = [];
  let visited = 0;
  while (directories.length > 0) {
    throwIfAborted(signal);
    const directory = directories.pop();
    if (!directory) continue;
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => compareNames(left.name, right.name));

    for (const entry of entries) {
      throwIfAborted(signal);
      visited += 1;
      onVisited(visited);
      throwIfAborted(signal);
      const absolutePath = resolve(directory, entry.name);
      const displayPath = normalizeRelative(root, absolutePath);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        issues.push({ code: "read-error", path: displayPath, message: errorMessage(error) });
        continue;
      }
      if (info.isSymbolicLink()) {
        issues.push({
          code: "symlink",
          path: displayPath,
          message: "Symbolic links and junctions are not followed",
        });
        continue;
      }

      let actualPath: string;
      try {
        actualPath = await realpath(absolutePath);
      } catch (error) {
        issues.push({ code: "read-error", path: displayPath, message: errorMessage(error) });
        continue;
      }
      if (!isWithin(root, actualPath)) {
        issues.push({
          code: "outside-root",
          path: displayPath,
          message: "Resolved path is outside the selected import root",
        });
        continue;
      }

      if (info.isDirectory()) {
        directories.push(actualPath);
        continue;
      }
      if (!info.isFile() || !isSupportedTextFile(entry.name)) continue;
      if (files.length >= maxFiles) {
        throw new RangeError(`Import exceeds the maxFiles limit of ${maxFiles}`);
      }
      files.push({
        absolutePath: actualPath,
        relativePath: normalizeRelative(root, actualPath),
      });
    }
  }
  files.sort((left, right) => compareNames(left.relativePath, right.relativePath));
  return { files, visited };
}

async function prepareFile(
  root: string,
  candidate: CandidateFile,
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
    if (info.size > maxFileBytes) {
      issues.push({
        code: "too-large",
        path: candidate.relativePath,
        message: `File is ${info.size} bytes; limit is ${maxFileBytes}`,
      });
      return null;
    }
    if (!isWithin(root, await realpath(candidate.absolutePath))) {
      issues.push({
        code: "outside-root",
        path: candidate.relativePath,
        message: "File moved outside the import root while it was being read",
      });
      return null;
    }
    throwIfAborted(signal);
    const buffer = await fileHandle.readFile();
    throwIfAborted(signal);
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
      content,
      contentHash: contentHash(content),
      createdAt: validIso(birth),
      modifiedAt: validIso(info.mtime),
      sourceUri: provenanceRootUri === undefined
        ? pathToFileURL(candidate.absolutePath).href
        : provenanceDocumentUri(provenanceRootUri, candidate.relativePath),
      title: titleFromText(content, fallbackTitle),
    };
  } catch (error) {
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
