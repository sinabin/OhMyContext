# Architecture

Last updated: 2026-08-23

## System intent

OwnContext is a local personal-data plane with replaceable AI clients. The core does not generate answers. It imports authorized user data, preserves provenance, retrieves bounded evidence, and releases that evidence through a policy-controlled read-only interface.

```text
lawful source
    |
connector + isolated parser
    |
raw snapshot ---- provenance / revision / deletion lineage
    |
normalized open document
    |
lexical index + optional derived vector index
    |
collection and client policy gate
    |
read-only MCP search / fetch
    |
Claude, Codex, or another authorized client
```

## Trust boundaries

1. Source boundary: exports, APIs, websites, and attachments can contain malicious data.
2. Parser boundary: file decoders and connector code must be resource constrained and unable to grant permissions.
3. Vault boundary: canonical data, derived indexes, tokens, and audit data have different retention and export rules.
4. Release boundary: once an excerpt is returned to an external AI client, OwnContext cannot control downstream storage or tool use.
5. Update boundary: application and connector updates are executable supply-chain inputs and must be signed before public release.

## Workspace components

### `packages/core`

Owns the domain model, SQLite schema, deterministic identities, ingestion, revision lineage, search, fetch, purge, and portable export contracts. It has no Electron or MCP dependency.

The current folder importer processes one bounded file at a time inside one outer
SQLite transaction. Cancellation or a failure rolls the whole import back, while
a failed refresh leaves the previous complete snapshot visible.

### `apps/mcp-server`

Provides a thin local stdio adapter. It exposes only stable product-level operations rather than database or filesystem primitives. The initial surface is `search` and `fetch`.

Each server instance keeps a bounded cache of document and chunk IDs issued by a
successful search. `fetch` denies IDs that were not issued on that connection,
then rechecks the current vault state in the core.

### `apps/desktop`

Provides end-user onboarding, folder selection, source health, local search, privacy controls, and AI-client configuration. It calls the core through a narrow application service boundary so the desktop shell can be replaced.

The sandboxed renderer receives narrow IPC methods only. Codex configuration is
read and changed in the main process; the renderer sees the proposed managed
block and status, never the rest of the user's configuration. Existing files are
backed up before replacement, and disconnect removes only the marked block.

### `packages/connector-sdk`

Defines connector capability manifests and normalized document events. Connectors never receive direct database access.

## Canonical and derived data

Canonical:

- authorized source snapshot or reference;
- normalized content;
- provenance and authorship;
- source and document revisions;
- user annotations and collection policy;
- deletion tombstones.

Derived and rebuildable:

- chunks;
- lexical indexes;
- embeddings and vector indexes;
- reranker scores;
- retrieval caches.

## Retrieval baseline

The first implementation uses SQLite FTS5. Dense retrieval is deliberately postponed until it beats the lexical baseline on an agreed multilingual fixture set. This prevents an unmeasured model download and hardware burden from becoming an architectural requirement.

Access filtering must happen before candidates are returned. Post-retrieval filtering is a defense-in-depth check, not the primary authorization control.

## MCP compatibility

The local MVP uses stdio because it avoids a listening network port and is supported by desktop MCP hosts. The server writes protocol messages only to stdout and diagnostics only to stderr.

Remote Streamable HTTP and OAuth are separate later milestones. They introduce public endpoint, identity, token-audience, tenant-isolation, and operational requirements and must not be inferred from the local implementation.

Official OpenAI documentation confirms local stdio and Streamable HTTP MCP server support and shared host configuration for the desktop app, Codex CLI, and IDE extension: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>.

## Desktop technology decision

The initial implementation uses Electron and TypeScript because Node.js is available in the development environment and the MCP SDK and ingestion pipeline can share one runtime. The core remains UI-independent. A Tauri migration is justified only if measured installer size, memory, or startup costs exceed published hardware targets enough to offset the additional Rust and sidecar complexity.
