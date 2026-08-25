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
import {
  extensionLabel,
  issueMessage,
  issuePath,
  LOCALE_OPTIONS,
  localizeConnectionPreview,
  message,
  translateMessage,
  useUiLocale,
  type LocalizedMessage,
  type MessageKey,
  type Translator,
  type UiLocale,
} from "./i18n.js";

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

function summarizeImport(record: ImportCountSummary): LocalizedMessage {
  return message("import.summary", {
    imported: record.imported,
    updated: record.updated,
    unchanged: record.unchanged,
    skipped: record.skipped,
  });
}

function summarizeSampleImport(value: unknown): LocalizedMessage {
  if (!value || typeof value !== "object") {
    return message("import.sampleCompletedAndTrySearch");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.imported !== "number" ||
    typeof record.updated !== "number" ||
    typeof record.unchanged !== "number" ||
    typeof record.skipped !== "number"
  ) {
    return message("import.sampleCompletedAndTrySearch");
  }
  return message("import.sampleSummaryTrySearch", {
    imported: record.imported,
    updated: record.updated,
    unchanged: record.unchanged,
    skipped: record.skipped,
  });
}

function codexConnectionStatus(
  preview: CodexConnectionPreview | undefined,
): LocalizedMessage {
  if (!preview) return message("status.checkingConfiguration");
  if (!preview.serverReady) return message("connection.codex.status.serverUnavailable");

  switch (preview.status) {
    case "managed":
      return message("connection.codex.status.managed");
    case "managed_stale":
      return message("connection.codex.status.managedStale");
    case "absent":
      return message("connection.codex.status.ready");
    case "unmanaged_conflict":
      return message("connection.codex.status.unmanagedConflict");
    case "malformed_managed_block":
      return message("connection.codex.status.malformedBlock");
    case "config_too_large":
      return message("connection.codex.status.tooLarge");
    case "invalid_encoding":
      return message("connection.codex.status.invalidEncoding");
    case "read_failed":
      return message("connection.codex.status.readFailed");
  }
}

function codexMutationNotice(result: CodexConnectionMutation): LocalizedMessage {
  if (result.ok) {
    if (result.code === "unchanged") {
      return message("connection.codex.mutation.unchanged");
    }
    if (result.code === "removed") {
      return result.backupFileName
        ? message("connection.codex.mutation.removedWithBackup", {
            backupFileName: result.backupFileName,
          })
        : message("connection.codex.mutation.removed");
    }
    return result.backupFileName
      ? message("connection.codex.mutation.savedWithBackup", {
          backupFileName: result.backupFileName,
        })
      : message("connection.codex.mutation.saved");
  }

  const messages: Record<string, MessageKey> = {
    server_unavailable: "connection.codex.error.serverUnavailable",
    unmanaged_conflict: "connection.codex.error.unmanagedConflict",
    malformed_managed_block: "connection.codex.error.malformedBlock",
    config_too_large: "connection.codex.error.tooLarge",
    invalid_encoding: "connection.codex.error.invalidEncoding",
    read_failed: "connection.codex.error.readFailed",
    backup_failed: "connection.codex.error.backupFailed",
    busy: "connection.codex.error.busy",
    write_failed: "connection.codex.error.writeFailed",
    concurrent_change: "connection.codex.error.concurrentChange",
    invalid_path: "connection.codex.error.invalidPath",
  };
  return message(messages[result.code] ?? "connection.codex.error.unknown");
}

function claudeCodeConnectionStatus(
  preview: ClaudeCodeConnectionPreview | undefined,
): LocalizedMessage {
  if (!preview) return message("status.checkingConfiguration");

  switch (preview.status) {
    case "managed":
      return preview.serverReady
        ? message("connection.claude.status.managed")
        : message("connection.claude.status.managedServerUnavailable");
    case "managed_stale":
      return message("connection.claude.status.managedStale");
    case "absent":
      if (!preview.serverReady) return message("connection.claude.status.serverUnavailable");
      return preview.cliAvailable
        ? message("connection.claude.status.ready")
        : message("connection.claude.status.cliUnavailable");
    case "unmanaged_conflict":
      return message("connection.claude.status.unmanagedConflict");
    case "config_too_large":
      return message("connection.claude.status.tooLarge");
    case "invalid_encoding":
      return message("connection.claude.status.invalidEncoding");
    case "invalid_json":
      return message("connection.claude.status.invalidJson");
    case "invalid_structure":
      return message("connection.claude.status.invalidStructure");
    case "read_failed":
      return message("connection.claude.status.readFailed");
    case "invalid_config_target":
      return message("connection.claude.status.invalidTarget");
    case "invalid_launch":
      return message("connection.claude.status.invalidLaunch");
  }
}

function claudeCodeMutationNotice(
  result: ClaudeCodeConnectionMutation,
): LocalizedMessage {
  if (result.ok) {
    if (result.code === "unchanged") {
      return message("connection.claude.mutation.unchanged");
    }
    if (result.code === "removed") {
      return result.backupFileName
        ? message("connection.claude.mutation.removedWithBackup", {
            backupFileName: result.backupFileName,
          })
        : message("connection.claude.mutation.removed");
    }
    return result.backupFileName
      ? message("connection.claude.mutation.savedWithBackup", {
          backupFileName: result.backupFileName,
        })
      : message("connection.claude.mutation.saved");
  }

  if (result.code === "update_removed_retry_required") {
    return result.backupFileName
      ? message("connection.claude.mutation.retryWithBackup", {
          backupFileName: result.backupFileName,
        })
      : message("connection.claude.mutation.retry");
  }

  if (result.restored) {
    return result.backupFileName
      ? message("connection.claude.mutation.restoredWithBackup", {
          backupFileName: result.backupFileName,
        })
      : message("connection.claude.mutation.restored");
  }

  if (result.changed) {
    return result.backupFileName
      ? message("connection.claude.mutation.verificationFailedWithBackup", {
          backupFileName: result.backupFileName,
        })
      : message("connection.claude.mutation.verificationFailed");
  }

  const messages: Record<string, MessageKey> = {
    server_unavailable: "connection.claude.error.serverUnavailable",
    cli_unavailable: "connection.claude.error.cliUnavailable",
    unmanaged_conflict: "connection.claude.error.unmanagedConflict",
    config_too_large: "connection.claude.error.tooLarge",
    invalid_encoding: "connection.claude.error.invalidEncoding",
    invalid_json: "connection.claude.error.invalidJson",
    invalid_structure: "connection.claude.error.invalidStructure",
    read_failed: "connection.claude.error.readFailed",
    invalid_config_target: "connection.claude.error.invalidTarget",
    backup_failed: "connection.claude.error.backupFailed",
    concurrent_change: "connection.claude.error.concurrentChange",
    cli_failed: "connection.claude.error.cliFailed",
    cli_timeout: "connection.claude.error.cliTimeout",
    cli_output_limit: "connection.claude.error.cliOutputLimit",
    verification_failed: "connection.claude.error.verificationFailed",
    recovery_required: "connection.claude.error.recoveryRequired",
    write_failed: "connection.claude.error.writeFailed",
    invalid_launch: "connection.claude.error.invalidLaunch",
  };
  return message(messages[result.code] ?? "connection.claude.error.unknown");
}

function progressText(progress: ImportProgress | undefined): LocalizedMessage {
  if (!progress) return message("import.progress.preparing");
  if (progress.phase === "discovering") return message("import.progress.discovering");
  if (progress.phase === "finalizing") return message("import.progress.finalizing");
  return message("import.progress.importing", {
    processed: progress.processed,
    total: progress.total ?? "?",
    imported: progress.imported,
    updated: progress.updated,
  });
}

function receiptStatus(receipt: DeletionReceiptView): MessageKey {
  switch (receipt.verificationStatus) {
    case "verified":
      return "receipt.status.verified";
    case "target-reintroduced":
      return "receipt.status.reintroduced";
    case "integrity-error":
      return "receipt.status.integrityError";
    case "not-found":
      return "receipt.status.notFound";
  }
}

export function App() {
  const { locale, setLocale, t } = useUiLocale();
  const [view, setView] = useState<View>("library");
  const [vaultReady, setVaultReady] = useState(false);
  const [encryption, setEncryption] = useState<"not-implemented" | "application-encrypted">("not-implemented");
  const [notice, setNotice] = useState<LocalizedMessage>(() =>
    message("status.noSourceThisSession")
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [sources, setSources] = useState<VaultSource[]>([]);
  const [receipts, setReceipts] = useState<DeletionReceiptView[]>([]);
  const [retrievalActivity, setRetrievalActivity] = useState<RetrievalActivityEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<LocalizedMessage>(
    () => message("history.notice.initial"),
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
  const [error, setError] = useState<LocalizedMessage>();
  const [codexConnection, setCodexConnection] = useState<CodexConnectionPreview>();
  const [codexConnectionBusy, setCodexConnectionBusy] = useState(false);
  const [codexConnectionNotice, setCodexConnectionNotice] = useState<LocalizedMessage>(
    () => message("connection.codex.notice.initial"),
  );
  const [claudeCodeConnection, setClaudeCodeConnection] =
    useState<ClaudeCodeConnectionPreview>();
  const [claudeCodeConnectionBusy, setClaudeCodeConnectionBusy] = useState(false);
  const [claudeCodeConnectionNotice, setClaudeCodeConnectionNotice] =
    useState<LocalizedMessage>(
      () => message("connection.claude.notice.initial"),
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
      setHistoryNotice(message("history.notice.requestRefreshFailed"));
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
    void window.ownContext.setLocale(locale)
      .then(() => {
        setError((current) =>
          current?.key === "error.localeSync" ? undefined : current
        );
      })
      .catch(() => {
        setError(message("error.localeSync"));
      });
  }, [locale]);

  useEffect(() => {
    const stopListening = window.ownContext.onImportProgress(setProgress);
    void Promise.all([
      window.ownContext.getStatus().then((value) => {
        setEncryption(value.encryption);
        setVaultReady(value.ready);
      }),
      refreshSources(),
      refreshReceipts(),
      refreshRetrievalActivity(),
      refreshCodexConnection(),
      refreshClaudeCodeConnection(),
    ]).catch(() => setError(message("error.initialLoad")));
    return stopListening;
  }, []);

  useEffect(() => {
    if (view === "connections") {
      void Promise.all([
        refreshCodexConnection(),
        // Preview only. Merely opening the screen must not execute a PATH command.
        refreshClaudeCodeConnection(),
      ]).catch(() => setError(message("error.connectionRefresh")));
    } else if (view === "history") {
      void refreshRetrievalActivity().catch(() => setError(message("error.historyRefresh")));
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
          setNotice(message("import.notice.scanComplete"));
          break;
        case "canceled":
          setNotice(message("import.notice.selectionCanceled"));
          break;
        case "aborted":
          setNotice(message("import.notice.scanCanceled"));
          break;
        case "busy":
          setNotice(message("import.notice.busy"));
          break;
        case "failed":
          setError(message("import.error.inspectFolder"));
          break;
      }
    } catch {
      setError(message("import.error.startScan"));
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
            setNotice(message("import.notice.previewAlreadyUsedRefresh"));
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
          setNotice(message("import.notice.folderChanged"));
          break;
        case "expired":
          setDirectoryImportPreflight(undefined);
          setNotice(message("import.notice.previewExpired"));
          break;
        case "invalid":
          setDirectoryImportPreflight(undefined);
          setNotice(message("import.notice.previewInvalid"));
          break;
        case "aborted":
          setDirectoryImportPreflight(undefined);
          setNotice(message("import.notice.canceledPreserved"));
          break;
        case "busy":
          setNotice(message("import.notice.busy"));
          break;
        case "failed":
          setDirectoryImportPreflight(undefined);
          setError(message("import.error.complete"));
          break;
      }
    } catch {
      setDirectoryImportPreflight(undefined);
      setError(message("import.error.complete"));
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
        ? message("import.notice.previewAlreadyUsedNoImport")
        : message("import.notice.previewCanceled"));
    } catch {
      setError(message("import.error.closePreview"));
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
      setError(message("import.error.switchFolder"));
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
        setError(message("import.error.sample"));
      } else if (response.aborted) {
        setNotice(message("import.notice.sampleCanceled"));
      } else if (!response.canceled) {
        setNotice(summarizeSampleImport(response.result));
        setQuery(response.suggestedQuery ?? "weekly review");
        setHasSearched(false);
        setResults([]);
        await Promise.all([refreshSources(), refreshReceipts()]);
      }
    } catch {
      setError(message("import.error.sample"));
    } finally {
      setActivity(undefined);
      setProgress(undefined);
      directoryFlowLock.current = false;
    }
  }

  async function handleCancelImport() {
    await window.ownContext.cancelImport();
    setNotice(activity === "preflight"
      ? message("import.notice.cancelScanRequested")
      : message("import.notice.cancelImportRequested"));
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
    } catch {
      setError(message("error.search"));
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
    } catch {
      setError(message("error.fetch"));
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
        setNotice(message("source.notice.waitBeforeRemoval"));
      } else {
        setNotice(message("source.notice.notPresent"));
        await refreshSources();
      }
    } catch {
      setError(message("error.sourcePreview"));
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
        setNotice(message("source.notice.removed", {
          receiptId: `${response.receipt.receiptId.slice(0, 12)}…`,
        }));
        await Promise.all([refreshSources(), refreshReceipts(), refreshRetrievalActivity()]);
      } else if (response.status === "canceled") {
        setPurgePreview(undefined);
        setNotice(message("source.notice.removalCanceled"));
      } else if (response.status === "stale-confirmation") {
        setPurgePreview(undefined);
        setNotice(message("source.notice.changedAfterConfirmation"));
        await refreshSources();
      } else if (response.status === "import-in-progress") {
        setPurgePreview(undefined);
        setNotice(message("source.notice.removalBlocked"));
      } else {
        setPurgePreview(undefined);
        setNotice(message("source.notice.alreadyAbsent"));
        await refreshSources();
      }
    } catch {
      setError(message("error.sourceRemoval"));
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
    } catch {
      setError(message("error.codexChange"));
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
    } catch {
      setError(message("error.claudeCodeChange"));
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
        setHistoryNotice(message("history.notice.cleared", { count: response.deleted }));
      } else {
        setHistoryNotice(message("history.notice.clearCanceled"));
      }
    } catch {
      setError(message("error.historyClear"));
    } finally {
      setHistoryBusy(false);
    }
  }

  async function refreshHistoryManually() {
    setHistoryBusy(true);
    setError(undefined);
    try {
      await refreshRetrievalActivity();
      setHistoryNotice(message("history.notice.refreshed"));
    } catch {
      setError(message("error.historyRefresh"));
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
            <strong>{t("app.name")}</strong>
            <small>{t("app.tagline")}</small>
          </div>
        </div>

        <nav aria-label={t("nav.primaryLabel")}>
          <button
            data-testid="nav-library"
            className={`nav-item ${view === "library" ? "active" : ""}`}
            type="button"
            onClick={() => setView("library")}
          >
            {t("nav.library")}
          </button>
          <button
            data-testid="nav-connections"
            className={`nav-item ${view === "connections" ? "active" : ""}`}
            type="button"
            onClick={() => setView("connections")}
          >
            {t("nav.connections")}
          </button>
          <button
            data-testid="nav-history"
            className={`nav-item ${view === "history" ? "active" : ""}`}
            type="button"
            onClick={() => setView("history")}
          >
            {t("nav.history")}
          </button>
        </nav>

        <label className="language-picker">
          <span>{t("locale.selectorLabel")}</span>
          <select
            data-testid="locale-select"
            value={locale}
            onChange={(event) => setLocale(event.target.value as UiLocale)}
          >
            {LOCALE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <div className="trust-note">
          <span className="status-dot" />
          <div>
            <strong>
              {encryption === "application-encrypted"
                ? t("security.encrypted.title")
                : t("security.developerAlpha.title")}
            </strong>
            <p>
              {encryption === "application-encrypted"
                ? t("security.encrypted.body")
                : t("security.developerAlpha.body")}
            </p>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {view === "library"
                ? t("header.library.eyebrow")
                : view === "connections"
                  ? t("header.connections.eyebrow")
                  : t("header.history.eyebrow")}
            </p>
            <h1>
              {view === "library"
                ? t("header.library.title")
                : view === "connections"
                  ? t("header.connections.title")
                  : t("header.history.title")}
            </h1>
          </div>
          {view === "library" ? (
            isFolderWork ? (
              <button className="secondary danger" type="button" onClick={handleCancelImport}>
                {activity === "preflight" ? t("action.cancelScan") : t("action.cancelImport")}
              </button>
            ) : (
              <button
                className="primary"
                type="button"
                onClick={handleImport}
                disabled={activity !== undefined}
              >
                {t("action.addFolder")}
              </button>
            )
          ) : null}
        </header>

        <section
          className="boundary"
          data-testid="data-boundary"
          aria-label={t("boundary.ariaLabel")}
        >
          <span>
            {view === "library"
              ? t("boundary.library.label")
              : view === "connections"
                ? t("boundary.connections.label")
                : t("boundary.history.label")}
          </span>
          <strong>
            {view === "library"
              ? vaultReady
                ? t("boundary.library.value")
                : t("status.startingVault")
              : view === "connections"
                ? t("boundary.connections.value")
                : t("boundary.history.value")}
          </strong>
          <p>
            {view === "library"
              ? t("boundary.library.body")
              : view === "connections"
                ? t("boundary.connections.body")
                : t("boundary.history.body")}
          </p>
        </section>

        {error ? (
          <p className="error global-error" role="alert">
            {translateMessage(locale, error)}
          </p>
        ) : null}

        {view === "library" ? (
          <LibraryView
            activity={activity}
            locale={locale}
            t={t}
            notice={translateMessage(locale, isFolderWork ? progressText(progress) : notice)}
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
            locale={locale}
            t={t}
            codexBusy={codexConnectionBusy}
            codexNotice={translateMessage(locale, codexConnectionNotice)}
            codexPreview={codexConnection}
            claudeCodeBusy={claudeCodeConnectionBusy}
            claudeCodeNotice={translateMessage(locale, claudeCodeConnectionNotice)}
            claudeCodePreview={claudeCodeConnection}
            onApplyCodex={() => mutateCodexConnection("apply")}
            onRemoveCodex={() => mutateCodexConnection("remove")}
            onApplyClaudeCode={() => mutateClaudeCodeConnection("apply")}
            onRemoveClaudeCode={() => mutateClaudeCodeConnection("remove")}
          />
        ) : (
          <AccessHistoryView
            t={t}
            entries={retrievalActivity}
            busy={historyBusy}
            notice={translateMessage(locale, historyNotice)}
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
  locale: UiLocale;
  t: Translator;
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
          <p className="eyebrow">{props.t("library.search.eyebrow")}</p>
          <h2>{props.t("library.search.title")}</h2>
        </div>
        <span className="session-notice">{props.notice}</span>
      </div>

      <form className="search" onSubmit={props.onSearch}>
        <input
          data-testid="search-input"
          aria-label={props.t("library.search.ariaLabel")}
          placeholder={props.t("library.search.placeholder")}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <button type="submit" disabled={props.activity !== undefined || !props.query.trim()}>
          {props.activity === "search" ? props.t("action.searching") : props.t("action.search")}
        </button>
      </form>

      {props.importReport ? (
        <section className="import-report" aria-label={props.t("library.report.ariaLabel")}>
          <div className="import-report-heading">
            <div>
              <p className="eyebrow">{props.t("library.report.eyebrow")}</p>
              <h3>{props.importReport.skipped > 0
                ? props.t("library.report.needsAttention")
                : props.t("library.report.completed")}</h3>
              <p>{translateMessage(props.locale, summarizeImport(props.importReport))}</p>
            </div>
            <button className="secondary" type="button" onClick={props.onDismissImportReport}>
              {props.t("action.dismiss")}
            </button>
          </div>
          {props.importReport.issueExamples.length > 0 ? (
            <ul className="issue-list">
              {props.importReport.issueExamples.map((issue, index) => (
                <li key={`${issue.code}-${issue.path}-${index}`}>
                  <strong>{issuePath(issue.path, props.t)}</strong>
                  <span>{issueMessage(issue.code, props.t)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {props.importReport.truncatedIssueCount > 0 ? (
            <small>
              {props.t("library.report.moreIssues", {
                count: props.importReport.truncatedIssueCount,
              })}
            </small>
          ) : null}
        </section>
      ) : null}

      {onboarding.canContinueToConnections ? (
        <section className="setup-bridge" aria-label={props.t("library.setup.ariaLabel")}>
          <div>
            <p className="eyebrow">{props.t("library.setup.eyebrow")}</p>
            <h3>
              {onboarding.aiConfigurationSaved
                ? props.t("library.setup.savedTitle")
                : props.t("library.setup.readyTitle")}
            </h3>
            <p>
              {onboarding.aiConfigurationSaved
                ? props.t("library.setup.savedBody")
                : props.t("library.setup.readyBody")}
            </p>
          </div>
          <button className="secondary" type="button" onClick={props.onOpenConnections}>
            {onboarding.aiConfigurationSaved
              ? props.t("action.reviewConnections")
              : props.t("action.continueConnections")}
          </button>
        </section>
      ) : null}

      <div className="content-grid">
        <div className="results" aria-live="polite">
          {props.results.length === 0 ? (
            <div className="empty">
              {onboarding.emptyState === "first-run" ? (
                <>
                  <span>{props.t("library.empty.firstRun.eyebrow")}</span>
                  <h3>{props.t("library.empty.firstRun.title")}</h3>
                  <p>{props.t("library.empty.firstRun.body")}</p>
                  <div className="empty-actions">
                    <button
                      data-testid="import-sample"
                      className="primary"
                      type="button"
                      disabled={props.activity !== undefined}
                      onClick={props.onImportSample}
                    >
                      {props.t("action.trySample")}
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={props.activity !== undefined}
                      onClick={props.onImportFolder}
                    >
                      {props.t("action.chooseMyFolder")}
                    </button>
                  </div>
                  <small>{props.t("library.empty.firstRun.sampleNote")}</small>
                </>
              ) : onboarding.emptyState === "no-results" ? (
                <>
                  <span>{props.t("library.empty.noMatches.eyebrow")}</span>
                  <h3>{props.t("library.empty.noMatches.title")}</h3>
                  <p>{props.t("library.empty.noMatches.body")}</p>
                </>
              ) : (
                <>
                  <span>{props.t("library.empty.ready.eyebrow")}</span>
                  <h3>{props.t("library.empty.ready.title")}</h3>
                  <p>{props.t("library.empty.ready.body")}</p>
                </>
              )}
            </div>
          ) : (
            props.results.map((result) => (
              <article key={result.chunkId} className="result-card">
                <div className="result-meta">
                  <span title={result.sourceUri}>{result.sourceUri}</span>
                  <time>{props.t.date(result.modifiedAt)}</time>
                </div>
                <h3>{result.title}</h3>
                <p>{result.snippet}</p>
                <div className="result-actions">
                  <code>{result.documentId.slice(0, 16)}…</code>
                  <button type="button" onClick={() => props.onFetch(result)}>
                    {props.t("action.viewContext")}
                  </button>
                </div>
              </article>
            ))
          )}
        </div>

        <aside className="source-panel" aria-label={props.t("library.sources.ariaLabel")}>
          <p className="eyebrow">{props.t("library.sources.eyebrow")}</p>
          <h3>{props.t("library.sources.connectedFolders", {
            count: props.sources.length,
          })}</h3>
          {props.sources.length === 0 ? (
            <p className="muted">{props.t("library.sources.none")}</p>
          ) : (
            <div className="source-list">
              {props.sources.map((source) => (
                <div className="source-item" key={source.sourceId}>
                  <div><span className={`health ${source.status}`} /> <strong>{source.name}</strong></div>
                  <p>{props.t("library.sources.documents", {
                    count: source.documentCount,
                    collection: source.collection,
                  })}</p>
                  <small title={source.rootUri}>{source.rootUri}</small>
                  <time>
                    {source.lastScannedAt
                      ? props.t("library.sources.scannedAt", {
                          dateTime: props.t.dateTime(source.lastScannedAt),
                        })
                      : props.t("library.sources.incomplete")}
                  </time>
                  <button
                    className="source-remove"
                    type="button"
                    disabled={props.activity !== undefined}
                    onClick={() => props.onBeginSourcePurge(source)}
                  >
                    {props.t("action.removeFromApp")}
                  </button>
                </div>
              ))}
            </div>
          )}

          {props.receipts.length > 0 ? (
            <div className="receipt-list" aria-label={props.t("library.receipts.ariaLabel")}>
              <p className="eyebrow">{props.t("library.receipts.eyebrow")}</p>
              {props.receipts.slice(0, 3).map((receipt) => (
                <article
                  className={`receipt ${receipt.verificationStatus}`}
                  key={receipt.receiptId}
                >
                  <strong>{props.t(receiptStatus(receipt))}</strong>
                  <p>
                    {[
                      props.t("library.receipts.documentCount", {
                        count: receipt.documentCount,
                      }),
                      props.t("library.receipts.revisionCount", {
                        count: receipt.revisionCount,
                      }),
                      props.t("library.receipts.chunkCount", {
                        count: receipt.chunkCount,
                      }),
                    ].join(" · ")}
                  </p>
                  <time>{props.t.dateTime(receipt.completedAt)}</time>
                  <code title={receipt.receiptId}>{receipt.receiptId.slice(0, 16)}…</code>
                </article>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      {props.selected ? (
        <div className="context-drawer" role="dialog" aria-label={props.t("library.drawer.ariaLabel")}>
          <div className="drawer-heading">
            <div>
              <p className="eyebrow">{props.t("library.drawer.eyebrow")}</p>
              <h3>{props.selected.title}</h3>
            </div>
            <button type="button" onClick={props.onCloseSelected}>{props.t("action.close")}</button>
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
            <p className="eyebrow">{props.t("preflight.eyebrow")}</p>
            <h3 id="directory-import-preflight-title">
              {props.t("preflight.title", {
                folderName: props.directoryImportPreflight.folderLabel,
              })}
            </h3>
            <p className="preflight-summary">{props.t("preflight.summary")}</p>

            <dl className="preflight-stats">
              <div>
                <dt>{props.t("preflight.ready")}</dt>
                <dd>{props.t("preflight.readyValue", {
                  count: props.directoryImportPreflight.preview.candidateFileCount,
                  bytes: props.t.bytes(props.directoryImportPreflight.preview.candidateBytes),
                })}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.visited")}</dt>
                <dd>{props.t.number(props.directoryImportPreflight.preview.visitedEntryCount)}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.unsupported")}</dt>
                <dd>{props.t.number(props.directoryImportPreflight.preview.unsupportedFileCount)}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.oversized")}</dt>
                <dd>{props.t.number(props.directoryImportPreflight.preview.oversizedFileCount)}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.rejectedLinks")}</dt>
                <dd>{props.t.number(props.directoryImportPreflight.preview.rejectedLinkCount)}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.readErrors")}</dt>
                <dd>{props.t.number(props.directoryImportPreflight.preview.readErrorCount)}</dd>
              </div>
            </dl>

            <dl className="preflight-boundaries">
              <div>
                <dt>{props.t("preflight.supportedContent")}</dt>
                <dd>{props.t("preflight.supportedContentValue", {
                  extensions: new Intl.ListFormat(props.locale, {
                    style: "short",
                    type: "conjunction",
                  }).format([...props.directoryImportPreflight.preview.supportedExtensions]),
                })}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.localDestination")}</dt>
                <dd>{props.t("preflight.localDestinationValue", {
                  collection: props.directoryImportPreflight.preview.collection,
                })}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.originalFolder")}</dt>
                <dd>{props.t("preflight.originalFolderValue")}</dd>
              </div>
              <div>
                <dt>{props.t("preflight.futureAiAccess")}</dt>
                <dd>{props.t("preflight.futureAiAccessValue")}</dd>
              </div>
            </dl>

            {props.directoryImportPreflight.preview.unsupportedByExtension.length > 0 ? (
              <p className="extension-summary">
                {props.t("preflight.excludedExtensions", {
                  extensions: props.directoryImportPreflight.preview.unsupportedByExtension
                    .map((item) =>
                      `${extensionLabel(item.extension, props.t)} (${props.t.number(item.count)})`
                    )
                    .join(" · "),
                })}
              </p>
            ) : null}

            {props.directoryImportPreflight.preview.issueExamples.length > 0 ? (
              <div className="preflight-issues">
                <strong>{props.t("preflight.issueExamples")}</strong>
                <ul className="issue-list">
                  {props.directoryImportPreflight.preview.issueExamples.map((issue, index) => (
                    <li key={`${issue.code}-${issue.path}-${index}`}>
                      <strong>{issuePath(issue.path, props.t)}</strong>
                      <span>{issueMessage(issue.code, props.t)}</span>
                    </li>
                  ))}
                </ul>
                {props.directoryImportPreflight.preview.truncatedIssueCount > 0 ? (
                  <small>
                    {props.t("preflight.moreIssues", {
                      count: props.directoryImportPreflight.preview.truncatedIssueCount,
                    })}
                  </small>
                ) : null}
              </div>
            ) : null}

            {!props.directoryImportPreflight.preview.canImport ? (
              <p className="preflight-empty" role="status">
                {props.t("preflight.noSupportedFile")}
              </p>
            ) : null}
            <small className="preflight-expiry">
              {props.t("preflight.expiry")}
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
                {props.activity === "import"
                  ? props.t("action.cancelImport")
                  : props.t("action.cancel")}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={props.directoryDialogBusy || props.activity !== undefined}
                onClick={props.onChooseAnotherDirectory}
              >
                {props.t("action.chooseAnotherFolder")}
              </button>
              <button
                className="primary"
                type="button"
                disabled={props.directoryDialogBusy || props.activity !== undefined || !props.directoryImportPreflight.preview.canImport}
                onClick={props.onConfirmDirectoryImport}
              >
                {props.activity === "import"
                  ? props.t("action.importing")
                  : props.t("preflight.importFiles", {
                      count: props.directoryImportPreflight.preview.candidateFileCount,
                    })}
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
            <p className="eyebrow">{props.t("purge.eyebrow")}</p>
            <h3 id="purge-source-title">{props.t("purge.title", {
              sourceName: props.purgePreview.name,
            })}</h3>
            <p className="purge-summary">
              {props.t("purge.summary", { count: props.purgePreview.documentCount })}
            </p>
            <dl className="purge-boundaries">
              <div>
                <dt>{props.t("purge.originalFolder")}</dt>
                <dd>{props.t("purge.originalFolderValue")}</dd>
              </div>
              <div>
                <dt>{props.t("purge.externalExcerpts")}</dt>
                <dd>{props.t("purge.externalExcerptsValue")}</dd>
              </div>
              <div>
                <dt>{props.t("purge.assurance")}</dt>
                <dd>{props.t("purge.assuranceValue")}</dd>
              </div>
            </dl>
            <p className="source-uri" title={props.purgePreview.rootUri}>
              {props.purgePreview.rootUri}
            </p>
            <p className="purge-reimport-note">{props.t("purge.reimportNote")}</p>
            <div className="purge-actions">
              <button
                className="secondary"
                type="button"
                disabled={props.activity === "purge"}
                onClick={props.onCancelSourcePurge}
              >
                {props.t("action.keepSource")}
              </button>
              <button
                className="danger-action"
                type="button"
                disabled={props.activity === "purge"}
                onClick={props.onConfirmSourcePurge}
              >
                {props.activity === "purge"
                  ? props.t("action.removing")
                  : props.t("action.removeLocalCopy")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface AccessHistoryViewProps {
  t: Translator;
  entries: RetrievalActivityEntry[];
  busy: boolean;
  notice: string;
  onClear: () => void;
  onRefresh: () => void;
}

function retrievalClientLabel(
  clientKind: RetrievalActivityEntry["clientKind"],
): MessageKey {
  switch (clientKind) {
    case "desktop":
      return "history.client.desktop";
    case "codex":
      return "history.client.codex";
    case "claude-code":
      return "history.client.claudeCode";
    case "legacy":
      return "history.client.legacy";
  }
}

function retrievalBoundary(entry: RetrievalActivityEntry): MessageKey {
  switch (entry.clientKind) {
    case "desktop":
      return "history.boundary.desktop";
    case "codex":
      return "history.boundary.codex";
    case "claude-code":
      return "history.boundary.claudeCode";
    case "legacy":
      return "history.boundary.legacy";
  }
}

function AccessHistoryView(props: AccessHistoryViewProps) {
  return (
    <section className="workspace access-history">
      <div className="section-heading history-heading">
        <div>
          <p className="eyebrow">{props.t("history.eyebrow")}</p>
          <h2>{props.t("history.title")}</h2>
        </div>
        <div className="history-actions">
          <button
            className="secondary"
            type="button"
            disabled={props.busy}
            onClick={props.onRefresh}
          >
            {props.busy ? props.t("action.working") : props.t("action.refreshHistory")}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.busy || props.entries.length === 0}
            onClick={props.onClear}
          >
            {props.t("action.clearHistory")}
          </button>
        </div>
      </div>

      <div className="history-boundary-grid">
        <article>
          <span className="history-kind local">{props.t("history.kind.local")}</span>
          <strong>{props.t("history.card.localTitle")}</strong>
          <p>{props.t("history.card.localBody")}</p>
        </article>
        <article>
          <span className="history-kind external">{props.t("history.kind.mayLeave")}</span>
          <strong>{props.t("history.card.externalTitle")}</strong>
          <p>{props.t("history.card.externalBody")}</p>
        </article>
        <article>
          <span className="history-kind legacy">{props.t("history.kind.unknown")}</span>
          <strong>{props.t("history.card.legacyTitle")}</strong>
          <p>{props.t("history.card.legacyBody")}</p>
        </article>
      </div>

      <div className="history-privacy-note">
        <strong>{props.t("history.privacyTitle")}</strong>
        <p>{props.t("history.privacyBody")}</p>
      </div>

      <p className="session-notice history-notice" aria-live="polite">{props.notice}</p>

      {props.entries.length === 0 ? (
        <div className="empty history-empty">
          <span>{props.t("history.empty.eyebrow")}</span>
          <h3>{props.t("history.empty.title")}</h3>
          <p>{props.t("history.empty.body")}</p>
        </div>
      ) : (
        <div className="history-list" aria-label={props.t("history.list.ariaLabel")}>
          {props.entries.map((entry) => (
            <article className="history-entry" key={entry.requestId}>
              <div className="history-entry-main">
                <span className={`history-client ${entry.clientKind}`}>
                  {props.t(retrievalClientLabel(entry.clientKind))}
                </span>
                <strong>{entry.eventType === "search"
                  ? props.t("history.event.search")
                  : props.t("history.event.fetch")}</strong>
                <p>{props.t(retrievalBoundary(entry))}</p>
              </div>
              <div className="history-entry-meta">
                <time>{props.t.dateTime(entry.occurredAt)}</time>
                <span>{props.t("history.resultCount", { count: entry.resultCount })}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

interface ConnectionsViewProps {
  locale: UiLocale;
  t: Translator;
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
          <p className="eyebrow">{props.t("connections.eyebrow")}</p>
          <h2>{props.t("connections.title")}</h2>
        </div>
      </div>

      <article className="connection-card" aria-label={props.t("connections.codex.ariaLabel")}>
        <div className="connection-summary">
          <div className="client-icon">CX</div>
          <div>
            <span className={`health ${codexManaged ? "ready" : "incomplete"}`} />
            <strong>{translateMessage(
              props.locale,
              codexConnectionStatus(props.codexPreview),
            )}</strong>
            <p>{props.t("connections.codex.summary")}</p>
          </div>
        </div>

        <div className="permission-grid">
          <div><span>{props.t("connections.permission.tools")}</span><strong>search · fetch</strong></div>
          <div>
            <span>{props.t("connections.permission.allowedCollection")}</span>
            <strong>{props.codexPreview?.allowedCollection ?? props.t("status.checking")}</strong>
          </div>
          <div>
            <span>{props.t("connections.permission.grantDuration")}</span>
            <strong>{props.t("connections.permission.untilDisconnected")}</strong>
          </div>
          <div>
            <span>{props.t("connections.permission.writesTransport")}</span>
            <strong>{props.t("connections.permission.noWritesStdio")}</strong>
          </div>
        </div>

        <div className="config-preview">
          <div>
            <p className="eyebrow">{props.t("connections.preview.eyebrow")}</p>
            <p>{props.t("connections.codex.previewBody")}</p>
          </div>
          <pre>{props.codexPreview?.snippet
            ? localizeConnectionPreview(props.codexPreview.snippet, props.locale)
            : props.t("connections.codex.previewUnavailable")}</pre>
        </div>

        <div className="connection-warning">
          <strong>{props.t("connections.codex.warningTitle")}</strong>
          <p>{props.t("connections.codex.warningBody")}</p>
        </div>

        <div className="connection-actions">
          <button
            className="primary"
            type="button"
            disabled={props.codexBusy || !props.codexPreview?.canApply}
            onClick={props.onApplyCodex}
          >
            {props.codexBusy
              ? props.t("action.working")
              : codexRegistered
                ? props.t("action.updateConnection")
                : props.t("action.connectCodex")}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.codexBusy || !props.codexPreview?.canRemove}
            onClick={props.onRemoveCodex}
          >
            {props.t("action.disconnectApp")}
          </button>
        </div>
        <p className="connection-notice" aria-live="polite">{props.codexNotice}</p>
      </article>

      <article className="connection-card" aria-label={props.t("connections.claude.ariaLabel")}>
        <div className="connection-summary">
          <div className="client-icon claude">CC</div>
          <div>
            <span className={`health ${claudeCodeManaged ? "ready" : "incomplete"}`} />
            <strong>{translateMessage(
              props.locale,
              claudeCodeConnectionStatus(props.claudeCodePreview),
            )}</strong>
            <p>{props.t("connections.claude.summary")}</p>
          </div>
        </div>

        <div className="permission-grid">
          <div><span>{props.t("connections.permission.tools")}</span><strong>search · fetch</strong></div>
          <div>
            <span>{props.t("connections.permission.allowedCollection")}</span>
            <strong>{props.claudeCodePreview?.allowedCollection ?? props.t("status.checking")}</strong>
          </div>
          <div>
            <span>{props.t("connections.permission.grantDuration")}</span>
            <strong>{props.t("connections.permission.untilDisconnected")}</strong>
          </div>
          <div>
            <span>{props.t("connections.permission.writesTransport")}</span>
            <strong>{props.t("connections.permission.noWritesStdio")}</strong>
          </div>
        </div>

        <div className="config-preview">
          <div>
            <p className="eyebrow">{props.t("connections.preview.eyebrow")}</p>
            <p>{props.t("connections.claude.previewBody")}</p>
          </div>
          <pre>{props.claudeCodePreview?.snippet
            ? localizeConnectionPreview(props.claudeCodePreview.snippet, props.locale)
            : props.t("connections.claude.previewUnavailable")}</pre>
        </div>

        <div className="connection-warning">
          <strong>{props.t("connections.claude.warningTitle")}</strong>
          <p>{props.t("connections.claude.warningBody")}</p>
        </div>

        <div className="connection-actions">
          <button
            className="primary"
            type="button"
            disabled={props.claudeCodeBusy || !props.claudeCodePreview?.canApply}
            onClick={props.onApplyClaudeCode}
          >
            {props.claudeCodeBusy
              ? props.t("action.working")
              : claudeCodeRegistered
                ? props.t("action.refreshRegistration")
                : props.t("action.connectClaudeCode")}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.claudeCodeBusy || !props.claudeCodePreview?.canRemove}
            onClick={props.onRemoveClaudeCode}
          >
            {props.t("action.disconnectApp")}
          </button>
        </div>
        <p className="connection-notice" aria-live="polite">{props.claudeCodeNotice}</p>
      </article>

      <div className="planned-client">
        <span>{props.t("connections.planned.name")}</span>
        <p>{props.t("connections.planned.body")}</p>
        <strong>{props.t("connections.planned.label")}</strong>
      </div>
    </section>
  );
}
