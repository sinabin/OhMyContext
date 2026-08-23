# OwnContext

OwnContext is a local-first personal context vault that turns user-controlled files and exports into cited, read-only context for MCP-compatible AI clients.

The project is in its initial implementation phase. The first vertical slice imports local text and Markdown files, stores provenance in a local SQLite vault, searches the collection, and exposes `search` and `fetch` over a local MCP server.

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
  connector-sdk/ Connector contracts and capability manifests
docs/            Product, architecture, security, and delivery plans
```

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run check
```

Project licensing is intentionally pending the maintainer's Apache-2.0 versus AGPL decision. Until a license is added, the repository is not ready for public redistribution.

## Project contracts

- [Korean product brief](docs/PRODUCT_PLAN.ko.md)
- [Implementation milestones](docs/IMPLEMENTATION_PLAN.md)
- [Initial hardware targets](docs/HARDWARE_REQUIREMENTS.md)
- [Connector acquisition policy](docs/CONNECTOR_POLICY.md)
- [Security and privacy model](docs/SECURITY_MODEL.md)
- [Apache-2.0 versus AGPL-3.0 explainer](docs/LICENSE_OPTIONS.ko.md)
