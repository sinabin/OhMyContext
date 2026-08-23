# Implementation plan

Last updated: 2026-08-23

## Objective

Deliver a globally usable, local-first desktop product that lets a non-developer import personal data, search it with provenance, and expose only authorized results to Claude, Codex, and other MCP-compatible clients.

## Delivery strategy

Work proceeds in independently testable vertical milestones. A milestone is committed only after its stated verification passes. Product documentation must distinguish implemented behavior from planned behavior.

## Milestone 0 — Repository and product contract

Status: completed

Deliverables:

- Git repository and Node.js workspace.
- Confirmed product decisions and licensing hold.
- Windows x64 platform boundary and a deferred, evidence-based measurement plan.
- Connector legality and capability policy.
- Architecture and security boundaries.

Acceptance:

- A new contributor can identify scope, prerequisites, milestones, and unresolved release gates without private context.
- No document claims unimplemented encryption, dense retrieval, or remote sync.

## Milestone 1 — Local vault vertical slice

Status: completed

Deliverables:

- SQLite schema for sources, documents, revisions, chunks, and retrieval events.
- Deterministic IDs and content hashes.
- Safe folder ingestion for UTF-8 `.txt` and `.md` files.
- Structure-preserving text chunking.
- FTS5 keyword search with collection and date filters.
- Stable document fetch with bounded neighboring context.
- Unit and integration tests, including deletion and path-boundary cases.

Acceptance:

- Re-importing unchanged data creates no duplicate document or revision.
- Modified content creates a new revision and replaces searchable chunks.
- Deleted content cannot be returned after a purge.
- Search results include stable IDs, title, source URI, timestamps, and snippets.

## Milestone 2 — Read-only MCP adapter

Status: completed

Deliverables:

- Local `stdio` MCP server.
- Focused `search` and `fetch` tools with structured outputs.
- `readOnlyHint: true` and `openWorldHint: false` annotations.
- No arbitrary path, URL, SQL, sync, or delete parameters.
- Codex and Claude configuration examples plus a protocol smoke test.

Acceptance:

- A real MCP client can initialize the server, list both tools, search fixture content, and fetch only an ID previously issued by the vault.
- Protocol stdout contains JSON-RPC only; diagnostics use stderr.

## Milestone 3 — Consumer desktop alpha

Status: in progress — the developer alpha and an unsigned Windows x64 Squirrel
developer-preview installer are implemented. A clean-machine install/uninstall
exercise, a signed public candidate, and a verified update channel remain
outstanding.

Deliverables:

- Electron desktop shell with a replaceable core boundary.
- Folder picker, import progress, source health, local search, and result provenance.
- AI Connections screen that previews configuration changes and keeps backups.
- Privacy copy that distinguishes offline mode from cloud-AI excerpt transfer.

Acceptance:

- A non-developer can install, import a folder, find a document, and configure one supported MCP client without a terminal or API key.
- Configuration changes are reversible.

## Milestone 4 — Portable context assets

Status: planned

Deliverables:

- `.ownctx` export with manifest, normalized Markdown, JSONL metadata, assets, and checksums.
- Round-trip import tests.
- Mirror versus Snapshot source semantics.
- Complete lineage-based purge and deletion receipt.

Acceptance:

- Export to a clean vault preserves fixture documents, provenance, user annotations, and collection boundaries.
- Credentials, local secrets, and audit payloads are never exported.

## Milestone 5 — Global connector beta

Status: planned

Deliverables:

- Notion export ZIP, RSS/Atom, and generic HTML/JSON/CSV importers.
- Connector SDK with permission manifest, fixtures, timeouts, size limits, and health checks.
- Read-only Notion OAuth only after the snapshot importer is stable.
- Signed connector registry design.

Acceptance:

- Every connector has a documented lawful acquisition route, revocation behavior, deletion semantics, and deterministic fixture suite.
- Unsupported or unauthorized routes fail closed.

## Milestone 6 — Retrieval and security release gates

Status: planned

Deliverables:

- Multilingual lexical benchmark and optional local dense retrieval.
- Encryption for database, indexes, temporary files, and backups.
- Draft application-payload notices, SPDX SBOM, and checksums are implemented;
  OS keychain integration, signed updates, complete outer-installer provenance,
  and parser isolation remain release work.
- Cross-vault leakage, prompt-injection impact, deletion, export, and log regression suites.

Acceptance:

- Dense retrieval ships only if it materially improves the agreed multilingual benchmark over FTS.
- No unauthorized canary is returned in the full access-control test corpus.
- Any published Windows performance or hardware claim is reproduced on the named measured device and corpus.

## Commit policy

- `chore:` repository, tooling, and non-product maintenance.
- `docs:` product and engineering contracts.
- `feat:` user-visible or externally callable capability.
- `test:` standalone verification additions.
- `fix:` behavior corrections.

Do not combine an incomplete milestone with unrelated work. Each milestone commit records the verification command in its message body or accompanying changelog entry.
