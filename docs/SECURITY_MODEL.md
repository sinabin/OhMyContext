# Security and privacy model

Last updated: 2026-08-23

## Current status: design only

At Milestone 0, OwnContext has no executable product and therefore has **no implemented runtime security controls**. This document is a threat model and release contract. It must not be cited as evidence that encryption, sandboxing, access control, secure deletion, signed updates, or MCP isolation already exists.

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

“Local MCP” describes where retrieval executes. It does **not** mean retrieved excerpts remain local: when Claude, Codex, or another client sends them to a cloud model, those excerpts cross into that provider's trust boundary. The connection screen must name the destination, accessible collections, grant duration, and last disclosed document identifiers before the user enables it.

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

The exact encryption library and key hierarchy remain undecided. That decision is a Milestone 6 release blocker, not permission to store a public-release vault in plaintext.

### Retrieval authorization

- Apply vault, connection, collection, source, sensitivity, authorship, and date authorization **before** candidate generation and ranking.
- Default deny. A new AI connection has no collection access until the user grants it, and grants are visible, scoped, revocable, and optionally expiring.
- MCP exposes only bounded read-only `search` and `fetch`. It accepts no arbitrary filesystem path, URL, SQL, command, sync, delete, or connector parameter.
- Return opaque stable IDs. `fetch` may resolve only an ID issued from the same vault and authorized to the calling connection; it rechecks authorization rather than trusting a prior result.
- Enforce request, result-count, excerpt-size, neighboring-context, concurrency, and time limits.
- Authorization failures reveal neither content nor the existence of a protected item.

### MCP and AI disclosure

- Local MCP uses `stdio`; it opens no network listener in the initial product.
- Protocol stdout contains JSON-RPC only. Diagnostics go to stderr and are content-minimized.
- Tool metadata declares read-only, closed-world behavior, but annotations are not treated as an enforcement boundary.
- Each returned item includes provenance and an untrusted-content marker. OwnContext does not concatenate retrieved text into executable instructions.
- The UI distinguishes fully offline local search from a cloud-AI flow and records locally which document IDs and source ranges were disclosed. Audit records exclude excerpt bodies by default.
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

### Supply chain and updates

- Pin dependencies, review native modules and parser packages, generate an SBOM, scan release artifacts, and document reproducible build inputs.
- Sign desktop installers, application bundles, updates, connector packages, and registry policy. Reject missing, invalid, downgraded, or wrong-channel signatures.
- Update verification happens before execution and preserves a recoverable prior version. Database migrations require backup, rollback or forward-recovery tests, and authenticated version metadata.
- Project signing keys use restricted release automation and must not be stored in the repository or developer test fixtures.

## Control status by milestone

| Control area | First implementation target | Public-release requirement | Current status |
| --- | --- | --- | --- |
| Path boundaries, deterministic hashes, atomic revision/delete behavior | Milestone 1 | Regression suite passes on packaged app | Designed |
| FTS candidate filtering by collection and date | Milestone 1 | Cross-collection canary suite passes | Designed |
| Read-only bounded `search`/`fetch`, opaque IDs, stdio separation | Milestone 2 | Real-client protocol and authorization tests pass | Designed |
| Connection preview, reversible configuration, cloud-transfer disclosure | Milestone 3 | Non-developer usability and disclosure test passes | Designed |
| Export exclusions, checksums, lineage purge, deletion receipt | Milestone 4 | Round-trip and residue tests pass | Designed |
| Connector manifests, least privilege, revocation, host limits | Milestone 5 | Every shipped connector has fixture and policy evidence | Designed |
| Application-level encryption of DB/index/temp/backup and OS keychain | Milestone 6 | Required; plaintext release prohibited | Designed |
| Parser process isolation and resource limits | Milestone 6 | Required for every untrusted format | Designed |
| Signed installers/updates/connectors, SBOM, release artifact checks | Milestone 6 | Required | Designed |
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

Security and integrity tests require zero unauthorized canary disclosures. Performance flakiness may be investigated; an access leak may not be averaged away.

## Public-release gates

A public binary, hosted update channel, or official connector registry is blocked until all of the following are true:

- the application-level encryption design is reviewed and passes at-rest tests for database, index, WAL, temporary files, and backups;
- OS credential-store integration and lock/key-rotation recovery pass on every supported OS;
- collection and connection authorization, read-only MCP boundaries, and cross-vault canary tests pass;
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

`[Verification limitation]` Every runtime control in this document is unimplemented at Milestone 0. The design is sufficient to guide isolated prototype work, but not to accept sensitive production data or make security claims. Public distribution is blocked until the release gates above pass on packaged artifacts. Protection against an already compromised unlocked OS and an external AI provider's downstream handling remains outside the product boundary even after those gates pass.
