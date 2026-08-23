const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api = {
  getStatus: () => ipcRenderer.invoke("vault:status") as Promise<VaultStatus>,
  importDirectory: () => ipcRenderer.invoke("vault:import-directory") as Promise<ImportResponse>,
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
};

contextBridge.exposeInMainWorld("ownContext", api);

export interface VaultStatus {
  ready: boolean;
  mode: string;
  encryption: "not-implemented";
}

export interface ImportResponse {
  canceled: boolean;
  aborted: boolean;
  selectedPath?: string;
  result?: unknown;
}

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
    | "unmanaged_conflict"
    | "malformed_managed_block"
    | "config_too_large"
    | "invalid_encoding"
    | "read_failed";
  canApply: boolean;
  canRemove: boolean;
  configExists: boolean;
  snippet: string;
  serverReady: boolean;
}

export interface CodexConnectionMutation {
  ok: boolean;
  code: string;
  changed: boolean;
  backupCreated: boolean;
  backupFileName?: string;
  snippet?: string;
}

export type OwnContextApi = typeof api;
