export interface Vault {
  readonly path: string;
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
