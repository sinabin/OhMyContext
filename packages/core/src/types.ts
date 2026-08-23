import type { VaultStorageDescriptor } from "./storage.js";

export interface Vault {
  readonly path: string;
  readonly storage: VaultStorageDescriptor;
  close(): void;
}

export interface ImportDirectoryOptions {
  /** A user-facing access boundary. Defaults to `default`. */
  collection?: string;
  /** A user-facing source label. Defaults to the directory name. */
  sourceName?: string;
  /** Maximum accepted bytes for one file. Defaults to 10 MiB. */
  maxFileBytes?: number;
  /** Maximum number of supported files inspected in one import. */
  maxFiles?: number;
  /** Approximate maximum characters in a chunk. Defaults to 1,400. */
  chunkSize?: number;
  /** Cancels discovery or import. Cancellation rolls back the complete import. */
  signal?: AbortSignal;
  /** Receives content-free progress metadata. */
  onProgress?: (progress: ImportProgress) => void;
}

export type ImportPhase = "discovering" | "importing" | "finalizing";

export interface ImportProgress {
  phase: ImportPhase;
  processed: number;
  /** Unknown during recursive discovery. */
  total: number | null;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export type ImportIssueCode =
  | "invalid-utf8"
  | "outside-root"
  | "read-error"
  | "symlink"
  | "too-large";

export interface ImportIssue {
  code: ImportIssueCode;
  path: string;
  message: string;
}

export interface ImportedDocument {
  documentId: string;
  revisionId: string;
  sourceUri: string;
  relativePath: string;
  status: "created" | "updated" | "unchanged";
}

export interface ImportDirectoryResult {
  sourceId: string;
  rootUri: string;
  collection: string;
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  documents: ImportedDocument[];
  issues: ImportIssue[];
}

export interface SearchVaultInput {
  query: string;
  collection?: string;
  createdFrom?: string;
  createdTo?: string;
  modifiedFrom?: string;
  modifiedTo?: string;
  limit?: number;
}

export interface VaultResult {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  sourceUri: string;
  createdAt: string;
  modifiedAt: string;
}

export interface VaultSearchResult extends VaultResult {
  score: number;
}

export interface FetchDocumentInput {
  documentId: string;
  chunkId?: string;
  before?: number;
  after?: number;
  maxChars?: number;
}

export interface FetchedChunk {
  chunkId: string;
  index: number;
  headingPath: string[];
  content: string;
}

export interface VaultFetchResult extends VaultResult {
  content: string;
  chunks: FetchedChunk[];
}

export interface VaultSource {
  sourceId: string;
  name: string;
  rootUri: string;
  collection: string;
  createdAt: string;
  lastScannedAt: string | null;
  status: "ready" | "incomplete";
  documentCount: number;
}

/**
 * A point-in-time source snapshot shown before a destructive local-vault action.
 * The token covers the current source lineage and is intentionally opaque to UI
 * callers. Purge must fail if any of these values are stale.
 */
export interface SourcePurgePreview {
  sourceId: string;
  name: string;
  rootUri: string;
  documentCount: number;
  lastScannedAt: string | null;
  confirmationToken: string;
}

export type PrepareSourcePurgeResult =
  | { status: "ready"; preview: SourcePurgePreview }
  | { status: "not-found" }
  | { status: "import-in-progress" };

export interface PurgeSourceInput {
  sourceId: string;
  confirmationToken: string;
  expectedDocumentCount: number;
  expectedLastScannedAt: string | null;
}

/**
 * Content-free evidence of a completed OwnContext lineage purge. It proves
 * logical non-addressability inside the vault, not secure media erasure.
 */
export interface DeletionReceipt {
  receiptId: string;
  targetKind: "source";
  targetId: string;
  completedAt: string;
  sourceCount: number;
  documentCount: number;
  revisionCount: number;
  chunkCount: number;
  ftsEntryCount: number;
  retrievalEventCount: number;
  assurance: "logical-non-addressability";
  originalFilesModified: false;
  secureEraseClaimed: false;
}

export type PurgeSourceResult =
  | { status: "purged"; receipt: DeletionReceipt }
  | { status: "not-found" }
  | { status: "import-in-progress" }
  | { status: "stale-confirmation" };

export type DeletionReceiptVerification =
  | { status: "verified"; receipt: DeletionReceipt }
  | { status: "target-reintroduced"; receipt: DeletionReceipt }
  | { status: "integrity-error"; receipt: DeletionReceipt }
  | { status: "not-found" };
