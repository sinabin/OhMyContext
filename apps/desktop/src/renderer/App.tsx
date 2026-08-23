import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  CodexConnectionMutation,
  CodexConnectionPreview,
  FetchResponse,
  ImportProgress,
  VaultSource,
} from "../electron/preload.cjs";

interface Result {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  sourceUri: string;
  createdAt: string;
  modifiedAt: string;
}

type View = "library" | "connections";
type Activity = "import" | "search";

function summarizeImport(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "Import completed.";
  }

  const record = value as Record<string, unknown>;
  const parts = [
    typeof record.imported === "number" ? `${record.imported} imported` : undefined,
    typeof record.updated === "number" ? `${record.updated} updated` : undefined,
    typeof record.unchanged === "number" ? `${record.unchanged} unchanged` : undefined,
    typeof record.skipped === "number" ? `${record.skipped} skipped` : undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "Import completed.";
}

function connectionStatus(preview: CodexConnectionPreview | undefined): string {
  if (!preview) return "Checking local configuration…";
  if (!preview.serverReady) return "Local MCP build is unavailable";

  switch (preview.status) {
    case "managed":
      return "Connected by OwnContext";
    case "absent":
      return "Ready to connect";
    case "unmanaged_conflict":
      return "Existing OwnContext entry needs manual review";
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

function mutationNotice(result: CodexConnectionMutation): string {
  if (result.ok) {
    if (result.code === "unchanged") return "No configuration change was needed.";
    const backup = result.backupFileName
      ? ` Backup created: ${result.backupFileName}.`
      : "";
    return result.code === "removed"
      ? `OwnContext was disconnected.${backup}`
      : `Codex connection saved.${backup} Restart Codex to load it.`;
  }

  const messages: Record<string, string> = {
    server_unavailable: "Build the local MCP server before connecting Codex.",
    unmanaged_conflict: "OwnContext found an unmanaged entry and refused to overwrite it.",
    malformed_managed_block: "The managed block is malformed. Restore its backup or review it manually.",
    config_too_large: "The configuration is larger than OwnContext's safe edit limit.",
    invalid_encoding: "The configuration must be valid UTF-8 before OwnContext can edit it.",
    read_failed: "The configuration could not be read safely.",
    backup_failed: "No change was made because a backup could not be created.",
    write_failed: "The configuration could not be replaced safely.",
    concurrent_change: "The Codex file changed during editing, so OwnContext left it untouched.",
    invalid_path: "The generated local launch paths did not pass validation.",
  };
  return messages[result.code] ?? "The connection was not changed.";
}

function progressText(progress: ImportProgress | undefined): string {
  if (!progress) return "Preparing import…";
  if (progress.phase === "discovering") return "Discovering supported files…";
  if (progress.phase === "finalizing") return "Finalizing the atomic vault update…";
  const total = progress.total === null ? "?" : String(progress.total);
  return `Importing ${progress.processed} of ${total} · ${progress.imported} new · ${progress.updated} updated`;
}

export function App() {
  const [view, setView] = useState<View>("library");
  const [status, setStatus] = useState("Starting local vault…");
  const [notice, setNotice] = useState("No source imported in this session.");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [sources, setSources] = useState<VaultSource[]>([]);
  const [activity, setActivity] = useState<Activity>();
  const [progress, setProgress] = useState<ImportProgress>();
  const [selected, setSelected] = useState<FetchResponse>();
  const [error, setError] = useState<string>();
  const [connection, setConnection] = useState<CodexConnectionPreview>();
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState(
    "OwnContext never returns the rest of your Codex configuration to this screen.",
  );

  async function refreshSources() {
    const response = await window.ownContext.listSources();
    setSources(response.sources);
  }

  async function refreshConnection() {
    const response = await window.ownContext.previewCodexConnection();
    setConnection(response);
  }

  useEffect(() => {
    const stopListening = window.ownContext.onImportProgress(setProgress);
    void Promise.all([
      window.ownContext.getStatus().then((value) => setStatus(value.mode)),
      refreshSources(),
    ]).catch((reason: unknown) => setError(String(reason)));
    return stopListening;
  }, []);

  useEffect(() => {
    if (view === "connections") {
      void refreshConnection().catch((reason: unknown) => setError(String(reason)));
    }
  }, [view]);

  async function handleImport() {
    setActivity("import");
    setProgress(undefined);
    setError(undefined);

    try {
      const response = await window.ownContext.importDirectory();
      if (response.aborted) {
        setNotice("Import canceled. The previous complete vault state was preserved.");
      } else if (!response.canceled) {
        setNotice(summarizeImport(response.result));
        await refreshSources();
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setActivity(undefined);
      setProgress(undefined);
    }
  }

  async function handleCancelImport() {
    await window.ownContext.cancelImport();
    setNotice("Cancel requested. Rolling back the current import…");
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
    } catch (reason) {
      setError(String(reason));
    } finally {
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
    }
  }

  async function mutateConnection(operation: "apply" | "remove") {
    setConnectionBusy(true);
    setError(undefined);
    try {
      const result = operation === "apply"
        ? await window.ownContext.applyCodexConnection()
        : await window.ownContext.removeCodexConnection();
      setConnectionNotice(mutationNotice(result));
      await refreshConnection();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setConnectionBusy(false);
    }
  }

  const isImporting = activity === "import";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">OC</span>
          <div>
            <strong>OwnContext</strong>
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
          <button className="nav-item" type="button" disabled>Access history · next</button>
        </nav>

        <div className="trust-note">
          <span className="status-dot" />
          <div>
            <strong>Developer alpha</strong>
            <p>Application-level encryption is not implemented yet. Use non-sensitive test data.</p>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {view === "library" ? "LOCAL PERSONAL CONTEXT" : "CONTROLLED AI ACCESS"}
            </p>
            <h1>
              {view === "library"
                ? "Find the source behind your memory."
                : "Connect context without surrendering the vault."}
            </h1>
          </div>
          {view === "library" ? (
            isImporting ? (
              <button className="secondary danger" type="button" onClick={handleCancelImport}>
                Cancel import
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
          <span>{view === "library" ? "Current mode" : "Transfer boundary"}</span>
          <strong>{view === "library" ? status : "Local retrieval · selected excerpts may leave"}</strong>
          <p>
            {view === "library"
              ? "Files and the index stay on this device. Excerpts can leave it when an authorized cloud AI requests context."
              : "Codex receives only bounded search results. Its configured model provider may process those excerpts outside this device."}
          </p>
        </section>

        {error ? <p className="error global-error" role="alert">{error}</p> : null}

        {view === "library" ? (
          <LibraryView
            activity={activity}
            notice={isImporting ? progressText(progress) : notice}
            query={query}
            results={results}
            selected={selected}
            sources={sources}
            onFetch={handleFetch}
            onQueryChange={setQuery}
            onSearch={handleSearch}
            onCloseSelected={() => setSelected(undefined)}
          />
        ) : (
          <ConnectionsView
            busy={connectionBusy}
            notice={connectionNotice}
            preview={connection}
            onApply={() => mutateConnection("apply")}
            onRemove={() => mutateConnection("remove")}
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
  selected: FetchResponse | undefined;
  sources: VaultSource[];
  onFetch: (result: Result) => void;
  onQueryChange: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onCloseSelected: () => void;
}

function LibraryView(props: LibraryViewProps) {
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

      <div className="content-grid">
        <div className="results" aria-live="polite">
          {props.results.length === 0 ? (
            <div className="empty">
              <span>01</span>
              <h3>Add a folder, then search</h3>
              <p>Markdown and text files are supported by this first vertical slice.</p>
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
                </div>
              ))}
            </div>
          )}
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
    </section>
  );
}

interface ConnectionsViewProps {
  busy: boolean;
  notice: string;
  preview: CodexConnectionPreview | undefined;
  onApply: () => void;
  onRemove: () => void;
}

function ConnectionsView(props: ConnectionsViewProps) {
  const managed = props.preview?.status === "managed";
  return (
    <section className="workspace connections">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FIRST SUPPORTED CLIENT</p>
          <h2>Codex desktop and CLI</h2>
        </div>
        <span className="session-notice">{props.notice}</span>
      </div>

      <article className="connection-card">
        <div className="connection-summary">
          <div className="client-icon">CX</div>
          <div>
            <span className={`health ${managed ? "ready" : "incomplete"}`} />
            <strong>{connectionStatus(props.preview)}</strong>
            <p>
              OwnContext manages one marked block in <code>~/.codex/config.toml</code>.
              Existing settings stay private and are preserved byte-for-byte.
            </p>
          </div>
        </div>

        <div className="permission-grid">
          <div><span>Tools</span><strong>search · fetch</strong></div>
          <div><span>Document writes</span><strong>None · audit log only</strong></div>
          <div><span>Network listener</span><strong>None · stdio</strong></div>
          <div><span>Audit</span><strong>Query hash · document IDs</strong></div>
        </div>

        <div className="config-preview">
          <div>
            <p className="eyebrow">CHANGE PREVIEW</p>
            <p>Only this generated block is shown. The current Codex file is never sent to the renderer.</p>
          </div>
          <pre>{props.preview?.snippet || "A safe preview is unavailable until the conflict is resolved."}</pre>
        </div>

        <div className="connection-warning">
          <strong>Before connecting</strong>
          <p>
            Installing OwnContext does not connect Codex. Updates refresh the connection only
            while this marked block is already managed. A timestamped backup is created before an
            existing file changes. Restart Codex after applying or updating. Cloud models may
            receive excerpts selected through these tools.
          </p>
        </div>

        <div className="connection-actions">
          <button
            className="primary"
            type="button"
            disabled={props.busy || !props.preview?.canApply}
            onClick={props.onApply}
          >
            {props.busy ? "Working…" : managed ? "Update connection" : "Connect Codex"}
          </button>
          <button
            className="secondary danger-text"
            type="button"
            disabled={props.busy || !props.preview?.canRemove}
            onClick={props.onRemove}
          >
            Disconnect OwnContext
          </button>
        </div>
      </article>

      <div className="planned-client">
        <span>Claude Desktop</span>
        <p>One-click signed Desktop Extension packaging is planned after the release security gates.</p>
        <strong>Planned</strong>
      </div>
    </section>
  );
}
