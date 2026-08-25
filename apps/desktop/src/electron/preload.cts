const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api = {
  setLocale: (locale: AppLocale) =>
    ipcRenderer.invoke("app:set-locale", locale) as Promise<SetLocaleResponse>,
  getStatus: () => ipcRenderer.invoke("vault:status") as Promise<VaultStatus>,
  prepareDirectoryImport: () =>
    ipcRenderer.invoke("vault:prepare-directory-import") as Promise<PrepareDirectoryImportResponse>,
  confirmDirectoryImport: (token: string) =>
    ipcRenderer.invoke("vault:confirm-directory-import", token) as Promise<ConfirmDirectoryImportResponse>,
  cancelDirectoryImport: (token: string) =>
    ipcRenderer.invoke("vault:cancel-directory-import", token) as Promise<CancelDirectoryImportResponse>,
  importSampleLibrary: () =>
    ipcRenderer.invoke("vault:import-sample-library") as Promise<ImportResponse>,
  cancelImport: () => ipcRenderer.invoke("vault:cancel-import") as Promise<CancelImportResponse>,
  onImportProgress: (listener: (progress: ImportProgress) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: ImportProgress) => {
      listener(progress);
    };
    ipcRenderer.on("vault:import-progress", wrapped);
    return () => {
      ipcRenderer.removeListener("vault:import-progress", wrapped);
    };
  },
  search: (query: string) => ipcRenderer.invoke("vault:search", query) as Promise<SearchResponse>,
  fetch: (documentId: string, chunkId: string) =>
    ipcRenderer.invoke("vault:fetch", { documentId, chunkId }) as Promise<FetchResponse | null>,
  listRetrievalActivity: () =>
    ipcRenderer.invoke("vault:list-retrieval-activity") as Promise<RetrievalActivityResponse>,
  clearRetrievalActivity: () =>
    ipcRenderer.invoke("vault:clear-retrieval-activity") as Promise<ClearRetrievalActivityResponse>,
  listSources: () => ipcRenderer.invoke("vault:list-sources") as Promise<SourcesResponse>,
  prepareSourcePurge: (sourceId: string) =>
    ipcRenderer.invoke("vault:prepare-source-purge", sourceId) as Promise<PrepareSourcePurgeResponse>,
  purgeSource: (input: PurgeSourceInput) =>
    ipcRenderer.invoke("vault:purge-source", input) as Promise<PurgeSourceResponse>,
  listDeletionReceipts: () =>
    ipcRenderer.invoke("vault:list-deletion-receipts") as Promise<DeletionReceiptsResponse>,
  previewCodexConnection: () =>
    ipcRenderer.invoke("connection:codex-preview") as Promise<CodexConnectionPreview>,
  applyCodexConnection: () =>
    ipcRenderer.invoke("connection:codex-apply") as Promise<CodexConnectionMutation>,
  removeCodexConnection: () =>
    ipcRenderer.invoke("connection:codex-remove") as Promise<CodexConnectionMutation>,
  previewClaudeCodeConnection: () =>
    ipcRenderer.invoke("connection:claude-code-preview") as Promise<ClaudeCodeConnectionPreview>,
  applyClaudeCodeConnection: () =>
    ipcRenderer.invoke("connection:claude-code-apply") as Promise<ClaudeCodeConnectionMutation>,
  removeClaudeCodeConnection: () =>
    ipcRenderer.invoke("connection:claude-code-remove") as Promise<ClaudeCodeConnectionMutation>,
};

contextBridge.exposeInMainWorld("ownContext", api);

export type AppLocale = "en" | "ko" | "ja" | "zh-CN";

export interface SetLocaleResponse {
  locale: AppLocale;
}

export interface VaultStatus {
  ready: boolean;
  mode: "local-vault-bounded-ai";
  encryption: "not-implemented" | "application-encrypted";
}

export interface ImportResponse {
  canceled: boolean;
  aborted: boolean;
  failed?: boolean;
  sample?: true;
  suggestedQuery?: string;
  result?: unknown;
}

export interface DirectoryImportIssueView {
  code: string;
  path: string;
  message: string;
}

export interface DirectoryImportPreview {
  schemaVersion: 1;
  sourceName: string;
  collection: string;
  supportedExtensions: readonly [".md", ".txt"];
  visitedEntryCount: number;
  candidateFileCount: number;
  candidateBytes: number;
  unsupportedFileCount: number;
  oversizedFileCount: number;
  rejectedLinkCount: number;
  readErrorCount: number;
  unsupportedByExtension: ReadonlyArray<{
    extension: string;
    count: number;
  }>;
  issueExamples: readonly DirectoryImportIssueView[];
  truncatedIssueCount: number;
  canImport: boolean;
}

export type PrepareDirectoryImportResponse =
  | {
      status: "ready";
      token: string;
      folderLabel: string;
      preview: DirectoryImportPreview;
    }
  | { status: "canceled" | "aborted" | "busy" | "failed" };

export interface DirectoryImportResultView {
  scanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  issueExamples: readonly DirectoryImportIssueView[];
  truncatedIssueCount: number;
}

export type ConfirmDirectoryImportResponse =
  | {
      status: "imported";
      replayed: false;
      result: DirectoryImportResultView;
    }
  | { status: "imported"; replayed: true }
  | { status: "stale-scan" | "expired" | "invalid" | "aborted" | "busy" | "failed" };

export type CancelDirectoryImportResponse = {
  status: "aborted" | "stale-scan" | "expired" | "invalid" | "imported";
};

export interface CancelImportResponse {
  requested: boolean;
}

export interface ImportProgress {
  phase: "discovering" | "importing" | "finalizing";
  processed: number;
  total: number | null;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface SearchResult {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  sourceUri: string;
  createdAt: string;
  modifiedAt: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface FetchResponse {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  content: string;
  sourceUri: string;
  createdAt: string;
  modifiedAt: string;
}

export interface RetrievalActivityEntry {
  requestId: string;
  occurredAt: string;
  eventType: "search" | "fetch";
  clientKind: "desktop" | "codex" | "claude-code" | "legacy";
  resultCount: number;
}

export interface RetrievalActivityResponse {
  entries: RetrievalActivityEntry[];
}

export type ClearRetrievalActivityResponse =
  | { status: "cleared"; deleted: number }
  | { status: "canceled" };

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

export interface SourcesResponse {
  sources: VaultSource[];
}

export interface SourcePurgePreview {
  sourceId: string;
  name: string;
  rootUri: string;
  documentCount: number;
  lastScannedAt: string | null;
  confirmationToken: string;
}

export type PrepareSourcePurgeResponse =
  | { status: "ready"; preview: SourcePurgePreview }
  | { status: "not-found" }
  | { status: "import-in-progress" };

export interface PurgeSourceInput {
  sourceId: string;
  confirmationToken: string;
  expectedDocumentCount: number;
  expectedLastScannedAt: string | null;
}

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

export interface DeletionReceiptView extends DeletionReceipt {
  verificationStatus:
    | "verified"
    | "target-reintroduced"
    | "integrity-error"
    | "not-found";
}

export type PurgeSourceResponse =
  | { status: "purged"; receipt: DeletionReceipt }
  | { status: "not-found" }
  | { status: "import-in-progress" }
  | { status: "stale-confirmation" }
  | { status: "canceled" };

export interface DeletionReceiptsResponse {
  receipts: DeletionReceiptView[];
}

export interface CodexConnectionPreview {
  status:
    | "absent"
    | "managed"
    | "managed_stale"
    | "unmanaged_conflict"
    | "malformed_managed_block"
    | "config_too_large"
    | "invalid_encoding"
    | "read_failed";
  canApply: boolean;
  canRemove: boolean;
  configExists: boolean;
  snippet: string;
  allowedCollection: string;
  serverReady: boolean;
}

export interface CodexConnectionMutation {
  ok: boolean;
  code: string;
  changed: boolean;
  backupCreated: boolean;
  backupFileName?: string;
}

export interface ClaudeCodeConnectionPreview {
  status:
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
  canApply: boolean;
  canRemove: boolean;
  cliAvailable: boolean;
  configExists: boolean;
  snippet: string;
  allowedCollection: string;
  serverReady: boolean;
}

export interface ClaudeCodeConnectionMutation {
  ok: boolean;
  code: string;
  changed: boolean;
  backupCreated: boolean;
  backupFileName?: string;
  restored?: boolean;
}

export type OwnContextApi = typeof api;
