# OwnContext MCP server

This workspace package exposes one local OwnContext vault to MCP-compatible AI
clients over `stdio`. It is intentionally read-only and closed-world: the two
tools can search or fetch data already held by the selected vault, and cannot
accept filesystem paths, URLs, SQL, sync requests, or deletion requests.

## Requirements

- Node.js 22.13 or newer
- A built `@owncontext/core` workspace package
- An existing vault, or permission to create an empty vault at the configured
  location

From the repository root:

```sh
npm install
npm run build --workspace @owncontext/mcp-server
```

The executable entry point is `apps/mcp-server/dist/cli.js`. Standard output is
reserved exclusively for MCP JSON-RPC framing. Startup and tool diagnostics are
written to standard error.

## Vault selection

The MCP tools cannot choose a database. The server resolves exactly one path at
process startup:

1. The absolute path in `OWNCONTEXT_VAULT_PATH`, when set.
2. Otherwise, the OS-local default:
   - Windows: `%LOCALAPPDATA%\OwnContext\vault.sqlite3`
   - macOS: `~/Library/Application Support/OwnContext/vault.sqlite3`
   - Linux and other Unix: `${XDG_DATA_HOME:-~/.local/share}/owncontext/vault.sqlite3`

A relative `OWNCONTEXT_VAULT_PATH` is rejected. The launcher creates the parent
directory when needed; document paths are never accepted over MCP.

## Tools

### `search`

Required input: `query`. Optional inputs are `collection`, `createdFrom`,
`createdTo`, `modifiedFrom`, `modifiedTo`, and `limit` (1–50). Results contain
stable document and chunk IDs, title, snippet, source URI, and timestamps.

### `fetch`

Required input: a 64-character lowercase SHA-256 `documentId` issued by a
successful `search` on the same server connection. An optional `chunkId` must
have been issued by search for that document and can center the response.
`before` and `after` are limited to 0–5 neighboring chunks and `maxChars` to
1–50,000 characters. Issued-ID state is bounded to 512 documents and 64 chunks
per document; an unknown, evicted, stale, or mismatched ID returns a tool error
rather than arbitrary data.

Both tools return the same result in `structuredContent` and as JSON in a text
content block for older clients. Their annotations are:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": false,
  "openWorldHint": false
}
```

`idempotentHint` is false because each successful retrieval appends a local,
query-redacted audit event even though it does not alter the user's documents.

## Client configuration

Replace the sample paths with absolute paths on the local machine. Omitting the
environment entry uses the OS-local default described above.

Codex local developer configuration in `config.toml`:

```toml
[mcp_servers.owncontext]
command = "node"
args = ["C:/absolute/path/to/owncontext/apps/mcp-server/dist/cli.js"]
env = { OWNCONTEXT_VAULT_PATH = "C:/absolute/path/to/vault.sqlite3" }
```

Claude Desktop local developer MCP configuration, when that feature is enabled:

```json
{
  "mcpServers": {
    "owncontext": {
      "command": "node",
      "args": [
        "C:/absolute/path/to/owncontext/apps/mcp-server/dist/cli.js"
      ],
      "env": {
        "OWNCONTEXT_VAULT_PATH": "C:/absolute/path/to/vault.sqlite3"
      }
    }
  }
}
```

Restart the client after changing its MCP configuration. Current Claude Desktop
consumer distribution favors one-click Desktop Extensions (`.dxt`); an
OwnContext DXT package remains a later, signed-distribution deliverable rather
than a claim of this developer alpha.

## Verification

```sh
npm run typecheck --workspace @owncontext/mcp-server
npm test --workspace @owncontext/mcp-server
npm run test:protocol --workspace @owncontext/mcp-server
```

The unit suite connects the official MCP `Client` to the server with the SDK's
linked in-memory transport and a mocked core boundary. It checks tool listing,
annotations, structured/text output parity, invalid stable IDs, failure
redaction, and rejection of extra path/URL/SQL arguments. The protocol smoke
test builds the CLI, imports a fixture into a temporary vault, and connects with
the official stdio client transport; a successful exchange also detects stdout
contamination because non-JSON-RPC output breaks the transport parser.

## Trust boundary

The server does not contact external services. Once a local AI client receives
an excerpt, however, that client may send it to its configured model provider.
Returned personal text is untrusted data and must not be treated as tool or
system instructions.

Official host references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Claude Desktop local MCP extensions](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
