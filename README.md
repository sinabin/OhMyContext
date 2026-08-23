# OwnContext

OwnContext is a local-first personal context vault that turns user-controlled files and exports into cited, read-only context for MCP-compatible AI clients.

The developer alpha now previews an eligible local-folder inventory before it
atomically imports UTF-8 text and Markdown files, stores provenance in a local
SQLite vault, searches the collection, exposes bounded `search` and `fetch` over
a local MCP server, includes a non-sensitive built-in sample library, and
provides desktop flows for reversible Codex and Claude Code configuration.

It is not a public consumer release. Application-level encryption,
handle-relative or equivalently reviewed folder traversal, collection-isolation
side-channel validation, AI-client executable provenance checks, safe
configuration-backup retention, signed packaging and updates, parser isolation,
and license selection remain release gates. Use non-sensitive fixture data only.

## Product principles

- The canonical asset is the original and normalized document with provenance, not an embedding index.
- Local import and search work without an account, Docker, or an AI API key.
- Retrieved content is untrusted data and never grants permissions.
- MCP access is read-only in the MVP.
- Local storage does not imply that excerpts stay local when a cloud AI client requests them.
- Source removal and AI-client disconnect have developer-alpha flows. Portable
  export and complete revocation/deletion coverage across every asset class
  remain planned; the current alpha does not claim them as complete.

## Repository layout

```text
apps/
  desktop/       Consumer desktop application
  mcp-server/    Local stdio MCP adapter
packages/
  core/          Vault, ingestion, provenance, and retrieval
  connector-sdk/ Connector contracts and capability manifests (planned)
docs/            Product, architecture, security, and delivery plans
```

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run check
```

Launch the desktop developer alpha:

```bash
npm start --workspace @owncontext/desktop
```

The first development Electron invocation downloads its platform binary. An
unsigned Windows x64 developer-preview installer is now produced with
`npm run make --workspace @owncontext/desktop`; its users do not need Node.js.
The preview has no payment or license-key gate and is suitable only for private,
non-sensitive local evaluation. This is not a signed or publicly releasable
package, and no public-release claim is made while the security and licensing
gates remain open. A source-bound draft manifest and outer SHA-256 list now bind
the local Setup, Squirrel package, compliance evidence, Git commit, lockfile,
packaged synthetic Windows key-storage evidence, and Authenticode status. The
read-only Windows alpha workflow re-verifies this bundle but never creates a
GitHub Release; it uploads unsigned binaries only while the repository is
private.

The core now requires every caller to select a storage provider explicitly. The
only shipped provider is visibly identified as `node-sqlite-development` with a
`plaintext-development` security profile; there is no implicit plaintext
fallback. A separate encrypted-candidate entry point now requires an exact
32-byte `Buffer`, passes it only to a keyed provider open, requires positive
cipher and integrity attestation before schema access, closes on every
post-open failure, and never retries through the plaintext provider. This is a
fail-closed provider contract, not an encrypted implementation. The plaintext
provider's bounded, read-only compatibility parser checks the database
header and, only when both header mode bytes declare WAL, valid WAL frames
without opening SQLite. A stable zero-byte WAL created by a live reader is
treated as having no frames. A mismatched WAL sidecar or rollback journal fails
closed; a crash-style
main-plus-WAL fixture from a newer schema is rejected without changing the
original files. A packaged Windows x64 smoke also verifies a synthetic 32-byte
key round trip through Electron's asynchronous `safeStorage` API and rejects
wrappers that leave the tested raw, UTF-8, UTF-16, or UTF-32 key encodings
directly recoverable from the envelope. This is key-management foundation
evidence only: the real SQLite database, FTS index, WAL, temporary state, and
configuration backups are still plaintext, arbitrary reversible wrappers and
DPAPI identity are not independently excluded, and the probe/open boundary is
not yet atomic against an external writer.

## Implementation status

| Area | Status |
| --- | --- |
| Product, connector, platform, and security contracts | Complete baseline |
| Atomic local SQLite/FTS vault | Implemented and prototype-tested |
| Read-only local stdio MCP | Implemented and real-protocol tested |
| Desktop import, sample onboarding, search, source removal, access history, and Codex/Claude Code config | Developer alpha |
| Explicit storage-provider boundary and synthetic Windows key envelope | Prototype-verified; real vault remains plaintext |
| Portable `.ownctx`, global service connectors, encryption, signed release | Planned |

Each desktop-managed MCP launch is currently pinned to the single `default`
collection. Requests for another collection are rejected, and `fetch` accepts
only IDs issued by `search` on the same connection. This is a default-deny
boundary outside that launch-time grant, not the planned collection picker,
or grant expiry. The desktop now shows a bounded, content-free local access
history attributed to desktop, a Codex/Claude Code launch declaration, or an
honest legacy label;
it never displays queries, bodies, titles, document/chunk IDs, or paths in that
history. Client kind is fixed by the managed launch rather than tool input, but
it is not cryptographic proof of provider receipt or retention. Packaged external-client
compatibility is now checked with isolated temporary profiles: Codex must parse
the exact managed stdio record, and Claude Code must report the `owncontext`
block as connected while opening the packaged MCP against a temporary vault
that records zero search/fetch activity. The harness invokes only local
configuration-inspection subcommands and removes inherited credentials. It is
not a model-response, authenticated-client, or executable-publisher proof;
those adversarial validations remain public-release gates. Retrieval returns no
context if an import or another writer prevents its audit entry, and MCP returns
a content-free retry instruction. The current vault still uses one global FTS
index, so candidate work, cache effects, and response timing are not yet proven
to be isolated between collections; public release remains blocked on that
boundary.

Schema-v3 upgrade also bounds legacy history before copying it: excess v1/v2
rows are securely pruned in restart-safe 1,000-row batches with truncating WAL
checkpoints. If another reader pins the WAL, the upgrade pauses safely and can
resume after other OwnContext clients close. The bound is regression-tested at
100,000 rows; it limits temporary WAL growth but does not shrink the existing
main database file.

Claude Code connection is user-scoped and respects an absolute
`CLAUDE_CONFIG_DIR`. OwnContext previews only a path-redacted generated MCP
structure and status,
not unrelated Claude settings. Before a mutation, however, the current alpha
backs up the complete Claude configuration file beside the original. Those
backups can contain unrelated secrets and can accumulate, so encryption,
retention, and deletion behavior are public-release gates. Claude Desktop
Extension (`.dxt`) distribution remains planned.

The Claude connection postcondition preserves all existing top-level values,
permits only bounded non-executable bootstrap metadata observed from the locally
tested CLI, and rejects extra MCP grants or destructive rewrites. Codex and Claude
configuration snapshots are read with a fixed bound even if another process
replaces the file with an oversized one.

The alpha also does not yet prove Windows DACL preservation or OS-level
compare-and-swap safety for Claude configuration replacement, and it does not
persist shell-local `CLAUDE_CONFIG_DIR` targets across updater environments. Use
only non-sensitive fixtures until those release gates are closed.

The GitHub-hosted Windows workflow now contains a fail-closed lifecycle step
for silent Setup installation, installed GUI/MCP fixture smoke, managed client
configuration cleanup, and Squirrel uninstall. Its safety boundary is
statically tested and it cannot run on a self-hosted runner. The actual hosted
install/uninstall result remains unverified until that workflow runs; the
installer is intentionally not executed on the local development machine.

## Platform and hardware status

The development target and first packaged distribution target are Windows x64.
macOS support and numeric minimum/recommended hardware specifications are deferred.
No CPU, memory, storage, collection-size, or latency figure is a support claim
until it has been measured on the packaged build. See the
[platform and measurement plan](docs/HARDWARE_REQUIREMENTS.md).

Project licensing is intentionally deferred, and no candidate or license family
has been shortlisted. Until a license is selected and added, the repository is
not ready for public redistribution.

## Project contracts

- [Korean product brief](docs/PRODUCT_PLAN.ko.md)
- [Implementation milestones](docs/IMPLEMENTATION_PLAN.md)
- [Platform scope and measurement plan](docs/HARDWARE_REQUIREMENTS.md)
- [Connector acquisition policy](docs/CONNECTOR_POLICY.md)
- [Security and privacy model](docs/SECURITY_MODEL.md)
- [Windows-first encryption architecture](docs/ENCRYPTION_ARCHITECTURE.md)
- [License decision status](docs/LICENSE_DECISION.ko.md)
- [Release compliance evidence](docs/RELEASE_COMPLIANCE.md)
