# OhMyContext desktop developer alpha

This Electron workspace is the first end-user vertical slice. It can:

- select a local folder, review a bounded content-free scope preview, and then
  atomically import eligible UTF-8 Markdown and text files;
- show bounded, content-free import progress and cancel with a full rollback;
- list source health and document counts;
- search the local FTS index and inspect bounded document context;
- import a bounded, non-sensitive built-in sample library without exposing its
  physical application-data path to the renderer;
- remove a source through a stale-safe preview, native confirmation, atomic
  lineage purge, and persistent logical deletion receipt;
- preview, back up, apply, update, and remove one managed OhMyContext block in
  Codex's `~/.codex/config.toml`; and
- preview, connect, refresh, and disconnect one managed, user-scoped OhMyContext
  entry for Claude Code.

## Run from the repository

Requires Node.js 22.13 or newer.

```sh
npm install
npm run build
npm start --workspace @owncontext/desktop
```

The developer vault is stored under Electron's per-user application data
directory. Codex and Claude Code receive that exact absolute vault path and the
single allowed collection, currently `default`, in the managed MCP environment;
no vault path or collection grant is accepted from renderer input. The MCP
server rejects a search request that names any other collection and permits
`fetch` only for IDs issued on that connection.

## Localized interface

The packaged desktop UI supports English, 한국어, 日本語, and 简体中文. On first
launch it detects the operating-system locale, falls back to English for
unsupported languages, and stores the user's selection locally. The selection
updates the renderer, Electron menus, folder picker, confirmation dialogs,
errors, accessibility labels, and locale-aware dates, numbers, sizes, and
plural messages. User documents and technical identifiers such as `search` and
`fetch` intentionally remain unchanged.

## Folder import boundary

The main process owns the native folder picker and retains the canonical path
during preflight. At that stage the renderer receives only the folder label,
aggregate supported/excluded/too-large/link/read-error counts, extension totals,
and bounded relative-path issue examples. Symbolic links, junctions, and
multiply-linked files are excluded. A scan enumerates at most 100,000 filesystem
entries by default. The preflight response contains no selected absolute path,
raw operating-system errors, or file content. After a confirmed import, the
renderer does receive persisted `file:` provenance URIs for source management
and search citations; those paths can therefore be shown to the local user.

Confirmation uses a cryptographically random, sender-bound, memory-only token
that expires after five minutes and is single use. A new scan, cancellation,
window close, or expiry drops the associated prepared scope. The core rescans
before any vault write and compares canonical entry metadata plus SHA-256 hashes
of valid supported files. A mismatch in that approved inventory produces a
stale-scan result and leaves the database unchanged. Zero-candidate scans cannot
be confirmed, and imports never modify the original files.

The current Node implementation performs pathname-based traversal and checks
the selected root identity before directories and again before commit. These
checks detect observed changes but are not a handle-relative, atomic proof of
ancestry against a malicious concurrent rename or reparse-point swap. Treat
hostile or actively mutated folders as outside this developer preview's security
boundary. Handle-relative traversal (or an equivalently reviewed native boundary)
remains a public-release gate; use non-sensitive fixtures meanwhile.

## Built-in sample boundary

The first-run sample is materialized by the trusted main process under
Electron's application-data directory from a fixed, hashed file inventory. Its
user-facing document provenance uses the virtual
`owncontext-sample://library/v1/` root, not a physical user-data path. The
renderer invokes a parameterless sample-import action and cannot supply an
arbitrary path or provenance URI. This trusted override is reserved for the
built-in sample and does not create a general provenance-rewrite API for normal
imports.

## Windows x64 Portable ZIP

On a Windows x64 build host, create the packaged application directory used by
the Portable ZIP release:

```sh
npm run package:win --workspace @owncontext/desktop
```

The command compiles the monorepo, bundles the desktop main/preload code and the
complete read-only MCP runtime independently of npm workspace links, and then
uses one validated `OWNCONTEXT_FORGE_BUILD_ID` for the complete release flow. It
packages the application, generates and verifies draft compliance evidence,
runs the Squirrel maker against that exact package with `--skip-package`, and
finally runs the packaged smoke test. After those checks pass, it generates and
re-verifies a source-bound draft release bundle. Outputs are created under a
unique `apps/desktop/out/unsigned-*` directory.

The generated Portable ZIP has no payment or license-key gate and does not
require Node.js on the target Windows x64 machine. Authenticode signing,
installer packaging, and automatic updates are intentionally out of scope.
Windows may show an Unknown Publisher or SmartScreen warning; use
non-sensitive data and verify the GitHub release SHA-256 sidecar.

The unpacked application and the `.nupkg` both contain
`resources/compliance/THIRD_PARTY_NOTICES.txt`, `SBOM.spdx.json`, and
`SHA256SUMS`. They are explicitly draft evidence while the project license is
unresolved, not public-release clearance. The smoke test verifies the complete
unpacked regular-file payload and requires an exact path, byte-length, and
SHA-256 match for every corresponding `.nupkg` entry. Only the separately
inventoried Squirrel/NuGet layer may remain outside that mapping. It then starts
the packaged executable in Electron's Node-compatible mode with the bundled
MCP CLI, imports a temporary fixture into a SQLite/FTS vault, searches it, fetches
the document using the IDs issued by that search, and removes the fixture
afterward. A separate launch with isolated temporary user data uses the visible
GUI controls to import the built-in sample, run the suggested search, confirm a
sample-provenance result, open AI Connections, and confirm the Codex and Claude
Code cards plus the external-transfer warning. This preview is read-only: the
smoke does not connect either client or change its settings.

Central-directory archive names are checked without slash or case normalization, and inspection
has bounded compressed size, entry count, individual/total uncompressed size,
output buffering, and execution time. The three compliance files also retain
explicit named checks. Before Forge can load the maker, and again immediately
before make, the orchestrator pins every regular file installed under
`electron-winstaller@5.4.4` except its two declared mutable, non-input Squirrel
log paths; this includes its NuGet executable, template,
orchestration code, nested packages, bootstrap binaries, and assets. With maker
output required, the smoke repeats that check, requires an exact maker-directory
inventory and one valid `RELEASES` record, parses the setup PE, and
byte-compares its four embedded ZIP members with the emitted package, metadata,
approved update executable, and spinner. A raw ZIP walker requires contiguous
and matching local/central headers, recomputed CRC-32, no extra/comment/gap or
trailing bytes, and fixed non-path attributes. Fixed PE headers and sections must
retain their approved bytes, changed layout fields must equal values derived
from the resource size and alignments, and the resource tree permits only the
reviewed metadata, payloads, and padding. The setup version resource is bound
to the selected release profile's version and description;
the execution stub's resource keys and bytes must come from the verified
packaged application executable. NuGet content types are byte-pinned; product
XML is profile-bound and matched to a canonical form with only bounded random
identifiers. A
deterministic draft record is created
atomically under the build's `evidence` directory.

The generated NuSpec is also parsed as namespace-aware XML. Any `iconUrl`
expanded local name is rejected regardless of prefix, and the exact NuSpec root
namespace declaration is the only permitted HTTP(S) value. This prevents the
installer smoke from treating a namespace-prefix or namespace-URL-prefix trick
as offline metadata.

The same directory also receives `OWNCONTEXT-RELEASE-CANDIDATE.json`,
`OWNCONTEXT-RELEASE-SHA256SUMS`, and an exact copy of the source
`package-lock.json`. The candidate manifest binds the Setup EXE, `.nupkg`,
`RELEASES`, payload compliance files, maker provenance, Git commit, tracked
worktree state, project-license state, and Windows Authenticode result. It
deliberately records `publicRelease: false` and explicit blockers. It contains
no absolute local paths. This outer checksum is additional draft evidence, not
a public manifest or a signature.

Authenticode inspection holds the Setup file in a read-only, write/delete-
denying share mode while it computes SHA-256 and queries the signature. The
reported inspection hash must equal the maker-provenance hash, and the Setup is
hashed again afterward. Maker provenance is likewise parsed, validated, and
hashed from two matching reads of one handle, then rechecked after the signature
phase before that same record enters the bundle.

The key-storage evidence is opened only after real-path containment and regular
file checks, then its open-handle identity and final file state are compared.
Two matching bounded reads from that handle are required before the bytes are
schema-validated, sized, and SHA-256 hashed. The manifest therefore rejects an
observed in-place rewrite or parent-junction swap instead of validating one
generation while recording another.

This evidence covers the unpacked application payload and a constrained,
semantic maker transform from pinned inputs, but it is not bit-for-bit
reproducibility or complete maker-layer legal evidence. Root-hoisted build
dependencies remain governed by the lockfile rather than the installed-package
tree record, the excluded logs have no content provenance, and a hostile or
compromised build host is outside this proof.
The `.nupkg` payload and metadata are verified through central-directory
semantics; raw nupkg local-header equivalence and parser-differential safety
remain a public-release gate even though the enclosing Setup ZIP receives the
strict raw-structure checks above.
Squirrel adds
`lib/net45/squirrel.exe`,
`lib/net45/OhMyContextDeveloperPreview_ExecutionStub.exe`, and package metadata
to the `.nupkg`, while setup/update bootstrap components live outside the
verified application payload. Complete license, SBOM/notices, and release
checksum coverage for that maker layer remain public-release gates.

For local Forge smoke coverage, maker outputs include (these are not the
public distribution format):

- `OhMyContext-Developer-Preview-Unsigned-Setup.exe` — per-user Squirrel setup;
- `OhMyContextDeveloperPreview-0.0.0-full.nupkg` — unsigned Squirrel package; and
- `RELEASES` — local Squirrel metadata, not an enabled update channel.

Every package also includes `UNSIGNED-DEVELOPER-PREVIEW.txt`. The public
Portable ZIP carries the same deliberate unsigned and non-sensitive-data
boundary. Windows can show Unknown Publisher or SmartScreen warnings; this
distribution does not claim Authenticode or encrypted-vault security
certification.

`.github/workflows/portable-preview.yml` repeats the package chain on a
disposable GitHub-hosted Windows runner and publishes the Portable ZIP and
SHA-256 sidecar to a GitHub pre-release. It does not publish an installer,
Authenticode signature, or automatic update channel.

The MCP connection deliberately sets `ELECTRON_RUN_AS_NODE=1` for the packaged
executable because a Windows GUI-subsystem Electron process does not provide a
reliable stdio transport to Codex. The packaged child is now a stdio-to-named-
pipe bridge; the desktop main process keeps the encrypted vault open and serves
MCP requests through that same-user pipe. Consequently, the Electron `RunAsNode`
fuse must remain enabled for this preview. The packaged smoke test is the
regression check for this constraint.

Squirrel installation creates the shortcut but does not connect Codex or Claude
Code. On an update, OhMyContext refreshes each recognizable managed Codex or
Claude Code grant only if it still exists, so a user's opt-out is not recreated.
Uninstall removes only those recognizable managed grants before removing the
shortcut. The initial Codex and Claude Code connections remain explicit user
actions inside the running app.
Lifecycle failures are bounded and still terminate the Squirrel event process.

## Configuration safety

The renderer receives only the proposed OhMyContext TOML structure with private
local paths redacted and a bounded status. It never receives the user's existing Codex configuration. The main
process refuses unmanaged OhMyContext conflicts, malformed markers, non-UTF-8 or
oversized files, symbolic links, and concurrent changes. Before replacing an
existing regular file, it creates an exclusive timestamped backup beside it.
Disconnect removes only the marked block.

Claude Code is connected as the user-scoped `owncontext` MCP server. The service
respects an absolute `CLAUDE_CONFIG_DIR`, uses fixed CLI arguments without a
shell command string, refuses an unmanaged/conflicting `owncontext` entry, and
removes only an entry that still matches OhMyContext's managed launch shape. The
renderer receives only the generated OhMyContext JSON structure with private
local paths redacted and bounded status; it
never receives unrelated Claude configuration. Before any mutation of an
existing Claude configuration, the complete file is copied byte-for-byte to an
exclusive adjacent backup. That whole-file backup can include unrelated secrets
or account metadata and repeated mutations can accumulate backups. Encryption,
retention limits, discoverability, and deletion are therefore public-release
gates, not solved properties of this alpha. Windows DACL preservation and an
OS-level race-safe replacement primitive are also unverified: the current
compare-before-rename path is not claimed to be a filesystem compare-and-swap.
Direct refresh/revoke rejects duplicate JSON keys, non-safe integers, and
decimal/exponent numbers to avoid JavaScript numeric rewriting, but may normalize
whitespace and escape spelling. Custom `CLAUDE_CONFIG_DIR` targets are not yet
persisted across updater/uninstaller environment changes.

After the external Claude CLI exits, times out, or exceeds its output limit,
OhMyContext re-reads the configuration under the same 4 MiB limit. It reports a
successful connection only when the exact managed entry exists, every pre-existing
top-level value is unchanged, no additional MCP server appeared, and any new
top-level keys match the six bounded, non-executable bootstrap metadata shapes
observed from the locally tested Claude Code CLI. Any deletion, rewrite, unknown
grant, or unknown bootstrap field fails closed as `recovery_required`; the backup
name is shown for manual recovery. Codex and Claude snapshot comparisons first
reject a size change and then use a baseline-plus-one bounded handle read, so a
concurrent oversized file is not loaded without limit. This does not close the
documented OS-level compare-and-swap gate.

Claude executable discovery is bounded to supported local candidates, but the
alpha does not yet authenticate the executable's publisher, signature, hash,
provenance, or compatible CLI version. Those checks are required before public
distribution.

The renderer remains sandboxed with context isolation and Node integration
disabled. Its preload is emitted as one CommonJS file because sandboxed Electron
preloads do not support ESM imports.

## Important limitations

This is a developer alpha, not a packaged consumer release. Returned MCP rows
are filtered to the launch-time allowed collection, but the vault currently
uses one global FTS index: candidate work, cache effects, resource use, and
response timing are not yet fully partitioned by collection. Physical candidate
partitioning or an adequate non-interference test is a public-release gate.

The packaged target is Windows x64. macOS support and numeric
minimum/recommended hardware specifications remain deferred until packaged
measurements exist.

Folder import currently recognizes only valid UTF-8 `.md` and `.txt` files.
HTML, JSON, CSV, and other formats are reported as excluded and remain planned.
Re-import adds or revises files that are present, but it does not yet mirror
deletions from the source folder: a previously indexed document that disappears
from disk remains until its OhMyContext source is removed. Explicit mirror versus
snapshot semantics are a later milestone.

Application-level vault and configuration-backup encryption, safe backup
retention, authenticated client-executable discovery, signed installers and
updates, parser process isolation, release validation of per-client access
history, and signed Claude Desktop
Extension (`.dxt`) packaging remain release gates. Claude Desktop support is
planned, not an implemented connection in this alpha. Use non-sensitive fixture
data only. A cloud AI client can send retrieved excerpts to its configured model
provider even though storage and retrieval run locally. Returned provenance
metadata can also include titles, source paths, timestamps, and stable IDs.

The implemented Access history screen exposes only request time, request type,
managed client kind, and result count. Schema v3 stores no query or query hash,
document content, snippet, title, or path. The internal table retains opaque
document/chunk linkage IDs so source removal can also remove linked audit rows;
those IDs are not exposed through the renderer API. Older schema-v2 records are
labeled `legacy` instead of having a client guessed. Intact multi-result search
rows are reconstructed as one request; a legacy request may remain split if an
earlier source purge removed rows needed to prove the grouping. Clearing this local history cannot
retract context that an AI client or provider already received, and the client
label is managed-launch metadata rather than cryptographic provider attestation.
External-client activity does not live-update an already open screen, so the UI
provides an explicit refresh control and says so at the point of use.

Retrieval fails closed while the same vault is importing or whenever another
writer prevents the access-history insert. In that case no search or fetch
result is returned to the caller, and the error asks the client to retry after
the import or removal finishes. This preserves the rule that externally
returnable context must not bypass its local audit entry; seamless concurrent
retrieval remains future usability work.

Schema v3 intentionally does not make a still-running schema-v2 MCP process
write-compatible. After the desktop migrates the vault, an older process fails
its next audit insert without corrupting the v3 vault; restarting the AI client
loads the current managed launch. This fail-closed cutover is covered by a core
regression test, but seamless active-session upgrade remains a public-release
usability gate.

Before that upgrade copies history, excess v1/v2 rows are securely removed in
restart-safe 1,000-row transactions with a truncating WAL checkpoint between
batches. A reader that prevents a bounded checkpoint pauses the migration with
an instruction to close other OhMyContext clients and retry; the committed old
schema remains valid and the next launch resumes. A 100,000-row regression
fixture verifies that only the newest 10,000 physical rows survive and that WAL
peak growth stays bounded. This protects temporary free space but deliberately
does not run `VACUUM`, so it does not promise to shrink an already allocated
main database file. If another opener completes v3 between the initial version
read and a blocked checkpoint, the losing opener serializes a fresh version
read and adopts that completed schema instead of reporting a stale pause.

Non-packaged development launches still select the visibly labeled plaintext
development storage provider; there is no implicit storage fallback. Packaged
Windows x64 launches use the encrypted provider and brokered MCP route. A
separate Windows x64 developer candidate uses the exact pinned
`better-sqlite3-multiple-ciphers` 13.0.3 runtime, checks SQLite3 Multiple
Ciphers 2.4.0 / SQLite 3.53.4 plus ChaCha20, HMAC, and memory-only temp state,
and binds a first-run/same-process-reopen lifecycle to an async Electron
`safeStorage` key envelope. Its packaged main-process smoke creates the
encrypted vault, imports, searches and fetches a fixture, closes and reopens the same vault/key identity,
retrieves it again, and finds none of the tested UTF-8/UTF-16/UTF-32 canary
encodings in the database, present sidecars, envelope, or state journal.

That smoke is an isolated developer-candidate route and does not by itself
prove packaged clean-machine release readiness. Temporary-journal crash
recovery, directory durability, cross-process locking, DACLs, key rotation,
configuration-backup encryption, and the broker's packaged lifecycle evidence
remain public-release gates. A same-user concurrent directory writer can still
race the provider's post-open WAL path with a hard link.
The compatibility probe reads the main header and only applies checksum-valid
WAL frames when both database mode bytes declare WAL. It does not open SQLite or
create a plaintext copy, caps inspected WAL input at 256 MiB, and fails closed
on a mismatched WAL sidecar or rollback-journal recovery. A stable zero-byte WAL
created by a live reader is accepted as containing no frames so a bounded
migration can produce its explicit close-clients-and-retry result. Its check and
the real open are not atomic against a concurrent external writer.
