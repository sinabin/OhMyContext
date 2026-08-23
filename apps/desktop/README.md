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
