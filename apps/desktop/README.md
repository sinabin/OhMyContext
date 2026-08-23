# OwnContext desktop developer alpha

This Electron workspace is the first end-user vertical slice. It can:

- select a local folder and atomically import UTF-8 Markdown and text files;
- show bounded, content-free import progress and cancel with a full rollback;
- list source health and document counts;
- search the local FTS index and inspect bounded document context; and
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
unresolved, not public-release clearance. The smoke test verifies the unpacked
evidence, checks that all three files are embedded in the `.nupkg`, starts the
packaged executable in Electron's Node-compatible mode with the bundled MCP
CLI, imports a temporary fixture into a SQLite/FTS vault, searches it, fetches
the document using the IDs issued by that search, and removes the fixture
afterward. A separate launch with isolated temporary user data confirms that
the packaged renderer and preload bridge load in normal GUI mode.

The `.nupkg` check compares the embedded compliance files with the verified
unpacked files by byte length and SHA-256. The smoke does not yet independently
extract the setup executable's embedded PE payload; that outer-container check
remains a public-release evidence gate.

This evidence covers the unpacked application payload, not every maker-added
byte. Squirrel adds `lib/net45/squirrel.exe`,
`lib/net45/OwnContextDeveloperPreview_ExecutionStub.exe`, and package metadata
to the `.nupkg`, while setup/update bootstrap components live outside the
verified application payload. Their complete license/provenance inventory and
checksum coverage remain public-release gates.

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
