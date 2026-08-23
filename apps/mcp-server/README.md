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

## Vault and collection selection

The MCP tools cannot choose a database. The server resolves exactly one path at
process startup:

1. The absolute path in `OWNCONTEXT_VAULT_PATH`, when set.
2. Otherwise, the OS-local default:
   - Windows: `%LOCALAPPDATA%\OwnContext\vault.sqlite3`
   - macOS: `~/Library/Application Support/OwnContext/vault.sqlite3`
   - Linux and other Unix: `${XDG_DATA_HOME:-~/.local/share}/owncontext/vault.sqlite3`

A relative `OWNCONTEXT_VAULT_PATH` is rejected. The launcher creates the parent
directory when needed; document paths are never accepted over MCP.

The macOS and Unix path branches describe server path resolution only. The
current packaged product target is Windows x64; macOS support and numeric
minimum/recommended hardware requirements remain deferred until measured.

The process is also pinned at startup to exactly one collection through
`OWNCONTEXT_ALLOWED_COLLECTION`. If it is omitted or unsafe, startup fails
closed. The desktop-managed Codex and Claude Code launches explicitly set it to
`default`. A caller cannot widen this grant: a `search` request naming any other
collection is denied, while omission searches only the allowed collection. This
is default deny outside the single launch-time grant; collection selection,
expiry, and multi-grant management are not implemented in the current desktop
alpha.

`OWNCONTEXT_CLIENT_KIND` is also required and currently accepts only `codex` or
`claude-code`. It is fixed when the process starts and cannot be supplied by a
tool request. Unknown or missing values fail startup closed.

## Tools

### `search`

Required input: `query`. Optional inputs are `collection`, `createdFrom`,
`createdTo`, `modifiedFrom`, `modifiedTo`, and `limit` (1–50). `collection` may
only repeat the process's launch-time allowed collection; it cannot select a
different collection. Results contain stable document and chunk IDs, title,
snippet, source URI, and timestamps.

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
content-free audit event without the query or a query hash, even though it does
not alter the user's documents.
If an import, removal, or another writer prevents that audit insert, `search`
and `fetch` fail closed without returning context. The tool result contains only
a bounded retry instruction, while stderr records the allowlisted
`EOWNCONTEXT_AUDIT_BUSY` category without paths, queries, or document data.

## Client configuration

Replace the sample paths with absolute paths on the local machine. The managed
Codex and Claude Code launchers also set a required client kind so the local,
content-free access history can distinguish their requests. This declaration is
launcher metadata, not cryptographic proof of which upstream provider processed
the returned context.

Codex local developer configuration in `config.toml`:

```toml
[mcp_servers.owncontext]
command = "node"
args = ["C:/absolute/path/to/owncontext/apps/mcp-server/dist/cli.js"]
env = { OWNCONTEXT_VAULT_PATH = "C:/absolute/path/to/vault.sqlite3", OWNCONTEXT_ALLOWED_COLLECTION = "default", OWNCONTEXT_CLIENT_KIND = "codex" }
```

The desktop app writes the equivalent launch environment automatically.

### Claude Code

The desktop alpha can connect the generated OwnContext stdio launch as Claude
Code's user-scoped `owncontext` server. It uses fixed arguments equivalent to
`claude mcp add-json --scope user owncontext <generated OwnContext JSON>` and
respects an absolute `CLAUDE_CONFIG_DIR`. The renderer sees a generated structure
with private local paths redacted plus bounded status, never unrelated Claude
configuration.

An existing unmanaged or conflicting `owncontext` entry is refused. Before a
mutation, the alpha backs up the complete existing Claude configuration file
byte-for-byte beside the original. Because that full file may contain unrelated
secrets or metadata and backups can accumulate, encryption, retention, and
deletion behavior remain public-release gates. Windows DACL preservation,
external-writer compare-and-swap safety, and persistence of custom override
targets across update/uninstall environments are also unverified release gates.
The discovered Claude executable
is not yet authenticated by publisher signature, hash, provenance, or supported
version, which is also a public-release gate.

### Claude Desktop (planned)

The following illustrates the planned local MCP shape; the current desktop app
does not install a Claude Desktop Extension or manage this configuration:

```json
{
  "mcpServers": {
    "owncontext": {
      "command": "node",
      "args": [
        "C:/absolute/path/to/owncontext/apps/mcp-server/dist/cli.js"
      ],
      "env": {
        "OWNCONTEXT_VAULT_PATH": "C:/absolute/path/to/vault.sqlite3",
        "OWNCONTEXT_ALLOWED_COLLECTION": "default",
        "OWNCONTEXT_CLIENT_KIND": "planned-client-kind"
      }
    }
  }
}
```

Restart the client after changing its MCP configuration. Current Claude Desktop
consumer distribution favors one-click Desktop Extensions (`.dxt`); an
OwnContext DXT package remains a later, signed-distribution deliverable rather
than a claim of this developer alpha. The placeholder client kind above is not
accepted by the current server; Claude Desktop support requires an explicit,
tested identity extension first.

## Verification

```sh
npm run typecheck --workspace @owncontext/mcp-server
npm test --workspace @owncontext/mcp-server
npm run test:protocol --workspace @owncontext/mcp-server
```

The unit suite connects the official MCP `Client` to the server with the SDK's
linked in-memory transport and a mocked core boundary. It checks tool listing,
annotations, structured/text output parity, invalid stable IDs, failure
redaction, fixed allowed-collection enforcement, and rejection of extra
path/URL/SQL arguments. The protocol smoke test builds the CLI, imports fixtures
into allowed and denied collections, and connects with the official stdio client
transport; it verifies that denied canaries are not returned. A successful
exchange also detects stdout contamination because non-JSON-RPC output breaks
the transport parser. The same real-stdio test holds a competing vault writer
and verifies the content-free audit-busy retry response and zero unlogged result.

## Trust boundary

The server does not contact external services. Once a local AI client receives
an excerpt, however, that client may send it to its configured model provider.
Returned personal text is untrusted data and must not be treated as tool or
system instructions. Search results, fetched documents, and fetched chunks carry
the fixed `contentTrust: "untrusted-user-data"` marker in structured output.

Returned rows are restricted to the allowed collection, but the current vault
uses one global FTS virtual table. Candidate work, term structures, cache and
resource effects, and response timing are not fully partitioned by collection.
No cross-collection content return is known from the prototype tests, but this
is not yet evidence of side-channel non-interference. Physical candidate
partitioning or an adequate timing/cache non-interference test is required
before public release.

Official host references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code MCP configuration](https://code.claude.com/docs/en/mcp), and
[Claude Desktop local MCP extensions](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
