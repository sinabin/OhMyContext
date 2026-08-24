# Connector acquisition, legality, and lifecycle policy

Last updated: 2026-08-23

## Policy decision

OhMyContext permits every acquisition route that the project can reasonably establish as lawful and authorized for the intended use. “Technically accessible” is not the same as “permitted.” A connector must document its authority, platform constraints, data scope, and lifecycle before it can ship.

This is a product admission policy, not legal advice and not a universal declaration that a route is lawful in every jurisdiction. Where material uncertainty remains, the route is disabled by default until qualified review or a narrower implementation resolves it.

## Acquisition order

For the same useful data, implement the least privileged and most portable route in this order:

1. **Official export** — a file or archive the service intentionally lets the user export.
2. **Official read-only API** — documented endpoints with the narrowest read scopes and supported revocation.
3. **User-initiated capture** — an explicit capture of a page, selection, conversation, or browsing session the user is authorized to access.
4. **Other lawful route** — only after a written connector-specific review explains why the first three routes are unavailable or inadequate and how authorization, platform restrictions, rate limits, and third-party rights are respected.

Priority does not mean exclusivity. A lower-priority route may coexist when it preserves information an export or API omits, but the connector must show the difference to the user and avoid duplicate ingestion.

## Admission requirements

Every connector must satisfy all of the following before inclusion in an official build or signed registry.

### 1. User authority

- The user must own the source data, have created it, administer the relevant account or space, or otherwise have authority to retain and process it.
- Access to a page or account alone is not proof that bulk copying, redistribution, or perpetual retention is authorized.
- Shared workspaces, employer systems, schools, paid services, private groups, and confidential communications require an explicit warning that organizational and contractual rules may apply.
- A connector must never solicit another person's credentials, impersonate another person, or reuse authentication outside the source it was granted for.

### 2. Platform and route constraints

- Record the official export documentation, API documentation, applicable terms or policy location, scopes, and review date in the connector manifest.
- Follow published API scopes, quotas, rate limits, deletion signals, and attribution requirements.
- Do not bypass authentication, paywalls, CAPTCHAs, robots or anti-automation controls, technical access controls, geographic restrictions, or rate limits.
- Do not extract or persist session cookies as a substitute for a supported authorization flow.
- A platform rule, `robots.txt`, or public visibility is a compliance signal, not by itself a complete legal determination. Ambiguity triggers review; it does not authorize collection.

### 3. Data minimization and transparency

- Request only the fields and scopes needed for the user-selected capability.
- Show a pre-import preview containing source, route, account or workspace, included objects, exclusions, estimated size, source semantics, and known third-party data.
- Preserve stable provenance: source type, source identifier or URL, capture route, account or workspace where safe, author, created/modified/captured timestamps, and connector version.
- Mark whether content is authored by the user, authored by another person, mixed, or unknown. Never infer `authored_by_me` merely from possession.
- Provide source, collection, date, author, and sensitivity filters before MCP retrieval.

### 4. Revocation and deletion

- OAuth and API credentials use the narrowest read-only scope, live in the OS credential store, and are removed when the connection is revoked.
- A connector must document upstream deletion detection, local purge behavior, revision retention, credential revocation, and what happens when access expires.
- Unknown or lost authorization fails closed: stop synchronization, mark the source as requiring attention, and exclude newly inaccessible content from MCP results until the user resolves whether it may be kept as a lawful snapshot or must be purged.
- Purge follows lineage through normalized documents, revisions, chunks, indexes, caches, temporary files, and eligible backups, and produces a deletion receipt containing identifiers rather than content.

### 5. Security and reliability

- Parsers and connectors receive explicit file, network, time, redirect, archive-depth, decompression, and output-size limits.
- A connector may contact only declared hosts. A local import parser has no network access by default.
- Schema changes, unexpected redirects, authorization errors, ambiguous pagination, and partial exports fail closed and surface an actionable status.
- Fixtures must cover incremental import, duplicate detection, modification, deletion, revocation, malformed input, Unicode, and boundary sizes without containing live credentials or private user data.

## Third-party personal and copyrighted content

Personal archives often contain comments, messages, mentions, quoted material, or records about other people. OhMyContext therefore applies the following rules even when the primary account belongs to the user:

- Collect only what is necessary for the selected personal use and permitted by the acquisition route.
- Preserve third-party authorship; do not re-label other people's words as the user's knowledge or writing.
- Default mixed-author and third-party collections to private. The user must explicitly include them in an AI connection's access grant.
- Surface warnings for private messages, minors' data, health, financial, biometric, precise-location, workplace, education, and other sensitive categories when a connector can identify them without inspecting content remotely.
- Never send source content, queries, paths, contacts, or identifiers to project telemetry, connector analytics, training corpora, or a public registry.
- Do not provide bulk export or publishing features intended to redistribute third-party material. The portable `.ownctx` format is a private user-controlled backup, not a publication license.
- Support targeted exclusion and purge by source item, person or participant identifier when the source exposes a reliable identifier.

The product cannot determine every user's legal basis or confidentiality obligation. The UI must state this boundary and request confirmation for high-risk shared or third-party sources; a confirmation does not cure a route that the project has determined is unauthorized.

## Mirror and Snapshot semantics

Every source declares exactly one semantic mode. The mode is visible in source health, search provenance, export manifests, and deletion flows.

### Mirror

A Mirror tracks the source's current state through a continuing authorized connection.

- Intended for official APIs or folders with reliable stable identifiers and deletion detection.
- Additions and modifications update the searchable current revision.
- Upstream deletions create a tombstone and remove content from active search and MCP delivery on the next successful synchronization.
- Old source revisions are not retained indefinitely by default. Optional history requires a separate user choice and a documented lawful retention basis.
- If synchronization becomes partial or uncertain, source health becomes degraded and the connector must not report the mirror as current.
- Disconnect presents two explicit choices: convert the last complete state to a dated Snapshot, or purge the Mirror. There is no silent conversion or silent deletion.

### Snapshot

A Snapshot is an immutable, point-in-time import initiated by the user.

- Intended for export archives, selected files, and user-initiated page captures.
- It records `captured_at`, route, source version where available, and a content checksum.
- Later upstream edits or deletions do not silently rewrite the Snapshot because no continuing connection exists.
- Reimporting the same bytes is idempotent; a changed import creates a new dated Snapshot or a new revision according to the importer's documented behavior.
- The UI must warn that an upstream deletion will not propagate and provide local purge controls.

Converting a Snapshot into a Mirror is allowed only when a connector can match stable source identifiers without merging unrelated content. Converting a Mirror to a Snapshot requires explicit confirmation and records the conversion time.

## User-initiated capture boundary

A capture is user initiated only when the user performs a clear action for the current page, selection, bounded list, or disclosed session.

Allowed capture behavior includes:

- capturing the active page or selected content after preview;
- following a user-confirmed, bounded list of links on the same authorized source; and
- resuming a disclosed capture job with the same bounds and rate limits.

It does not include hidden background browsing, open-ended site crawling, enumerating other users or private spaces, defeating anti-automation measures, or uploading browser cookies to an OhMyContext service. Browser integrations must display the active origin and requested scope before capture.

## Connector manifest

An official connector package must declare at least:

```yaml
id: stable-connector-id
version: semver
maintainer: project-or-verified-publisher
route: official_export | official_read_api | user_initiated_capture | reviewed_other
source_semantics: mirror | snapshot
declared_hosts: []
permissions: []
data_classes: []
third_party_content: none | possible | expected
authored_by_me_evidence: explicit_field | account_match | unavailable
terms_location: string
terms_reviewed_at: date
territory_constraints: []
incremental_sync: true | false
upstream_deletion_detection: true | false
revocation_behavior: string
local_purge_behavior: string
limits: {}
fixture_suite: path
```

The manifest is descriptive evidence, not self-certification. Official distribution also requires code review, deterministic fixtures, dependency review, and package signing once the signed registry exists.

## Capability and risk states

| State | Meaning | Runtime behavior |
| --- | --- | --- |
| Approved | Route, permissions, lifecycle, and tests satisfy this policy | Enabled with disclosed scope |
| Limited | Lawful only for documented accounts, territories, objects, or modes | Enforce limits in code and UI |
| Review required | Terms, authority, third-party scope, or implementation remains materially ambiguous | Disabled in official builds by default |
| Blocked | Requires bypass, excessive privileges, credential misuse, or an unauthorized acquisition route | Must not ship or be listed |
| Deprecated | Previously approved route changed or is no longer supported | Stop new connections; preserve export/purge access; notify existing users |

Connector status must be remotely revocable only through a signed policy update. A remote block may stop future acquisition, but it must not erase a user's local data without an explicit local purge decision or a binding requirement handled through the incident process.

## Change and incident handling

- Re-review a connector when its scopes, hosts, API version, terms location, capture technique, ownership, or dependency trust changes.
- A new permission is a breaking capability change and requires fresh user consent.
- On suspected unauthorized acquisition, disable further synchronization, preserve minimal local diagnostic evidence, notify affected users, and provide export or purge guidance appropriate to the case.
- Never conceal a platform block by rotating endpoints, user agents, credentials, or rate-limit identities.

## Milestone application

- Milestone 1 folder ingestion is a user-selected Snapshot unless a later folder-watching Mirror is explicitly implemented.
- Milestone 4 implements the schema and UI distinction between Mirror and Snapshot.
- Milestone 5 admits Notion export ZIP, RSS/Atom, HTML, JSON, and CSV only after each has a completed manifest and fixture suite. Read-only Notion OAuth follows the stable Snapshot importer.
- No current connector is approved merely because this policy exists; approval requires implementation evidence.

## Decision boundary

`[Information and jurisdiction boundary]` Connector lawfulness can depend on source terms, data category, account role, territory, and intended processing. This policy resolves the default acquisition order and non-negotiable product constraints, but it does not establish a legal result for an unreviewed service. That uncertainty blocks only the affected connector or capability, not lawful local imports or the rest of the core product.
