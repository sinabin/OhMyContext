# Security and privacy model

Last updated: 2026-08-23

## Current status: developer alpha

OwnContext now has a runnable developer alpha. Automated prototype tests cover
atomic import and cancellation, selected path and symlink boundaries, revision
and document/source purge behavior, persistent content-free source deletion
receipts, collection/date filtering, query-text minimization, one launch-time
allowed MCP collection, read-only MCP input and issued-ID boundaries, stdio
framing, trusted main-process sample provenance, and reversible Codex and Claude
Code configuration edits. The Electron window is built with renderer sandboxing,
context isolation, a CommonJS preload bridge, no Node integration, and a
restrictive local content security policy. Main-process IPC accepts only the
expected local main frame, renderer navigation and new windows are blocked, and
source purge receives an independent native final confirmation.

This is not evidence that the product is safe for sensitive personal data.
Application-level encryption, complete parser isolation, user-selected and
expiring per-client grants, global-FTS side-channel isolation, safe lifecycle for
whole Claude configuration backups, authenticated AI-client executable
discovery, signed packaging and updates, comprehensive filesystem adversarial
coverage, and packaged-release validation remain unimplemented or unverified.

The core now requires an explicit storage provider and labels the only shipped
`node:sqlite` implementation as `plaintext-development`. A separate packaged
Windows x64 smoke has verified async Electron `safeStorage` wrapping and
reopening of a synthetic 32-byte key in a strict envelope, including rejection
of no-op wrappers whose decoded payload exposes tested raw, UTF-8, UTF-16, or
UTF-32 key encodings. A bounded read-only database-header/WAL parser only uses a
WAL when both database mode bytes declare WAL, accepts a stable zero-byte WAL as
having no frames, fails closed on mismatched sidecars, and rejects a stopped
crash-style WAL from a future schema without changing the original main/WAL
inventory or bytes.
Neither change keys the real database: SQLite, FTS, WAL, temporary state, and
whole configuration backups remain plaintext. The compatibility probe and real
open are not atomic against a concurrent external writer. The UI continues to
report encryption as not implemented, and the public encryption gate remains
open.

Security status uses three labels:

- **Designed** — behavior is specified but not implemented.
- **Prototype verified** — an automated test demonstrates the behavior in a development build; this is not a release claim.
- **Release gate passed** — the control and its failure tests pass on the packaged release candidate and evidence is recorded.

Only the last status supports a public security claim.

## Security objectives

OwnContext must:

1. keep source content, credentials, queries, and indexes local unless the user performs a disclosed transfer;
2. prevent one source, collection, AI connection, or vault from reading another without an explicit grant;
3. treat imported text and metadata as untrusted data, never as instructions;
4. preserve provenance so a result can be traced to the exact authorized source revision;
5. make revocation, purge, export, and external AI disclosure visible and testable;
6. resist malformed files, path traversal, archive bombs, connector abuse, and update or dependency tampering; and
7. recover safely from interruption without returning stale, deleted, or partially committed data.

## Assets

Protected assets include:

- original and normalized documents, revisions, chunks, attachments, annotations, and provenance;
- SQLite databases, FTS or future dense indexes, write-ahead logs, temporary files, backups, and exports;
- source credentials, OAuth refresh tokens, AI-client configuration, connection grants, and encryption keys;
- search queries, returned excerpts, stable identifiers, collection membership, audit events, and deletion receipts; and
- application, connector, update, and registry signing material.

Document titles, file paths, source URLs, contact names, collection names, and access patterns are sensitive metadata even when document bodies are encrypted.

## Trust boundaries and data flow

```text
[Local files / exports / remote source]
                  |
        untrusted connector/parser
                  |
      validation + provenance boundary
                  |
       local vault and search indexes
                  |
       collection/access-policy gate
                  |
       local read-only stdio MCP
                  |
      Claude / Codex / another AI client
                  |
         optional external AI provider
```

The local operating-system account, OwnContext core, connector/parser processes, MCP client, external AI provider, update channel, and future sync service are separate trust boundaries.

The built-in sample is a special trusted-source path, not an untrusted renderer
import. The main process materializes a fixed, byte-verified inventory beneath
Electron's application-data directory and assigns the virtual
`owncontext-sample://library/v1/` provenance root. Renderer IPC accepts no
sample path or provenance URI, and the physical application-data path is not
returned to the renderer. This exception must remain unavailable to ordinary
imports and connector input.

AI-client configuration files and their backups are inside the local
filesystem trust boundary but are separate sensitive assets from the vault. In
particular, a Claude Code mutation currently creates a byte-for-byte backup of
the complete Claude configuration file. It can contain unrelated credentials or
metadata and a new adjacent backup can be created for each mutation. Renderer
previews expose only generated OwnContext JSON/status, not that file's unrelated
contents; this UI boundary does not mitigate plaintext backup residue. On
Windows, the alpha has not demonstrated that replacement files and adjacent
backups preserve or tighten a pre-existing DACL, and its file compare followed
by rename is not an OS-level compare-and-swap. Sensitive-data use and public
release therefore remain blocked on ACL-preserving writes, race-safe replacement,
and tested recovery.

“Local MCP” describes where retrieval executes. It does **not** mean returned
excerpts and provenance metadata remain local: a client may send titles, source
paths, timestamps, stable IDs, and text to its model provider. The alpha names
the destination, accessible collection, grant duration, and metadata categories.
The prototype now distinguishes desktop and launch-declared Codex, Claude Code,
or migrated legacy requests in a bounded local history. It exposes only request ID, time,
request type, client kind, and result count; it does not expose last-disclosed
document IDs or content. The client kind comes from the fixed managed-launch
environment, not tool input, but is not cryptographic proof that a provider
received or retained a response. Packaged external-client, spoofing, and
adversarial validation remain public-release gates.

## Adversaries and failure cases

The design addresses:

- a malicious or compromised document containing prompt injection, deceptive metadata, links, or oversized content;
- malformed files, path traversal, symlink escape, ZIP slip, archive bombs, parser vulnerabilities, and resource exhaustion;
- a connector requesting excessive permissions, contacting undeclared hosts, leaking credentials, or continuing after revocation;
- an MCP caller guessing identifiers, requesting arbitrary files or URLs, crossing collection boundaries, or abusing response size;
- accidental oversharing to an AI client or external model;
- stale revisions, incomplete synchronization, failed deletion, backup or temporary-file residue, and export leakage;
- a malicious dependency, connector, registry entry, installer, or update; and
- offline theft or copying of a powered-off device's vault files.

## Explicit non-goals and residual risk

OwnContext cannot promise protection against:

- malware or an administrator controlling the OS account while the vault is unlocked;
- a user intentionally copying, exporting, screenshotting, or disclosing authorized content;
- retention or secondary use by an external AI provider after the client sends an excerpt;
- a compromised source service before acquisition;
- recovery of previously written plaintext from storage media unless the underlying device encryption and hardware provide that guarantee; or
- legal authority to retain every item in a user-selected source.

These limits do not relax least privilege, encryption-at-rest, log minimization, or disclosure requirements. The product must explain the relevant boundary at the point of action.

## Required controls

### Ingestion and parser isolation

- Canonicalize every selected root and reject traversal, symlink, junction, hard-link, archive-entry, or case-normalization escapes outside it.
- Parse untrusted formats outside the privileged UI/core process with no network access by default and explicit CPU, memory, time, recursion, file-count, and output-size budgets.
- Verify archive paths before extraction, reject device files and executable side effects, and write temporary data only inside a per-job private directory.
- Commit a source revision atomically only after validation, hashing, chunking, and index updates succeed. Cancellation or process death retains the last committed vault.
- Imported content and metadata are labeled untrusted. Text resembling system prompts, tool calls, or instructions remains quoted source data.

### Vault and keys

- Encrypt document bodies, metadata, SQLite pages, FTS or dense indexes, write-ahead logs, temporary files, and eligible backups at rest before public release.
- Store or wrap encryption keys with the OS credential store. Never place tokens or keys in SQLite, logs, exports, command-line arguments, or MCP output.
- Use a reviewed, versioned encryption design and maintained cryptographic libraries; do not invent a cipher or claim that an encrypted filesystem alone provides application-level vault encryption.
- Locking the vault clears plaintext caches and closes MCP access. Key rotation and interrupted migration require tested recovery behavior.
- Best-effort deletion on SSDs is not secure erasure. Cryptographic key destruction and whole-device encryption are part of the deletion guidance, while lineage purge prevents content from remaining addressable by OwnContext.
- Source purge enables both SQLite core `secure_delete` and FTS5 `secure-delete`, removes target-linked retrieval-event rows, and verifies table-count and foreign-key postconditions before storing a receipt. The receipt asserts only logical non-addressability; it does not assert removal from WAL history, storage media, independent backups, or an external AI provider.
- Receipt re-verification is deliberately narrower than replaying the historical
  deletion: it checks that the target source remains absent and that current
  foreign-key and FTS chunk projections are internally consistent. It does not
  re-prove historical row counts or make the receipt cryptographically signed.

The Windows-first broker topology and per-vault key hierarchy are specified in
`ENCRYPTION_ARCHITECTURE.md`. The native encrypted-SQLite provider, secured
named-pipe helper, and implementation evidence remain undecided Milestone 6
release blockers; the design is not permission to store a public-release vault
in plaintext.

### Retrieval authorization

- Apply vault, connection, collection, source, sensitivity, authorship, and date authorization **before** candidate generation and ranking.
- Default deny outside the explicit launch grant. The current desktop starts a
  managed MCP connection only after user action and pins that process to one
  allowed collection, currently `default`. The standalone server refuses to
  start when `OWNCONTEXT_ALLOWED_COLLECTION` is missing or unsafe. It does not
  implement a zero-collection state. User-selected collections, multiple grants, and grant
  expiry remain target controls rather than current behavior.
- The current MCP layer forces `search` to its one launch-time allowed
  collection, rejects a conflicting requested collection, and permits `fetch`
  only for IDs issued on the same connection. Returned rows are filtered by
  collection before disclosure.
- The current vault nevertheless uses one global FTS virtual table. Candidate
  work, shared term structures, cache/resource effects, and response timing are
  not physically partitioned by collection. This means the prototype has not
  demonstrated side-channel non-interference even though its canary tests do not
  return denied rows. Candidate partitioning or adequate non-interference
  evidence is required before release.
- MCP exposes only bounded read-only `search` and `fetch`. It accepts no arbitrary filesystem path, URL, SQL, command, sync, delete, or connector parameter.
- Return opaque stable IDs. `fetch` may resolve only an ID issued from the same vault and authorized to the calling connection; it rechecks authorization rather than trusting a prior result.
- Enforce request, result-count, excerpt-size, neighboring-context, concurrency, and time limits.
- Authorization failures reveal neither content nor the existence of a protected item.

### MCP and AI disclosure

- Local MCP uses `stdio`; it opens no network listener in the initial product.
- Desktop-managed Codex and Claude Code launches carry the vault path and the
  fixed allowed collection from trusted main-process state; renderer input
  cannot replace them. Claude Code registration is user-scoped and respects an
  absolute `CLAUDE_CONFIG_DIR`. The alpha does not yet persist custom override
  targets across Explorer/Squirrel environment changes, so update or uninstall
  can miss a grant created from a shell-local override; target registration and
  multi-target revocation are public-release gates.
- Protocol stdout contains JSON-RPC only. Diagnostics go to stderr and are content-minimized.
- Tool metadata declares read-only, closed-world behavior, but annotations are not treated as an enforcement boundary.
- Each returned item includes provenance and an untrusted-content marker. OwnContext does not concatenate retrieved text into executable instructions.
- The UI distinguishes fully offline local search from a cloud-AI flow. The
  prototype displays bounded content-free activity attributed to the desktop,
  a Codex/Claude Code launch declaration, or an honest legacy label. The launch
  declaration is not an authenticated client identity. Audit rows and the UI exclude
  excerpt bodies, queries, titles, and paths. Clearing the local history does
  not retract any response already received or retained outside OwnContext. An
  open history screen requires explicit refresh to include new external-client
  activity. If an import or another writer prevents the audit insert, retrieval
  fails closed and returns no context rather than creating an unlogged disclosure.
- A v1/v2 upgrade securely trims excess legacy audit rows in restart-safe
  1,000-row transactions and requires a truncating WAL checkpoint between
  batches before the final v3 copy. A pinned reader pauses the upgrade without
  invalidating the old schema; closing other clients and reopening resumes it.
  The 100,000-row regression bounds temporary WAL growth and retained history,
  but no `VACUUM` is claimed and an existing main database file is not shrunk.
- Changing a connection's executable, destination, or requested permissions requires a new preview and consent.

### Connectors and credentials

- Follow `CONNECTOR_POLICY.md`; official export, narrow read-only API, and bounded user-initiated capture are preferred in that order.
- Credentials remain in the OS credential store and are available only to the connector instance that needs them.
- Declare and enforce outbound hosts, redirects, scopes, rate limits, and source semantics.
- Revocation stops acquisition immediately. Loss of authorization fails closed rather than silently serving newly inaccessible content.
- Connector packages and capability changes require review, signed distribution, and fresh consent for new permissions.

### Logging, telemetry, and export

- Telemetry is off by default and separately opt-in. Raw content, excerpts, queries, paths, URLs, titles, contact identifiers, credentials, and stable document IDs are prohibited telemetry fields.
- Production logs use event categories and random operation IDs, not document content. A user-generated diagnostic bundle has a preview and deterministic redaction.
- `.ownctx` export includes only the collections and asset classes selected by the user. It excludes credentials, keys, AI-client configuration, operational logs, audit payloads, and deleted content.
- Export manifests and checksums provide integrity, not confidentiality. An unencrypted export carries a blocking warning; encrypted portable export requires a separately reviewed design.
- A source purge deletes retrieval-event rows linked to that source before cascading its documents. Its retained receipt contains opaque identifiers, timestamps, and aggregate lineage counts, never document content, titles, paths, source URLs, or query hashes.
- Folder sources are snapshots acquired by an explicit user import. Removing a source does not create a permanent filesystem exclusion: explicitly adding the same folder later can recreate the same source ID. Receipt verification reports that state as `target-reintroduced`, and the desktop refreshes receipt state after every completed import.
- The current direct MCP process is outside the desktop's single-instance
  boundary. An already authorized or in-flight response can outlive the storage
  transaction, so the purge dialog warns that transferred or in-progress AI
  excerpts are outside its guarantee. Broker session invalidation and response
  linearization in `ENCRYPTION_ARCHITECTURE.md` are required before a stronger
  public deletion claim.

### Supply chain and updates

- Pin dependencies, review native modules and parser packages, generate an SBOM, scan release artifacts, and document reproducible build inputs.
- Sign desktop installers, application bundles, updates, connector packages, and registry policy. Reject missing, invalid, downgraded, or wrong-channel signatures.
- Update verification happens before execution and preserves a recoverable prior version. Database migrations require backup, rollback or forward-recovery tests, and authenticated version metadata.
- Project signing keys use restricted release automation and must not be stored in the repository or developer test fixtures.
- Treat the Codex or Claude executable selected for configuration as a
  supply-chain input. Bounded path/manifest discovery alone is insufficient for
  public release: supported version, canonical source, publisher/signature, and
  hash policy must be verified before invoking a discovered client binary.

## Control status by milestone

| Control area | First implementation target | Public-release requirement | Current status |
| --- | --- | --- | --- |
| Path boundaries, deterministic hashes, atomic import/cancel/delete behavior | Milestone 1 | Regression suite passes on packaged app | Prototype verified for current folder importer and source-purge fixtures |
| Collection-scoped retrieval and FTS isolation | Milestones 1 and 6 | Returned-row canaries plus candidate/cache/timing non-interference pass | Returned rows prototype-verified for one launch-time allowed collection; global FTS candidate work and side channels are not partitioned or verified |
| Read-only bounded `search`/`fetch`, search-issued IDs, stdio separation | Milestone 2 | Real-client protocol and authorization tests pass | Prototype verified with SDK client and real child process |
| Built-in sample provenance | Milestone 3 | Packaged IPC/path/provenance adversarial suite passes | Prototype verified for fixed inventory, virtual URI, and main-process-only path/override boundary |
| Connection preview, reversible configuration, cloud-transfer disclosure | Milestone 3 | Non-developer usability, packaged external-client history, ACL/race-safe recovery, and disclosure tests pass | Codex and user-scoped Claude Code configuration plus content-free client-attributed history are prototype-tested for non-sensitive fixtures; live external-client confirmation, override-target tracking, DACL preservation, atomic CAS, and whole-backup lifecycle unverified; Claude Desktop Extension planned |
| Export exclusions, checksums, lineage purge, deletion receipt | Milestone 4 | Round-trip and residue tests pass | Source-level logical purge and receipt prototype verified; portable export and complete residue coverage remain designed |
| Connector manifests, least privilege, revocation, host limits | Milestone 5 | Every shipped connector has fixture and policy evidence | Designed |
| Application-level encryption of DB/index/temp/backup and OS keychain | Milestone 6 | Required; plaintext release prohibited | Explicit plaintext-provider boundary and packaged synthetic OS-key envelope prototype verified; real DB/index/WAL/temp/backups remain plaintext |
| Parser process isolation and resource limits | Milestone 6 | Required for every untrusted format | Designed |
| Signed installers/updates/connectors, authenticated client executables, SBOM, release artifact checks | Milestone 6 | Required | Unsigned developer preview and draft artifact evidence exist; signing and client source/publisher validation remain designed |
| Cross-vault, injection-impact, deletion, export, and log suites | Milestone 6 | Required with zero unauthorized canary disclosure | Designed |

Passing an earlier prototype test does not waive a later packaged-release test.

## Mandatory adversarial tests

The release evidence must include at least:

1. **Access canaries** — unique markers in denied vaults, collections, sources, revisions, deleted items, logs, backups, and export-excluded fields; no marker may appear through search, fetch, MCP, diagnostics, export, or telemetry.
2. **Identifier abuse** — guessed, stale, cross-session, cross-connection, malformed, and high-volume IDs remain unavailable and do not reveal existence.
3. **Prompt injection** — documents containing fake system messages, MCP calls, data-exfiltration requests, encoded instructions, misleading metadata, and links are returned only as bounded quoted data and do not expand tool capability.
4. **Filesystem boundaries** — traversal, Unicode normalization, case collisions, symlinks, junctions, hard links, ZIP slip, nested archives, sparse files, and decompression bombs fail safely.
5. **Interruption and corruption** — forced termination and disk-full conditions at every import/migration phase preserve the last committed vault and leave no searchable partial revision.
6. **Deletion lineage** — purge removes addressability from documents, revisions, chunks, indexes, caches, temporary files, and eligible backups and emits a content-free receipt.
7. **Secret handling** — credentials and keys do not appear in process arguments, database pages, stdout/stderr, logs, crash reports, diagnostic bundles, exports, or telemetry fixtures.
8. **At-rest inspection** — with the vault locked and app stopped, a disk scan cannot recover protected fixture canaries from database, index, WAL, temporary, or backup files.
9. **Update tampering** — modified, unsigned, downgraded, replayed, or wrong-channel packages are rejected without running migration code.
10. **Cloud boundary UX** — representative non-developers can identify whether an excerpt stays local or is sent to a named external provider before enabling the connection.
11. **FTS non-interference** — denied-collection corpus size, terms, cache state,
    and query matches cannot produce a release-blocking timing, memory, I/O, or
    error distinction for an allowed connection; otherwise candidate generation
    is physically partitioned before release.
12. **AI configuration residue and integrity** — unrelated secret canaries in a
    Claude configuration never reach renderer previews; replacement and backup
    DACLs do not broaden access; external concurrent writes are never lost; and
    every whole-file backup has tested encryption, bounded retention, discovery,
    and deletion.
13. **Launcher and sample boundary** — shadowed, replaced, unsigned, wrong-source,
    or unsupported client executables are rejected; renderer requests cannot
    choose a sample filesystem path or provenance override, and no physical
    application-data path appears in sample provenance.

Security and integrity tests require zero unauthorized canary disclosures. Performance flakiness may be investigated; an access leak may not be averaged away.

## Public-release gates

A public binary, hosted update channel, or official connector registry is blocked until all of the following are true:

- the application-level encryption design is reviewed and passes at-rest tests for database, index, WAL, temporary files, and backups;
- OS credential-store integration and lock/key-rotation recovery pass on every supported OS;
- collection and connection authorization, read-only MCP boundaries, and cross-vault canary tests pass;
- FTS candidate generation is collection-partitioned, or candidate/cache/timing
  non-interference passes a documented release threshold;
- complete AI-client configuration backups are encrypted and have tested,
  bounded retention, discovery, and deletion behavior;
- AI-client configuration replacement preserves or tightens Windows DACLs,
  cannot overwrite an external concurrent write, tracks every supported
  `CLAUDE_CONFIG_DIR` target across update/uninstall environments, and exposes a
  tested recovery path;
- every invoked Codex and Claude binary passes supported-version, source,
  publisher/signature, and hash policy checks;
- parser isolation and malformed-input/resource-exhaustion tests pass for every enabled format;
- lineage purge and export-exclusion suites pass;
- installers, updates, connectors, and registry metadata are signed and tamper/downgrade tests pass;
- an SBOM and vulnerability-response process exist, with no unresolved release-blocking finding;
- privacy copy accurately distinguishes local storage from external AI transfer; and
- the project's software license has been selected as required by `PRODUCT_DECISIONS.md`.

Developer prototypes may precede these gates only when clearly labeled, restricted to non-sensitive fixtures, and not represented as secure personal-data storage.

## Incident and vulnerability handling

- `SECURITY.md` is the reporting entry point; reports involving possible content or credential exposure are treated as private.
- A suspected authorization, connector, update, or encryption failure pauses affected releases and distribution.
- Preserve content-minimized evidence, identify affected versions and boundaries, provide containment and purge/export guidance, rotate relevant signing or service credentials, and publish a post-incident account without user content.
- Security-sensitive remote disablement may stop future connector or update activity through signed policy, but local data is never remotely erased without an explicit local action or a separately documented binding requirement.

## Decision boundary

`[Verification limitation]` The controls marked Prototype verified have passed only
in the development workspace on the current Windows machine and deterministic
fixtures. An unsigned Windows x64 installer exists and has packaged smoke
coverage, but it has not passed a clean-machine consumer install/uninstall
exercise, the complete adversarial matrix, or signed-release validation. macOS
support and numeric hardware requirements are deferred rather than verified.
This does not block further local alpha development or free, no-key private EXE
evaluation with non-sensitive fixtures, but it blocks sensitive-data and public
security claims. Public distribution remains blocked by the release gates above,
including license selection. Protection against an already compromised unlocked
OS and an external AI provider's downstream handling remains outside the product
boundary even after those gates pass.
