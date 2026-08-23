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
- One launch-time `OWNCONTEXT_ALLOWED_COLLECTION` grant (currently `default`
  in desktop-managed launches), with requests for other collections denied.
- Codex and Claude configuration examples plus a protocol smoke test.

Acceptance:

- A real MCP client can initialize the server, list both tools, search fixture content, and fetch only an ID previously issued by the vault.
- Protocol stdout contains JSON-RPC only; diagnostics use stderr.

Boundary: returned rows and issued IDs are collection-scoped, but the current
vault uses one global FTS table. Candidate work, cache/resource effects, and
timing are not yet proven to be non-interfering across collections; that remains
a Milestone 6 public-release gate.

## Milestone 3 — Consumer desktop alpha

Status: in progress — the developer alpha, content-free folder preflight,
built-in sample onboarding, source-removal flow, reversible Codex configuration,
user-scoped Claude Code configuration, and an unsigned Windows x64 Squirrel
developer-preview installer are implemented. The packaged GUI smoke now follows
the built-in sample through search and the read-only AI Connections preview, and
a read-only Windows alpha workflow verifies a source-bound draft release bundle
without creating a public release. A clean-machine Setup install/uninstall
exercise, actual packaged client-connection mutation, non-developer usability
evidence, a signed public candidate, and a verified update channel remain
outstanding.

Deliverables:

- Electron desktop shell with a replaceable core boundary.
- Folder picker, bounded content-free scope preview, single-use main-process
  confirmation, stale-folder refusal, import progress, source health, local
  search, source removal, and result provenance.
- Main-process-only built-in sample materialization with virtual
  `owncontext-sample://library/v1/` provenance; the renderer supplies neither a
  path nor a provenance override.
- AI Connections screen that previews and reverses Codex and Claude Code
  configuration changes without returning unrelated client configuration to the
  renderer.
- Claude Code user-scope setup that respects an absolute
  `CLAUDE_CONFIG_DIR`; persistent override-target tracking across updater and
  uninstaller environments remains release work. Claude Desktop Extension
  support remains planned.
- A fixed `default` collection grant in each managed MCP launch, with other
  collection requests denied. Collection choice, expiry, and access-history UI
  remain planned.
- Privacy copy that distinguishes offline mode from cloud-AI excerpt transfer.
- Two-step source removal with stale-confirmation protection and a persistent,
  content-free logical deletion receipt.

Acceptance:

- A non-developer can install, review what a folder scan will include and
  exclude, import it, find a document, and configure one supported MCP client
  without a terminal or API key.
- Configuration changes are reversible.

## Milestone 4 — Portable context assets

Status: in progress — source-level atomic lineage purge, FTS5 secure-delete,
content-free receipts, and the desktop confirmation flow are implemented and
prototype-tested. Portable export/import and deletion coverage for other asset
classes remain planned.

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
- Draft application-payload notices, SPDX SBOM, checksums, and constrained
  outer-installer transform provenance are implemented. A draft outer bundle
  now binds the Setup, `.nupkg`, `RELEASES`, compliance evidence, source commit,
  lockfile, packaged synthetic Windows key-envelope evidence, and Authenticode
  status; it remains explicitly non-public. The core storage interface and a
  packaged async Electron `safeStorage` round trip are prototype-verified. A
  bounded read-only header/WAL parser requires matching WAL mode, preserves a
  stopped future-schema main/WAL fixture exactly, and the key smoke rejects byte
  and UTF-16 plaintext no-op wrappers. The real DB/FTS/WAL/backups are still
  plaintext; atomic
  probe/open under an external writer, independent DPAPI evidence, native
  encrypted storage, broker/bridge isolation, signed updates, complete
  maker-layer license evidence, and parser isolation remain release work.
- Keep build hosts isolated while the stable Electron Forge dependency tree has
  unresolved archive/extraction advisories; accept an upgrade only after the
  complete Windows make and smoke matrix passes.
- Cross-vault leakage, prompt-injection impact, deletion, export, and log regression suites.
- Handle-relative folder traversal, or an equivalently reviewed native boundary,
  that proves ancestry from the selected root under concurrent rename and
  reparse-point changes; the current pathname checks remain fixture-only.
- Collection-partitioned FTS candidate generation, or release evidence that
  global-candidate work, caches, resource use, and timing do not create an
  unacceptable cross-collection side channel.
- Encryption, bounded retention, discovery, and deletion for complete Claude
  configuration backups, which may contain unrelated secrets and currently can
  accumulate beside the source file.
- Windows DACL-preserving and external-race-safe AI configuration mutation,
  including tested recovery and persisted custom-target revocation.
- Authenticated client-launch discovery: supported-version checks plus verified
  binary source, publisher/signature, and hash policy for Codex and Claude.
- Signed Claude Desktop Extension (`.dxt`) packaging after its separate
  connection flow is implemented.

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
