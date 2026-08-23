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
- Users can export, revoke, and delete their data.

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

The first Electron invocation downloads its platform binary. End users will not
need Node.js once a signed packaged build exists; packaging is not claimed by
this repository yet.

## Implementation status

| Area | Status |
| --- | --- |
| Product, connector, hardware, and security contracts | Complete baseline |
| Atomic local SQLite/FTS vault | Implemented and prototype-tested |
| Read-only local stdio MCP | Implemented and real-protocol tested |
| Desktop import, search, source health, and Codex config | Developer alpha |
| Portable `.ownctx`, global service connectors, encryption, signed release | Planned |

## Initial hardware targets

These are support hypotheses, not measured product claims. Public requirements
will be set only after the named-device benchmark in
[docs/HARDWARE_REQUIREMENTS.md](docs/HARDWARE_REQUIREMENTS.md).

| Tier | Initial target | Intended vault |
| --- | --- | --- |
| Minimum | 4-core 64-bit CPU, 8 GiB RAM, SSD with 15 GiB free | Up to 10,000 documents / 1 GiB normalized text |
| Recommended | 6 modern cores or 8 threads, 16 GiB RAM, NVMe with 50 GiB free | Up to 50,000 documents / 5 GiB normalized text |
| Large-vault | 8 modern cores, 32 GiB RAM, NVMe with 200 GiB free | Up to 250,000 documents / 20 GiB normalized text |

Project licensing is intentionally pending the maintainer's Apache-2.0 versus AGPL decision. Until a license is added, the repository is not ready for public redistribution.

## Project contracts

- [Korean product brief](docs/PRODUCT_PLAN.ko.md)
- [Implementation milestones](docs/IMPLEMENTATION_PLAN.md)
- [Initial hardware targets](docs/HARDWARE_REQUIREMENTS.md)
- [Connector acquisition policy](docs/CONNECTOR_POLICY.md)
- [Security and privacy model](docs/SECURITY_MODEL.md)
- [Apache-2.0 versus AGPL-3.0 explainer](docs/LICENSE_OPTIONS.ko.md)
