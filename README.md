# OwnContext

OwnContext is a local-first personal context vault that turns user-controlled files and exports into cited, read-only context for MCP-compatible AI clients.

The developer alpha now imports local text and Markdown files atomically, stores provenance in a local SQLite vault, searches the collection, exposes bounded `search` and `fetch` over a local MCP server, and provides a desktop flow for reversible Codex configuration.

It is not a public consumer release. Application-level encryption, signed packaging and updates, parser isolation, and license selection remain release gates. Use non-sensitive fixture data only.

## Product principles

- The canonical asset is the original and normalized document with provenance, not an embedding index.
- Local import and search work without an account, Docker, or an AI API key.
- Retrieved content is untrusted data and never grants permissions.
- MCP access is read-only in the MVP.
- Local storage does not imply that excerpts stay local when a cloud AI client requests them.
- Portable export and user-facing revocation and deletion workflows remain
  planned; the current alpha does not claim them as complete.

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
This is not a signed or publicly releasable package, and no public-release claim
is made while the security and licensing gates remain open.

## Implementation status

| Area | Status |
| --- | --- |
| Product, connector, platform, and security contracts | Complete baseline |
| Atomic local SQLite/FTS vault | Implemented and prototype-tested |
| Read-only local stdio MCP | Implemented and real-protocol tested |
| Desktop import, search, source health, and Codex config | Developer alpha |
| Portable `.ownctx`, global service connectors, encryption, signed release | Planned |

## Platform and hardware status

The development target and first packaged distribution target are Windows x64.
macOS support and numeric minimum/recommended hardware specifications are deferred.
No CPU, memory, storage, collection-size, or latency figure is a support claim
until it has been measured on the packaged build. See the
[platform and measurement plan](docs/HARDWARE_REQUIREMENTS.md).

Project licensing is intentionally pending the maintainer's Apache-2.0 versus AGPL decision. Until a license is added, the repository is not ready for public redistribution.

## Project contracts

- [Korean product brief](docs/PRODUCT_PLAN.ko.md)
- [Implementation milestones](docs/IMPLEMENTATION_PLAN.md)
- [Platform scope and measurement plan](docs/HARDWARE_REQUIREMENTS.md)
- [Connector acquisition policy](docs/CONNECTOR_POLICY.md)
- [Security and privacy model](docs/SECURITY_MODEL.md)
- [Windows-first encryption architecture](docs/ENCRYPTION_ARCHITECTURE.md)
- [Apache-2.0 versus AGPL-3.0 explainer](docs/LICENSE_OPTIONS.ko.md)
- [Release compliance evidence](docs/RELEASE_COMPLIANCE.md)
