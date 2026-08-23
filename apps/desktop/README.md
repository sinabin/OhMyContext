# OwnContext desktop developer alpha

This Electron workspace is the first end-user vertical slice. It can:

- select a local folder and atomically import UTF-8 Markdown and text files;
- show bounded, content-free import progress and cancel with a full rollback;
- list source health and document counts;
- search the local FTS index and inspect bounded document context;
- remove a source through a stale-safe preview, native confirmation, atomic
  lineage purge, and persistent logical deletion receipt; and
- preview, back up, apply, update, and remove one managed OwnContext block in
  Codex's `~/.codex/config.toml`.

## Run from the repository

Requires Node.js 22.13 or newer.

```sh
npm install
npm run build
npm start --workspace @owncontext/desktop
```

The developer vault is stored under Electron's per-user application data
directory. Codex receives that exact absolute vault path in the managed MCP
environment; no vault path is accepted from renderer input.

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
finally runs the packaged smoke test. Outputs are created under a unique
`apps/desktop/out/unsigned-*/make` directory.

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
afterward. A separate launch with isolated temporary user data confirms that
the packaged renderer and preload bridge load in normal GUI mode.

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

The MCP connection deliberately sets `ELECTRON_RUN_AS_NODE=1` for the packaged
executable because a Windows GUI-subsystem Electron process does not provide a
reliable stdio transport to Codex. Consequently, the Electron `RunAsNode` fuse
must remain enabled for this preview. Disabling it without replacing the MCP
launcher with a separately packaged runtime will break the connection. The
packaged smoke test is the regression check for this constraint.

Squirrel installation creates the shortcut but does not connect Codex. On an
update, OwnContext atomically refreshes the managed Codex block only if it still
exists, so a user's opt-out is not recreated. Uninstall removes only that
managed block before removing the shortcut. Lifecycle failures are bounded and
still terminate the Squirrel event process.

## Configuration safety

The renderer receives only the proposed OwnContext TOML block and a bounded
status. It never receives the user's existing Codex configuration. The main
process refuses unmanaged OwnContext conflicts, malformed markers, non-UTF-8 or
oversized files, symbolic links, and concurrent changes. Before replacing an
existing regular file, it creates an exclusive timestamped backup beside it.
Disconnect removes only the marked block.

The renderer remains sandboxed with context isolation and Node integration
disabled. Its preload is emitted as one CommonJS file because sandboxed Electron
preloads do not support ESM imports.

## Important limitations

This is a developer alpha, not a packaged consumer release. Application-level
vault encryption, signed installers and updates, parser process isolation,
access-history UI, and signed Claude Desktop Extension packaging remain release
gates. Use non-sensitive fixture data only. A cloud AI client can send retrieved
excerpts to its configured model provider even though storage and retrieval run
locally.
