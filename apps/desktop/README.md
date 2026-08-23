# OwnContext desktop developer alpha

This Electron workspace is the first end-user vertical slice. It can:

- select a local folder and atomically import UTF-8 Markdown and text files;
- show bounded, content-free import progress and cancel with a full rollback;
- list source health and document counts;
- search the local FTS index and inspect bounded document context;
- import a bounded, non-sensitive built-in sample library without exposing its
  physical application-data path to the renderer;
- remove a source through a stale-safe preview, native confirmation, atomic
  lineage purge, and persistent logical deletion receipt;
- preview, back up, apply, update, and remove one managed OwnContext block in
  Codex's `~/.codex/config.toml`; and
- preview, connect, refresh, and disconnect one managed, user-scoped OwnContext
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

## Built-in sample boundary

The first-run sample is materialized by the trusted main process under
Electron's application-data directory from a fixed, hashed file inventory. Its
user-facing document provenance uses the virtual
`owncontext-sample://library/v1/` root, not a physical user-data path. The
renderer invokes a parameterless sample-import action and cannot supply an
arbitrary path or provenance URI. This trusted override is reserved for the
built-in sample and does not create a general provenance-rewrite API for normal
imports.

## Windows x64 unsigned installer

On a Windows x64 build host, create installer-form developer-preview artifacts
with the official Electron Forge Squirrel.Windows maker:

```sh
npm run make --workspace @owncontext/desktop
```

The command compiles the monorepo, bundles the desktop main/preload code and the
complete read-only MCP runtime independently of npm workspace links, and then
uses one validated `OWNCONTEXT_FORGE_BUILD_ID` for the complete release flow. It
packages the application, generates and verifies draft compliance evidence,
runs the Squirrel maker against that exact package with `--skip-package`, and
finally runs the packaged smoke test. After those checks pass, it generates and
re-verifies a source-bound draft release bundle. Outputs are created under a
unique `apps/desktop/out/unsigned-*` directory.

The generated preview has no payment or license-key gate and does not require
Node.js on the target Windows x64 machine. That technical ability to make and
run a free EXE does not grant public redistribution rights while the project
license is unresolved.

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
reviewed metadata, payloads, and padding. The setup version resource is pinned;
the execution stub's resource keys and bytes must come from the verified
packaged application executable. NuGet product XML is either byte-pinned or
matched to a canonical form with only bounded random identifiers. A
deterministic draft record is created
atomically under the build's `evidence` directory.

The same directory also receives `OWNCONTEXT-RELEASE-CANDIDATE.json`,
`OWNCONTEXT-RELEASE-SHA256SUMS`, and an exact copy of the source
`package-lock.json`. The candidate manifest binds the Setup EXE, `.nupkg`,
`RELEASES`, payload compliance files, maker provenance, Git commit, tracked
worktree state, project-license state, and Windows Authenticode result. It
deliberately records `publicRelease: false` and explicit blockers. It contains
no absolute local paths. This outer checksum is additional draft evidence, not
a public manifest or a signature.

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
`lib/net45/OwnContextDeveloperPreview_ExecutionStub.exe`, and package metadata
to the `.nupkg`, while setup/update bootstrap components live outside the
verified application payload. Complete license, SBOM/notices, and release
checksum coverage for that maker layer remain public-release gates.

Expected maker outputs include:

- `OwnContext-Developer-Preview-Unsigned-Setup.exe` — per-user Squirrel setup;
- `OwnContextDeveloperPreview-0.0.0-full.nupkg` — unsigned Squirrel package; and
- `RELEASES` — local Squirrel metadata, not an enabled update channel.

Every package also includes `UNSIGNED-DEVELOPER-PREVIEW.txt`. These artifacts
are deliberately unsigned, use no publisher or update configuration, and are
for private non-sensitive evaluation only. Do not publicly redistribute them:
the project license remains undecided. Windows can show Unknown Publisher or
SmartScreen warnings. This build target does not satisfy the public-release
security gates below.

`.github/workflows/alpha-ci.yml` repeats the complete check and make chain on a
Windows runner with read-only repository permission. It has no release or
attestation permission. The unsigned binary bundle is uploaded only when the
repository is private and is retained for three days; if the repository is
public, the workflow verifies the build without publishing its executable as a
workflow artifact.

The MCP connection deliberately sets `ELECTRON_RUN_AS_NODE=1` for the packaged
executable because a Windows GUI-subsystem Electron process does not provide a
reliable stdio transport to Codex. Consequently, the Electron `RunAsNode` fuse
must remain enabled for this preview. Disabling it without replacing the MCP
launcher with a separately packaged runtime will break the connection. The
packaged smoke test is the regression check for this constraint.

Squirrel installation creates the shortcut but does not connect Codex or Claude
Code. On an update, OwnContext refreshes each recognizable managed Codex or
Claude Code grant only if it still exists, so a user's opt-out is not recreated.
Uninstall removes only those recognizable managed grants before removing the
shortcut. The initial Codex and Claude Code connections remain explicit user
actions inside the running app.
Lifecycle failures are bounded and still terminate the Squirrel event process.

## Configuration safety

The renderer receives only the proposed OwnContext TOML structure with private
local paths redacted and a bounded status. It never receives the user's existing Codex configuration. The main
process refuses unmanaged OwnContext conflicts, malformed markers, non-UTF-8 or
oversized files, symbolic links, and concurrent changes. Before replacing an
existing regular file, it creates an exclusive timestamped backup beside it.
Disconnect removes only the marked block.

Claude Code is connected as the user-scoped `owncontext` MCP server. The service
respects an absolute `CLAUDE_CONFIG_DIR`, uses fixed CLI arguments without a
shell command string, refuses an unmanaged/conflicting `owncontext` entry, and
removes only an entry that still matches OwnContext's managed launch shape. The
renderer receives only the generated OwnContext JSON structure with private
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
OwnContext re-reads the configuration under the same 4 MiB limit. It reports a
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

Application-level vault and configuration-backup encryption, safe backup
retention, authenticated client-executable discovery, signed installers and
updates, parser process isolation, access-history UI, and signed Claude Desktop
Extension (`.dxt`) packaging remain release gates. Claude Desktop support is
planned, not an implemented connection in this alpha. Use non-sensitive fixture
data only. A cloud AI client can send retrieved excerpts to its configured model
provider even though storage and retrieval run locally. Returned provenance
metadata can also include titles, source paths, timestamps, and stable IDs.
