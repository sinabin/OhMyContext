import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  ClaudeCodeConnectionMutation,
  ClaudeCodeConnectionPreview,
  CodexConnectionMutation,
  CodexConnectionPreview,
  DirectoryImportResultView,
  DeletionReceiptView,
  FetchResponse,
  ImportProgress,
  PrepareDirectoryImportResponse,
  RetrievalActivityEntry,
  SourcePurgePreview,
  VaultSource,
} from "../electron/preload.cjs";
import { deriveLibraryOnboarding } from "./onboarding.js";

interface Result {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  sourceUri: string;
  createdAt: string;
  modifiedAt: string;
}

type View = "library" | "connections" | "history";
type Activity = "preflight" | "import" | "search" | "purge";

interface ImportCountSummary {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function summarizeImport(record: ImportCountSummary): string {
  const parts = [
    `${record.imported} imported`,
    `${record.updated} updated`,
    `${record.unchanged} unchanged`,
    `${record.skipped} skipped`,
  ];

  return parts.join(" · ");
}

function summarizeSampleImport(value: unknown): string {
  if (!value || typeof value !== "object") return "Sample import completed.";
  const record = value as Record<string, unknown>;
  if (
    typeof record.imported !== "number" ||
    typeof record.updated !== "number" ||
    typeof record.unchanged !== "number" ||
    typeof record.skipped !== "number"
  ) {
    return "Sample import completed.";
  }
  return summarizeImport({
    imported: record.imported,
    updated: record.updated,
    unchanged: record.unchanged,
    skipped: record.skipped,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 * 1_024 * 1_024) {
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GiB`;
}

function codexConnectionStatus(preview: CodexConnectionPreview | undefined): string {
  if (!preview) return "Checking local configuration…";
  if (!preview.serverReady) return "Local MCP build is unavailable";

  switch (preview.status) {
    case "managed":
      return "Configuration saved by OhMyContext";
    case "managed_stale":
      return "OhMyContext update required for this Codex connection";
    case "absent":
      return "Ready to connect";
    case "unmanaged_conflict":
      return "Existing OhMyContext entry needs manual review";
    case "malformed_managed_block":
      return "Managed block was edited or is incomplete";
    case "config_too_large":
      return "Codex configuration exceeds the safe edit limit";
    case "invalid_encoding":
      return "Codex configuration is not valid UTF-8";
    case "read_failed":
      return "Codex configuration could not be read safely";
  }
}

function codexMutationNotice(result: CodexConnectionMutation): string {
  if (result.ok) {
    if (result.code === "unchanged") return "No configuration change was needed.";
    const backup = result.backupFileName
      ? ` Backup created: ${result.backupFileName}.`
      : "";
    return result.code === "removed"
      ? `OhMyContext was disconnected.${backup}`
      : `Codex connection saved.${backup} Restart Codex to load it.`;
  }

  const messages: Record<string, string> = {
    server_unavailable: "Build the local MCP server before connecting Codex.",
    unmanaged_conflict: "OhMyContext found an unmanaged entry and refused to overwrite it.",
    malformed_managed_block: "The managed block is malformed. Restore its backup or review it manually.",
    config_too_large: "The configuration is larger than OhMyContext's safe edit limit.",
    invalid_encoding: "The configuration must be valid UTF-8 before OhMyContext can edit it.",
    read_failed: "The configuration could not be read safely.",
    backup_failed: "No change was made because a backup could not be created.",
    busy: "Another Claude Code configuration change is already in progress.",
    write_failed: "The configuration could not be replaced safely.",
    concurrent_change: "The Codex file changed during editing, so OhMyContext left it untouched.",
    invalid_path: "The generated local launch paths did not pass validation.",
  };
  return messages[result.code] ?? "The connection was not changed.";
}

function claudeCodeConnectionStatus(
  preview: ClaudeCodeConnectionPreview | undefined,
): string {
  if (!preview) return "Checking local configuration…";

  switch (preview.status) {
    case "managed":
      return preview.serverReady
        ? "User-scope configuration saved by OhMyContext"
        : "Saved configuration points to an unavailable local MCP build";
    case "managed_stale":
      return "OhMyContext update required for this Claude Code connection";
    case "absent":
      if (!preview.serverReady) return "Local MCP build is unavailable";
      return preview.cliAvailable
        ? "Ready to register with Claude Code"
        : "Claude Code CLI was not found";
    case "unmanaged_conflict":
      return "Existing OhMyContext entry needs manual review";
    case "config_too_large":
      return "Claude configuration exceeds the safe edit limit";
    case "invalid_encoding":
      return "Claude configuration is not valid UTF-8";
    case "invalid_json":
      return "Claude configuration contains invalid JSON";
    case "invalid_structure":
      return "Claude configuration has an unsupported structure";
    case "read_failed":
      return "Claude configuration could not be read safely";
    case "invalid_config_target":
      return "CLAUDE_CONFIG_DIR is not a safe absolute directory";
    case "invalid_launch":
      return "Generated local launch details are invalid";
  }
}

function claudeCodeMutationNotice(result: ClaudeCodeConnectionMutation): string {
  const backup = result.backupFileName
    ? ` Backup created: ${result.backupFileName}.`
    : "";
  if (result.ok) {
    if (result.code === "unchanged") return "No Claude Code configuration change was needed.";
    return result.code === "removed"
      ? `OhMyContext was removed from Claude Code.${backup}`
      : `Claude Code registration saved.${backup} Restart active Claude Code sessions to load it.`;
  }

  if (result.code === "update_removed_retry_required") {
    return `The outdated connection was removed safely, but the new registration failed.${backup} Retry Connect Claude Code.`;
  }

  if (result.restored) {
    return `Claude Code did not keep the requested change, so OhMyContext restored the prior configuration.${backup}`;
  }

  if (result.changed) {
    return `Claude Code changed its configuration but verification failed.${backup} Review or restore the backup before relying on this connection.`;
  }

  const messages: Record<string, string> = {
    server_unavailable: "Build the local MCP server before connecting Claude Code.",
    cli_unavailable: "Install Claude Code and make its CLI available before connecting.",
    unmanaged_conflict: "OhMyContext found an unmanaged entry and refused to overwrite it.",
    config_too_large: "The Claude configuration is larger than OhMyContext's safe edit limit.",
    invalid_encoding: "The Claude configuration must be valid UTF-8.",
    invalid_json: "Repair the Claude JSON configuration before OhMyContext can edit it.",
    invalid_structure: "The Claude configuration structure is ambiguous, so OhMyContext left it unchanged.",
    read_failed: "The Claude configuration could not be read safely.",
    invalid_config_target: "Use an absolute CLAUDE_CONFIG_DIR, then restart OhMyContext.",
    backup_failed: "No change was made because a backup could not be created.",
    concurrent_change: "The Claude configuration changed during setup, so OhMyContext stopped.",
    cli_failed: "The Claude Code CLI rejected the registration command.",
    cli_timeout: "The Claude Code CLI did not finish within the safe time limit.",
    cli_output_limit: "The Claude Code CLI exceeded the safe output limit.",
    verification_failed: "Claude Code did not save the exact scoped connection.",
    recovery_required: "Claude Code changed its configuration unexpectedly. Review the backup before retrying.",
    write_failed: "OhMyContext could not replace the Claude configuration safely.",
    invalid_launch: "The generated local launch paths did not pass validation.",
  };
  return messages[result.code] ?? "The Claude Code connection was not changed.";
}

function progressText(progress: ImportProgress | undefined): string {
  if (!progress) return "Preparing import…";
  if (progress.phase === "discovering") return "Discovering supported files…";
  if (progress.phase === "finalizing") return "Finalizing the atomic vault update…";
  const total = progress.total === null ? "?" : String(progress.total);
  return `Importing ${progress.processed} of ${total} · ${progress.imported} new · ${progress.updated} updated`;
}

function receiptStatus(receipt: DeletionReceiptView): string {
  switch (receipt.verificationStatus) {
    case "verified":
      return "Receipt recorded · source remains absent";
    case "target-reintroduced":
      return "Source was added again";
    case "integrity-error":
      return "Vault integrity needs attention";
    case "not-found":
      return "Receipt could not be re-verified";
  }
}

export function App() {
  const [view, setView] = useState<View>("library");
  const [status, setStatus] = useState("Starting local vault…");
  const [encryption, setEncryption] = useState<"not-implemented" | "application-encrypted">("not-implemented");
  const [notice, setNotice] = useState("No source imported in this session.");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [sources, setSources] = useState<VaultSource[]>([]);
  const [receipts, setReceipts] = useState<DeletionReceiptView[]>([]);
  const [retrievalActivity, setRetrievalActivity] = useState<RetrievalActivityEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyNotice, setHistoryNotice] = useState(
    "This local history records request metadata only, never queries or document content.",
  );
  const [activity, setActivity] = useState<Activity>();
  const [progress, setProgress] = useState<ImportProgress>();
  const [directoryImportPreflight, setDirectoryImportPreflight] = useState<
    Extract<PrepareDirectoryImportResponse, { status: "ready" }>
  >();
  const [directoryDialogBusy, setDirectoryDialogBusy] = useState(false);
  const directoryFlowLock = useRef(false);
  const [importReport, setImportReport] = useState<DirectoryImportResultView>();
  const [selected, setSelected] = useState<FetchResponse>();
  const [purgePreview, setPurgePreview] = useState<SourcePurgePreview>();
  const [error, setError] = useState<string>();
  const [codexConnection, setCodexConnection] = useState<CodexConnectionPreview>();
  const [codexConnectionBusy, setCodexConnectionBusy] = useState(false);
  const [codexConnectionNotice, setCodexConnectionNotice] = useState(
    "OhMyContext never returns the rest of your Codex configuration to this screen.",
  );
  const [claudeCodeConnection, setClaudeCodeConnection] =
    useState<ClaudeCodeConnectionPreview>();
  const [claudeCodeConnectionBusy, setClaudeCodeConnectionBusy] = useState(false);
  const [claudeCodeConnectionNotice, setClaudeCodeConnectionNotice] = useState(
    "OhMyContext shows only the proposed OhMyContext entry, never the rest of your Claude configuration.",
  );

  async function refreshSources() {
    const response = await window.ownContext.listSources();
    setSources(response.sources);
  }

  async function refreshReceipts() {
    const response = await window.ownContext.listDeletionReceipts();
    setReceipts(response.receipts);
  }

  async function refreshRetrievalActivity() {
    const response = await window.ownContext.listRetrievalActivity();
    setRetrievalActivity(response.entries);
  }

  async function refreshRetrievalActivityAfterRequest() {
    try {
      await refreshRetrievalActivity();
    } catch {
      setHistoryNotice("A request completed, but the local history could not be refreshed yet.");
    }
  }

  async function refreshCodexConnection() {
    const response = await window.ownContext.previewCodexConnection();
    setCodexConnection(response);
  }

  async function refreshClaudeCodeConnection() {
    const response = await window.ownContext.previewClaudeCodeConnection();
    setClaudeCodeConnection(response);
  }

  useEffect(() => {
    const stopListening = window.ownContext.onImportProgress(setProgress);
    void Promise.all([
      window.ownContext.getStatus().then((value) => {
        setStatus(value.mode);
        setEncryption(value.encryption);
      }),
      refreshSources(),
      refreshReceipts(),
      refreshRetrievalActivity(),
      refreshCodexConnection(),
      refreshClaudeCodeConnection(),
    ]).catch((reason: unknown) => setError(String(reason)));
    return stopListening;
  }, []);

  useEffect(() => {
    if (view === "connections") {
      void Promise.all([
        refreshCodexConnection(),
        // Preview only. Merely opening the screen must not execute a PATH command.
        refreshClaudeCodeConnection(),
      ]).catch((reason: unknown) => setError(String(reason)));
    } else if (view === "history") {
      void refreshRetrievalActivity().catch((reason: unknown) => setError(String(reason)));
    }
  }, [view]);

  async function runDirectoryPreflight() {
    setDirectoryImportPreflight(undefined);
    setActivity("preflight");
    setProgress(undefined);
    setError(undefined);

    try {
      const response = await window.ownContext.prepareDirectoryImport();
      switch (response.status) {
        case "ready":
          setDirectoryImportPreflight(response);
          setNotice("Folder scan complete. Review the scope before importing.");
          break;
        case "canceled":
          setNotice("Folder selection canceled. Nothing was imported.");
          break;
        case "aborted":
          setNotice("Folder scan canceled. Nothing was imported.");
          break;
        case "busy":
          setNotice("Wait for the current import or scan to finish.");
          break;
        case "failed":
          setError("OhMyContext could not inspect that folder safely. Check access and try again.");
          break;
      }
    } catch {
      setError("OhMyContext could not start the folder scan safely. Try again.");
    } finally {
      setActivity(undefined);
      setProgress(undefined);
    }
  }

  async function handleImport() {
    if (directoryFlowLock.current) return;
    directoryFlowLock.current = true;
    try {
      await runDirectoryPreflight();
    } finally {
      directoryFlowLock.current = false;
    }
  }

  async function confirmDirectoryImport() {
    const preflight = directoryImportPreflight;
    if (!preflight || directoryFlowLock.current) return;
    directoryFlowLock.current = true;
    setDirectoryDialogBusy(true);
    setActivity("import");
    setProgress(undefined);
    setError(undefined);
    try {
      const response = await window.ownContext.confirmDirectoryImport(
        preflight.token,
      );
      switch (response.status) {
        case "imported":
          setDirectoryImportPreflight(undefined);
          if (response.replayed) {
            setNotice("That preview was already used. Scan the folder again to refresh it.");
          } else {
            setImportReport(response.result);
            setNotice(summarizeImport(response.result));
            setHasSearched(false);
            setResults([]);
            await Promise.all([refreshSources(), refreshReceipts()]);
          }
          break;
        case "stale-scan":
          setDirectoryImportPreflight(undefined);
          setNotice("The folder changed after the preview. Scan it again before importing.");
          break;
        case "expired":
          setDirectoryImportPreflight(undefined);
          setNotice("The five-minute preview expired. Scan the folder again.");
          break;
        case "invalid":
          setDirectoryImportPreflight(undefined);
          setNotice("That import preview is no longer valid. Scan the folder again.");
          break;
        case "aborted":
          setDirectoryImportPreflight(undefined);
          setNotice("Import canceled. The previous complete vault state was preserved.");
          break;
        case "busy":
          setNotice("Wait for the current import or scan to finish.");
          break;
        case "failed":
          setDirectoryImportPreflight(undefined);
          setError("OhMyContext could not complete that import safely. Scan the folder again.");
          break;
      }
    } catch {
      setDirectoryImportPreflight(undefined);
      setError("OhMyContext could not complete that import safely. Scan the folder again.");
    } finally {
      setActivity(undefined);
      setProgress(undefined);
      setDirectoryDialogBusy(false);
      directoryFlowLock.current = false;
    }
  }

  async function cancelDirectoryImport() {
    const preflight = directoryImportPreflight;
    if (!preflight || directoryFlowLock.current) return;
    directoryFlowLock.current = true;
    setDirectoryDialogBusy(true);
    setDirectoryImportPreflight(undefined);
    setError(undefined);
    try {
      const response = await window.ownContext.cancelDirectoryImport(
        preflight.token,
      );
      setNotice(response.status === "imported"
        ? "That preview was already used. No additional import was started."
        : "Import preview canceled. Nothing was imported.");
    } catch {
      setError("OhMyContext could not close that preview cleanly. No import was started.");
    } finally {
      setDirectoryDialogBusy(false);
      directoryFlowLock.current = false;
    }
  }

  async function chooseAnotherDirectory() {
    const preflight = directoryImportPreflight;
    if (!preflight || directoryFlowLock.current) return;
    directoryFlowLock.current = true;
    setDirectoryDialogBusy(true);
    setDirectoryImportPreflight(undefined);
    setError(undefined);
    try {
      await window.ownContext.cancelDirectoryImport(preflight.token);
      await runDirectoryPreflight();
    } catch {
      setError("OhMyContext could not switch folders safely. Try again.");
    } finally {
      setDirectoryDialogBusy(false);
      directoryFlowLock.current = false;
    }
  }

  async function handleImportSample() {
    if (directoryFlowLock.current) return;
    directoryFlowLock.current = true;
    setDirectoryImportPreflight(undefined);
    setImportReport(undefined);
    setActivity("import");
    setProgress(undefined);
    setError(undefined);

    try {
      const response = await window.ownContext.importSampleLibrary();
      if (response.failed) {
        setError("OhMyContext could not import the sample safely. Try again.");
      } else if (response.aborted) {
        setNotice("Sample import canceled. The previous complete vault state was preserved.");
      } else if (!response.canceled) {
        setNotice(`${summarizeSampleImport(response.result)} Try the suggested search.`);
        setQuery(response.suggestedQuery ?? "weekly review");
        setHasSearched(false);
        setResults([]);
        await Promise.all([refreshSources(), refreshReceipts()]);
      }
    } catch {
      setError("OhMyContext could not import the sample safely. Try again.");
    } finally {
      setActivity(undefined);
      setProgress(undefined);
      directoryFlowLock.current = false;
    }
  }

  async function handleCancelImport() {
    await window.ownContext.cancelImport();
    setNotice(activity === "preflight"
      ? "Cancel requested. Stopping the folder scan…"
      : "Cancel requested. Rolling back the current import…");
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    setActivity("search");
    setError(undefined);
    setSelected(undefined);

    try {
      const response = await window.ownContext.search(query.trim());
      setResults(response.results as Result[]);
      setHasSearched(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      await refreshRetrievalActivityAfterRequest();
      setActivity(undefined);
    }
  }

  async function handleFetch(result: Result) {
    setError(undefined);
    try {
      const response = await window.ownContext.fetch(result.documentId, result.chunkId);
      setSelected(response ?? undefined);
    } catch (reason) {
      setError(String(reason));
    } finally {
      await refreshRetrievalActivityAfterRequest();
    }
  }

  async function beginSourcePurge(source: VaultSource) {
    setError(undefined);
    try {
      const response = await window.ownContext.prepareSourcePurge(source.sourceId);
      if (response.status === "ready") {
        setPurgePreview(response.preview);
      } else if (response.status === "import-in-progress") {
        setNotice("Wait for the current import to finish before removing a source.");
      } else {
        setNotice("That source is no longer present. No deletion receipt was created.");
        await refreshSources();
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function confirmSourcePurge() {
    if (!purgePreview) return;
    setActivity("purge");
    setError(undefined);
    try {
      const response = await window.ownContext.purgeSource({
        sourceId: purgePreview.sourceId,
        confirmationToken: purgePreview.confirmationToken,
        expectedDocumentCount: purgePreview.documentCount,
        expectedLastScannedAt: purgePreview.lastScannedAt,
      });
      if (response.status === "purged") {
        setResults([]);
        setHasSearched(false);
        setSelected(undefined);
        setPurgePreview(undefined);
        setNotice(
          `Source removed from OhMyContext · receipt ${response.receipt.receiptId.slice(0, 12)}…`,
        );
        await Promise.all([refreshSources(), refreshReceipts(), refreshRetrievalActivity()]);
      } else if (response.status === "canceled") {
        setPurgePreview(undefined);
        setNotice("Removal canceled. The source remains in OhMyContext.");
      } else if (response.status === "stale-confirmation") {
        setPurgePreview(undefined);
        setNotice("The source changed after confirmation. Review its current contents and try again.");
        await refreshSources();
      } else if (response.status === "import-in-progress") {
        setPurgePreview(undefined);
        setNotice("Removal was blocked because an import is in progress. No data was deleted.");
      } else {
        setPurgePreview(undefined);
        setNotice("The source was already absent. No deletion receipt was created.");
        await refreshSources();
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setActivity(undefined);
    }
  }

  async function mutateCodexConnection(operation: "apply" | "remove") {
    setCodexConnectionBusy(true);
    setError(undefined);
    try {
      const result = operation === "apply"
        ? await window.ownContext.applyCodexConnection()
        : await window.ownContext.removeCodexConnection();
      setCodexConnectionNotice(codexMutationNotice(result));
      await refreshCodexConnection();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCodexConnectionBusy(false);
    }
  }

  async function mutateClaudeCodeConnection(operation: "apply" | "remove") {
    setClaudeCodeConnectionBusy(true);
    setError(undefined);
    try {
      const result = operation === "apply"
        ? await window.ownContext.applyClaudeCodeConnection()
        : await window.ownContext.removeClaudeCodeConnection();
      setClaudeCodeConnectionNotice(claudeCodeMutationNotice(result));
      await refreshClaudeCodeConnection();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setClaudeCodeConnectionBusy(false);
    }
  }

  async function clearHistory() {
    setHistoryBusy(true);
    setError(undefined);
    try {
      const response = await window.ownContext.clearRetrievalActivity();
      if (response.status === "cleared") {
        await refreshRetrievalActivity();
        setHistoryNotice(
          `${response.deleted} local request entr${response.deleted === 1 ? "y" : "ies"} cleared. External copies, if any, were not changed.`,
        );
      } else {
        setHistoryNotice("Clear canceled. Local access history was not changed.");
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setHistoryBusy(false);
    }
  }

  async function refreshHistoryManually() {
    setHistoryBusy(true);
    setError(undefined);
    try {
      await refreshRetrievalActivity();
      setHistoryNotice("Local access history refreshed. External requests do not appear live.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setHistoryBusy(false);
    }
  }

  const isFolderWork = activity === "preflight" || activity === "import";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">OC</span>
          <div>
            <strong>OhMyContext</strong>
            <small>Your evidence, your control</small>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <button
            className={`nav-item ${view === "library" ? "active" : ""}`}
            type="button"
            onClick={() => setView("library")}
          >
            Library
          </button>
          <button
            className={`nav-item ${view === "connections" ? "active" : ""}`}
            type="button"
            onClick={() => setView("connections")}
          >
            AI connections
          </button>
          <button
            className={`nav-item ${view === "history" ? "active" : ""}`}
            type="button"
            onClick={() => setView("history")}
          >
            Access history
          </button>
        </nav>

        <div className="trust-note">
          <span className="status-dot" />
          <div>
            <strong>{encryption === "application-encrypted" ? "Encrypted local vault" : "Developer alpha"}</strong>
            <p>
              {encryption === "application-encrypted"
                ? "Application-level vault encryption is active for this packaged Windows build. Cloud AI transfer remains a separate boundary."
                : "Application-level encryption is not implemented yet. Use non-sensitive test data."}
            </p>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {view === "library"
                ? "LOCAL PERSONAL CONTEXT"
                : view === "connections"
                  ? "CONTROLLED AI ACCESS"
                  : "DISCLOSURE ACTIVITY"}
            </p>
            <h1>
              {view === "library"
                ? "Find the source behind your memory."
                : view === "connections"
                  ? "Connect context without surrendering the vault."
                  : "See when context stayed local or could reach AI."}
            </h1>
          </div>
          {view === "library" ? (
            isFolderWork ? (
              <button className="secondary danger" type="button" onClick={handleCancelImport}>
                {activity === "preflight" ? "Cancel scan" : "Cancel import"}
              </button>
            ) : (
              <button
                className="primary"
                type="button"
                onClick={handleImport}
                disabled={activity !== undefined}
              >
                Add a folder
              </button>
            )
          ) : null}
        </header>

        <section className="boundary" aria-label="Current data boundary">
          <span>
            {view === "library"
              ? "Current mode"
              : view === "connections"
                ? "Transfer boundary"
                : "History boundary"}
          </span>
          <strong>
            {view === "library"
              ? status
              : view === "connections"
                ? "Local retrieval · returned context may leave"
                : "Content-free local log"}
          </strong>
          <p>
            {view === "library"
              ? "Files and the index stay on this device. Returned text and provenance metadata can leave it when an authorized cloud AI requests context."
              : view === "connections"
                ? "An enabled AI client receives bounded text and provenance metadata from its allowed collection. Its configured model provider may process them outside this device."
                : "This screen never reveals queries, excerpts, titles, document identifiers, or file paths."}
          </p>
        </section>

        {error ? <p className="error global-error" role="alert">{error}</p> : null}

        {view === "library" ? (
          <LibraryView
            activity={activity}
            notice={isFolderWork ? progressText(progress) : notice}
            query={query}
            results={results}
            receipts={receipts}
            selected={selected}
            sources={sources}
            hasSearched={hasSearched}
            codexStatus={codexConnection?.status}
            claudeCodeStatus={claudeCodeConnection?.status}
            purgePreview={purgePreview}
            directoryImportPreflight={directoryImportPreflight}
            directoryDialogBusy={directoryDialogBusy}
            importReport={importReport}
            onFetch={handleFetch}
            onBeginSourcePurge={beginSourcePurge}
            onCancelSourcePurge={() => setPurgePreview(undefined)}
            onConfirmSourcePurge={confirmSourcePurge}
            onQueryChange={setQuery}
            onSearch={handleSearch}
            onImportFolder={handleImport}
            onImportSample={handleImportSample}
            onConfirmDirectoryImport={confirmDirectoryImport}
            onCancelDirectoryImport={cancelDirectoryImport}
            onChooseAnotherDirectory={chooseAnotherDirectory}
            onCancelActiveImport={handleCancelImport}
            onDismissImportReport={() => setImportReport(undefined)}
            onOpenConnections={() => setView("connections")}
            onCloseSelected={() => setSelected(undefined)}
          />
        ) : view === "connections" ? (
          <ConnectionsView
            codexBusy={codexConnectionBusy}
            codexNotice={codexConnectionNotice}
            codexPreview={codexConnection}
            claudeCodeBusy={claudeCodeConnectionBusy}
            claudeCodeNotice={claudeCodeConnectionNotice}
            claudeCodePreview={claudeCodeConnection}
            onApplyCodex={() => mutateCodexConnection("apply")}
            onRemoveCodex={() => mutateCodexConnection("remove")}
            onApplyClaudeCode={() => mutateClaudeCodeConnection("apply")}
            onRemoveClaudeCode={() => mutateClaudeCodeConnection("remove")}
          />
        ) : (
          <AccessHistoryView
            entries={retrievalActivity}
            busy={historyBusy}
            notice={historyNotice}
            onClear={clearHistory}
            onRefresh={refreshHistoryManually}
          />
        )}
      </main>
    </div>
  );
}

interface LibraryViewProps {
  activity: Activity | undefined;
  notice: string;
  query: string;
  results: Result[];
  receipts: DeletionReceiptView[];
  selected: FetchResponse | undefined;
  sources: VaultSource[];
  hasSearched: boolean;
  codexStatus: CodexConnectionPreview["status"] | undefined;
  claudeCodeStatus: ClaudeCodeConnectionPreview["status"] | undefined;
  purgePreview: SourcePurgePreview | undefined;
  directoryImportPreflight:
    | Extract<PrepareDirectoryImportResponse, { status: "ready" }>
    | undefined;
  directoryDialogBusy: boolean;
  importReport: DirectoryImportResultView | undefined;
  onFetch: (result: Result) => void;
  onBeginSourcePurge: (source: VaultSource) => void;
  onCancelSourcePurge: () => void;
  onConfirmSourcePurge: () => void;
  onQueryChange: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onImportFolder: () => void;
  onImportSample: () => void;
  onConfirmDirectoryImport: () => void;
  onCancelDirectoryImport: () => void;
  onChooseAnotherDirectory: () => void;
  onCancelActiveImport: () => void;
  onDismissImportReport: () => void;
  onOpenConnections: () => void;
  onCloseSelected: () => void;
}

function LibraryView(props: LibraryViewProps) {
  const preflightDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = preflightDialogRef.current;
    if (props.directoryImportPreflight && dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [props.directoryImportPreflight]);

  const documentCount = props.sources.reduce(
    (total, source) => total + source.documentCount,
    0,
  );
  const onboarding = deriveLibraryOnboarding({
    documentCount,
    resultCount: props.results.length,
    hasSearched: props.hasSearched,
    hasManagedConnection:
      props.codexStatus === "managed" || props.claudeCodeStatus === "managed",
  });

  return (
    <section className="workspace">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SEARCH YOUR LIBRARY</p>
          <h2>Ground every answer in something you wrote.</h2>
        </div>
        <span className="session-notice">{props.notice}</span>
      </div>

      <form className="search" onSubmit={props.onSearch}>
        <input
          aria-label="Search personal context"
          placeholder="Try: What did I write about remote work?"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <button type="submit" disabled={props.activity !== undefined || !props.query.trim()}>
          {props.activity === "search" ? "Searching…" : "Search"}
        </button>
      </form>

      {props.importReport ? (
        <section className="import-report" aria-label="Latest folder import report">
          <div className="import-report-heading">
            <div>
              <p className="eyebrow">LATEST FOLDER IMPORT</p>
              <h3>{props.importReport.skipped > 0
                ? "Imported with files that need attention"
                : "Folder import completed"}</h3>
              <p>{summarizeImport(props.importReport)}</p>
            </div>
            <button className="secondary" type="button" onClick={props.onDismissImportReport}>
              Dismiss
            </button>
          </div>
          {props.importReport.issueExamples.length > 0 ? (
            <ul className="issue-list">
              {props.importReport.issueExamples.map((issue, index) => (
                <li key={`${issue.code}-${issue.path}-${index}`}>
                  <strong>{issue.path}</strong>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {props.importReport.truncatedIssueCount > 0 ? (
            <small>
              {props.importReport.truncatedIssueCount} more skipped-file issue
              {props.importReport.truncatedIssueCount === 1 ? "" : "s"} not shown.
            </small>
          ) : null}
        </section>
      ) : null}

      {onboarding.canContinueToConnections ? (
        <section className="setup-bridge" aria-label="Finish AI setup">
          <div>
            <p className="eyebrow">NEXT STEP · AI ACCESS</p>
            <h3>
              {onboarding.aiConfigurationSaved
                ? "An AI connection configuration is saved."
                : "Your library is ready for an AI client."}
            </h3>
            <p>
              {onboarding.aiConfigurationSaved
                ? "Review the allowed collection or disconnect a client. Restart that client after a configuration change."
                : "Preview the generated MCP structure, permission boundary, and external-transfer notice before anything is changed."}
            </p>
          </div>
          <button className="secondary" type="button" onClick={props.onOpenConnections}>
            {onboarding.aiConfigurationSaved
              ? "Review AI connections"
              : "Continue to AI connections"}
          </button>
        </section>
      ) : null}

      <div className="content-grid">
        <div className="results" aria-live="polite">
          {props.results.length === 0 ? (
            <div className="empty">
              {onboarding.emptyState === "first-run" ? (
                <>
                  <span>SAFE FIRST RUN</span>
                  <h3>Try OhMyContext without using your files</h3>
                  <p>
                    Add a small built-in library of fictional English and Korean notes, or choose
                    a folder you are authorized to import. Only UTF-8 Markdown and text files are read.
                  </p>
                  <div className="empty-actions">
                    <button
                      className="primary"
                      type="button"
                      disabled={props.activity !== undefined}
                      onClick={props.onImportSample}
                    >
                      Try sample library
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={props.activity !== undefined}
                      onClick={props.onImportFolder}
                    >
                      Choose my folder
                    </button>
                  </div>
                  <small>The sample is non-sensitive, removable, and stored only in this local profile.</small>
                </>
              ) : onboarding.emptyState === "no-results" ? (
                <>
                  <span>NO MATCHES</span>
                  <h3>No result matched this search</h3>
                  <p>Try fewer words or a phrase that appears in one of the imported documents.</p>
                </>
              ) : (
                <>
                  <span>SEARCH READY</span>
                  <h3>Search your imported library</h3>
                  <p>Use the suggested query or words you remember from a Markdown or text file.</p>
                </>
              )}
            </div>
          ) : (
            props.results.map((result) => (
              <article key={result.chunkId} className="result-card">
                <div className="result-meta">
                  <span title={result.sourceUri}>{result.sourceUri}</span>
                  <time>{new Date(result.modifiedAt).toLocaleDateString()}</time>
                </div>
                <h3>{result.title}</h3>
                <p>{result.snippet}</p>
                <div className="result-actions">
                  <code>{result.documentId.slice(0, 16)}…</code>
                  <button type="button" onClick={() => props.onFetch(result)}>View context</button>
                </div>
              </article>
            ))
          )}
        </div>

        <aside className="source-panel" aria-label="Imported sources">
          <p className="eyebrow">SOURCE HEALTH</p>
          <h3>{props.sources.length} connected folder{props.sources.length === 1 ? "" : "s"}</h3>
          {props.sources.length === 0 ? (
            <p className="muted">No source has completed an import.</p>
          ) : (
            <div className="source-list">
              {props.sources.map((source) => (
                <div className="source-item" key={source.sourceId}>
                  <div><span className={`health ${source.status}`} /> <strong>{source.name}</strong></div>
                  <p>{source.documentCount} documents · {source.collection}</p>
                  <small title={source.rootUri}>{source.rootUri}</small>
                  <time>
                    {source.lastScannedAt
                      ? `Scanned ${new Date(source.lastScannedAt).toLocaleString()}`
                      : "Import incomplete"}
                  </time>
                  <button
                    className="source-remove"
                    type="button"
                    disabled={props.activity !== undefined}
                    onClick={() => props.onBeginSourcePurge(source)}
                  >
                    Remove from OhMyContext
                  </button>
                </div>
              ))}
            </div>
          )}

          {props.receipts.length > 0 ? (
            <div className="receipt-list" aria-label="Recent deletion receipts">
              <p className="eyebrow">RECENT REMOVALS</p>
              {props.receipts.slice(0, 3).map((receipt) => (
                <article
                  className={`receipt ${receipt.verificationStatus}`}
                  key={receipt.receiptId}
                >
                  <strong>{receiptStatus(receipt)}</strong>
                  <p>
                    {receipt.documentCount} documents · {receipt.revisionCount} revisions · {receipt.chunkCount} chunks
                  </p>
                  <time>{new Date(receipt.completedAt).toLocaleString()}</time>
                  <code title={receipt.receiptId}>{receipt.receiptId.slice(0, 16)}…</code>
                </article>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      {props.selected ? (
        <div className="context-drawer" role="dialog" aria-label="Retrieved document context">
          <div className="drawer-heading">
            <div>
              <p className="eyebrow">BOUNDED DOCUMENT CONTEXT</p>
              <h3>{props.selected.title}</h3>
            </div>
            <button type="button" onClick={props.onCloseSelected}>Close</button>
          </div>
          <p className="source-uri">{props.selected.sourceUri}</p>
          <pre>{props.selected.content}</pre>
        </div>
      ) : null}

      {props.directoryImportPreflight ? (
        <dialog
          ref={preflightDialogRef}
          className="preflight-dialog"
          aria-labelledby="directory-import-preflight-title"
          onCancel={(event) => {
            event.preventDefault();
            if (props.activity === "import") {
              void props.onCancelActiveImport();
            } else if (!props.directoryDialogBusy) {
              void props.onCancelDirectoryImport();
            }
          }}
        >
            <p className="eyebrow">REVIEW BEFORE IMPORT</p>
            <h3 id="directory-import-preflight-title">
              Import “{props.directoryImportPreflight.folderLabel}”?
            </h3>
            <p className="preflight-summary">
              OhMyContext scanned this folder locally. Confirm the exact supported-file scope before
              anything is added to your vault.
            </p>

            <dl className="preflight-stats">
              <div>
                <dt>Ready to import</dt>
                <dd>{props.directoryImportPreflight.preview.candidateFileCount} files · {formatBytes(props.directoryImportPreflight.preview.candidateBytes)}</dd>
              </div>
              <div>
                <dt>Visited entries</dt>
                <dd>{props.directoryImportPreflight.preview.visitedEntryCount}</dd>
              </div>
              <div>
                <dt>Unsupported files</dt>
                <dd>{props.directoryImportPreflight.preview.unsupportedFileCount}</dd>
              </div>
              <div>
                <dt>Oversized files</dt>
                <dd>{props.directoryImportPreflight.preview.oversizedFileCount}</dd>
              </div>
              <div>
                <dt>Rejected links</dt>
                <dd>{props.directoryImportPreflight.preview.rejectedLinkCount}</dd>
              </div>
              <div>
                <dt>Read errors</dt>
                <dd>{props.directoryImportPreflight.preview.readErrorCount}</dd>
              </div>
            </dl>

            <dl className="preflight-boundaries">
              <div>
                <dt>Supported content</dt>
                <dd>Valid UTF-8 {props.directoryImportPreflight.preview.supportedExtensions.join(", ")} files only</dd>
              </div>
              <div>
                <dt>Local destination</dt>
                <dd>Collection “{props.directoryImportPreflight.preview.collection}”</dd>
              </div>
              <div>
                <dt>Original folder</dt>
                <dd>Files are read but never changed or deleted</dd>
              </div>
              <div>
                <dt>Future AI access</dt>
                <dd>Returned excerpts and provenance may leave this device through an authorized cloud AI</dd>
              </div>
            </dl>

            {props.directoryImportPreflight.preview.unsupportedByExtension.length > 0 ? (
              <p className="extension-summary">
                Excluded by extension: {props.directoryImportPreflight.preview.unsupportedByExtension
                  .map((item) => `${item.extension} (${item.count})`)
                  .join(" · ")}
              </p>
            ) : null}

            {props.directoryImportPreflight.preview.issueExamples.length > 0 ? (
              <div className="preflight-issues">
                <strong>Examples that will not be imported</strong>
                <ul className="issue-list">
                  {props.directoryImportPreflight.preview.issueExamples.map((issue, index) => (
                    <li key={`${issue.code}-${issue.path}-${index}`}>
                      <strong>{issue.path}</strong>
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
                {props.directoryImportPreflight.preview.truncatedIssueCount > 0 ? (
                  <small>
                    {props.directoryImportPreflight.preview.truncatedIssueCount} more issue
                    {props.directoryImportPreflight.preview.truncatedIssueCount === 1 ? "" : "s"} not shown.
                  </small>
                ) : null}
              </div>
            ) : null}

            {!props.directoryImportPreflight.preview.canImport ? (
              <p className="preflight-empty" role="status">
                No supported file is ready. Choose a folder containing valid UTF-8 .md or .txt files.
              </p>
            ) : null}
            <small className="preflight-expiry">
              This in-memory preview expires after five minutes and can be used only once.
              OhMyContext checks the approved scope again before import and stops if it no longer matches.
            </small>

            <div className="preflight-actions">
              <button
                className="secondary"
                type="button"
                autoFocus
                disabled={props.directoryDialogBusy && props.activity !== "import"}
                onClick={props.activity === "import"
                  ? props.onCancelActiveImport
                  : props.onCancelDirectoryImport}
              >
                {props.activity === "import" ? "Cancel import" : "Cancel"}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={props.directoryDialogBusy || props.activity !== undefined}
                onClick={props.onChooseAnotherDirectory}
              >
                Choose another folder
              </button>
              <button
                className="primary"
                type="button"
                disabled={props.directoryDialogBusy || props.activity !== undefined || !props.directoryImportPreflight.preview.canImport}
                onClick={props.onConfirmDirectoryImport}
              >
                {props.activity === "import"
                  ? "Importing…"
                  : `Import ${props.directoryImportPreflight.preview.candidateFileCount} file${props.directoryImportPreflight.preview.candidateFileCount === 1 ? "" : "s"}`}
              </button>
            </div>
        </dialog>
      ) : null}

      {props.purgePreview ? (
        <div className="modal-backdrop">
          <div
            className="purge-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="purge-source-title"
          >
            <p className="eyebrow">CONFIRM LOCAL REMOVAL</p>
            <h3 id="purge-source-title">Remove “{props.purgePreview.name}” from OhMyContext?</h3>
            <p className="purge-summary">
              This removes the indexed local copy of {props.purgePreview.documentCount} document
              {props.purgePreview.documentCount === 1 ? "" : "s"}, every stored revision, chunks,
              search-index entries, and linked retrieval-audit rows.
            </p>
            <dl className="purge-boundaries">
              <div>
                <dt>Original folder</dt>
                <dd>Not changed or deleted</dd>
              </div>
              <div>
                <dt>External AI excerpts</dt>
                <dd>Transferred or in-progress excerpts are outside this removal</dd>
              </div>
              <div>
                <dt>Deletion assurance</dt>
                <dd>Logical non-addressability, not secure disk erasure</dd>
              </div>
            </dl>
            <p className="source-uri" title={props.purgePreview.rootUri}>
              {props.purgePreview.rootUri}
            </p>
            <p className="purge-reimport-note">
              Adding this folder again later can import its files again. A content-free receipt is
              stored only after every local-vault deletion step succeeds.
            </p>
            <div className="purge-actions">
              <button
                className="secondary"
                type="button"
                disabled={props.activity === "purge"}
                onClick={props.onCancelSourcePurge}
              >
                Keep source
              </button>
              <button
                className="danger-action"
                type="button"
                disabled={props.activity === "purge"}
                onClick={props.onConfirmSourcePurge}
              >
                {props.activity === "purge" ? "Removing…" : "Remove local copy"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface AccessHistoryViewProps {
  entries: RetrievalActivityEntry[];
  busy: boolean;
  notice: string;
  onClear: () => void;
  onRefresh: () => void;
}

function retrievalClientLabel(clientKind: RetrievalActivityEntry["clientKind"]): string {
  switch (clientKind) {
    case "desktop":
      return "OhMyContext desktop";
    case "codex":
      return "Launch-declared Codex";
    case "claude-code":
      return "Launch-declared Claude Code";
    case "legacy":
      return "Earlier OhMyContext version";
  }
}

function retrievalBoundary(entry: RetrievalActivityEntry): string {
  switch (entry.clientKind) {
    case "desktop":
      return "Handled inside the desktop app.";
    case "codex":
      return "The MCP launch declared Codex; returned data may have been handled by another process or provider.";
    case "claude-code":
      return "The MCP launch declared Claude Code; returned data may have been handled by another process or provider.";
    case "legacy":
      return "The client was not recorded by the earlier vault schema.";
  }
}

function AccessHistoryView(props: AccessHistoryViewProps) {
  return (
    <section className="workspace access-history">
      <div className="section-heading history-heading">
        <div>
          <p className="eyebrow">LOCAL TRANSPARENCY LOG</p>
          <h2>Review how each request was launch-attributed.</h2>
        </div>
        <div className="history-actions">
          <button
            className="secondary"
            type="button"
            disabled={props.busy}
            onClick={props.onRefresh}
          >
            {props.busy ? "Working…" : "Refresh history"}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.busy || props.entries.length === 0}
            onClick={props.onClear}
          >
            Clear local history
          </button>
        </div>
      </div>

      <div className="history-boundary-grid">
        <article>
          <span className="history-kind local">LOCAL</span>
          <strong>OhMyContext desktop</strong>
          <p>Search previews and opened context stay inside this app.</p>
        </article>
        <article>
          <span className="history-kind external">MAY LEAVE DEVICE</span>
          <strong>Codex or Claude Code declaration</strong>
          <p>The launch label is not an authenticated client identity. Returned data may be processed externally.</p>
        </article>
        <article>
          <span className="history-kind legacy">UNKNOWN CLIENT</span>
          <strong>Earlier vault entries</strong>
          <p>Older records lack a client label; request grouping may be split if earlier purges removed rows.</p>
        </article>
      </div>

      <div className="history-privacy-note">
        <strong>What this screen excludes</strong>
        <p>
          It does not reveal your query, document text, snippets, titles, document or chunk IDs, or
          file paths. Each displayed entry contains only time, request type, client, and result count.
          The vault keeps opaque document/chunk linkage only so removing a source can also remove its
          linked audit rows. External-client labels are managed-launch metadata, not authenticated
          identities or proof that a named client or provider received or retained data. This view
          does not live-update for external requests; select Refresh history after using an AI client.
        </p>
      </div>

      <p className="session-notice history-notice" aria-live="polite">{props.notice}</p>

      {props.entries.length === 0 ? (
        <div className="empty history-empty">
          <span>NO RECORDED REQUESTS</span>
          <h3>Access history is empty</h3>
          <p>Search locally or use a connected AI client to create a content-free entry.</p>
        </div>
      ) : (
        <div className="history-list" aria-label="Recent access history">
          {props.entries.map((entry) => (
            <article className="history-entry" key={entry.requestId}>
              <div className="history-entry-main">
                <span className={`history-client ${entry.clientKind}`}>
                  {retrievalClientLabel(entry.clientKind)}
                </span>
                <strong>{entry.eventType === "search" ? "Search response" : "Document context fetch"}</strong>
                <p>{retrievalBoundary(entry)}</p>
              </div>
              <div className="history-entry-meta">
                <time>{new Date(entry.occurredAt).toLocaleString()}</time>
                <span>
                  {entry.resultCount} result{entry.resultCount === 1 ? "" : "s"}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

interface ConnectionsViewProps {
  codexBusy: boolean;
  codexNotice: string;
  codexPreview: CodexConnectionPreview | undefined;
  claudeCodeBusy: boolean;
  claudeCodeNotice: string;
  claudeCodePreview: ClaudeCodeConnectionPreview | undefined;
  onApplyCodex: () => void;
  onRemoveCodex: () => void;
  onApplyClaudeCode: () => void;
  onRemoveClaudeCode: () => void;
}

function ConnectionsView(props: ConnectionsViewProps) {
  const codexManaged = props.codexPreview?.status === "managed";
  const codexRegistered = codexManaged || props.codexPreview?.status === "managed_stale";
  const claudeCodeManaged = props.claudeCodePreview?.status === "managed";
  const claudeCodeRegistered =
    claudeCodeManaged || props.claudeCodePreview?.status === "managed_stale";
  return (
    <section className="workspace connections">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SUPPORTED AI CLIENTS</p>
          <h2>Choose where your local context may be used.</h2>
        </div>
      </div>

      <article className="connection-card" aria-label="Codex connection">
        <div className="connection-summary">
          <div className="client-icon">CX</div>
          <div>
            <span className={`health ${codexManaged ? "ready" : "incomplete"}`} />
            <strong>{codexConnectionStatus(props.codexPreview)}</strong>
            <p>
              OhMyContext manages one marked block in <code>~/.codex/config.toml</code>.
              Existing settings stay private and are preserved byte-for-byte.
            </p>
          </div>
        </div>

        <div className="permission-grid">
          <div><span>Tools</span><strong>search · fetch</strong></div>
          <div>
            <span>Allowed collection</span>
            <strong>{props.codexPreview?.allowedCollection ?? "Checking…"}</strong>
          </div>
          <div><span>Grant duration</span><strong>Until disconnected</strong></div>
          <div><span>Writes / transport</span><strong>No document writes · stdio</strong></div>
        </div>

        <div className="config-preview">
          <div>
            <p className="eyebrow">CHANGE PREVIEW</p>
            <p>The generated structure is shown with private local paths redacted. The current Codex file is never sent to the renderer.</p>
          </div>
          <pre>{props.codexPreview?.snippet || "A safe preview is unavailable until the conflict is resolved."}</pre>
        </div>

        <div className="connection-warning">
          <strong>Before connecting</strong>
          <p>
            Installing OhMyContext does not connect Codex. Updates refresh the connection only
            while this marked block is already managed. A timestamped backup is created before an
            existing file changes. Restart Codex after applying a connection change or updating
            OhMyContext; an older running MCP process fails closed if the vault schema changed. The
            AI client or provider may receive returned excerpts and provenance metadata, including
            titles, source paths, timestamps, and stable document IDs.
          </p>
        </div>

        <div className="connection-actions">
          <button
            className="primary"
            type="button"
            disabled={props.codexBusy || !props.codexPreview?.canApply}
            onClick={props.onApplyCodex}
          >
            {props.codexBusy ? "Working…" : codexRegistered ? "Update connection" : "Connect Codex"}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.codexBusy || !props.codexPreview?.canRemove}
            onClick={props.onRemoveCodex}
          >
            Disconnect OhMyContext
          </button>
        </div>
        <p className="connection-notice" aria-live="polite">{props.codexNotice}</p>
      </article>

      <article className="connection-card" aria-label="Claude Code connection">
        <div className="connection-summary">
          <div className="client-icon claude">CC</div>
          <div>
            <span className={`health ${claudeCodeManaged ? "ready" : "incomplete"}`} />
            <strong>{claudeCodeConnectionStatus(props.claudeCodePreview)}</strong>
            <p>
              OhMyContext asks the installed Claude Code CLI to manage the user-scoped
              <code> owncontext</code> entry. It respects <code>CLAUDE_CONFIG_DIR</code> without
              showing that private path or unrelated Claude settings on this screen.
            </p>
          </div>
        </div>

        <div className="permission-grid">
          <div><span>Tools</span><strong>search · fetch</strong></div>
          <div>
            <span>Allowed collection</span>
            <strong>{props.claudeCodePreview?.allowedCollection ?? "Checking…"}</strong>
          </div>
          <div><span>Grant duration</span><strong>Until disconnected</strong></div>
          <div><span>Writes / transport</span><strong>No document writes · stdio</strong></div>
        </div>

        <div className="config-preview">
          <div>
            <p className="eyebrow">CHANGE PREVIEW</p>
            <p>OhMyContext's generated JSON structure is shown with private local paths redacted. Registration uses separated CLI arguments, never a shell command string.</p>
          </div>
          <pre>{props.claudeCodePreview?.snippet || "A safe preview is unavailable until Claude Code is found or the conflict is resolved."}</pre>
        </div>

        <div className="connection-warning">
          <strong>Before registering</strong>
          <p>
            Clicking connect runs Claude Code's user-scope MCP command after creating a backup
            when a configuration already exists. Restart active Claude Code sessions after a
            connection change or an OhMyContext app update; an older running MCP process fails
            closed if the vault schema changed. The AI client or provider may receive returned
            excerpts and provenance metadata, including titles, source paths, timestamps, and
            stable document IDs.
          </p>
        </div>

        <div className="connection-actions">
          <button
            className="primary"
            type="button"
            disabled={props.claudeCodeBusy || !props.claudeCodePreview?.canApply}
            onClick={props.onApplyClaudeCode}
          >
            {props.claudeCodeBusy
              ? "Working…"
              : claudeCodeRegistered
                ? "Refresh registration"
                : "Connect Claude Code"}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.claudeCodeBusy || !props.claudeCodePreview?.canRemove}
            onClick={props.onRemoveClaudeCode}
          >
            Disconnect OhMyContext
          </button>
        </div>
        <p className="connection-notice" aria-live="polite">{props.claudeCodeNotice}</p>
      </article>

      <div className="planned-client">
        <span>Claude Desktop</span>
        <p>One-click signed Desktop Extension packaging is planned after the release security gates.</p>
        <strong>Planned</strong>
      </div>
    </section>
  );
}
