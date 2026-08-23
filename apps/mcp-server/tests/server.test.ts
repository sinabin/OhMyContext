import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  Vault,
  VaultFetchResult,
  VaultSearchResult,
} from "@owncontext/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOwnContextServer,
  type VaultReadApi,
} from "../src/server.js";
import { formatFailureDiagnostic } from "../src/diagnostics.js";

const DOCUMENT_ID = "a".repeat(64);
const CHUNK_ID = "b".repeat(64);

const searchResult: VaultSearchResult = {
  documentId: DOCUMENT_ID,
  chunkId: CHUNK_ID,
  title: "A local note",
  snippet: "An attributable search result.",
  sourceUri: "owncontext://document/fixture",
  createdAt: "2026-08-01T00:00:00.000Z",
  modifiedAt: "2026-08-02T00:00:00.000Z",
  score: -1.25,
};

const fetchResult: VaultFetchResult = {
  documentId: searchResult.documentId,
  chunkId: searchResult.chunkId,
  title: searchResult.title,
  snippet: searchResult.snippet,
  sourceUri: searchResult.sourceUri,
  createdAt: searchResult.createdAt,
  modifiedAt: searchResult.modifiedAt,
  content: "# A local note\n\nAn attributable search result.",
  chunks: [
    {
      chunkId: CHUNK_ID,
      index: 0,
      headingPath: ["A local note"],
      content: "An attributable search result.",
    },
  ],
};

type ConnectedServer = {
  api: VaultReadApi;
  client: Client;
  diagnostics: string[];
  server: ReturnType<typeof createOwnContextServer>;
  vault: Vault;
};
const connected: ConnectedServer[] = [];

async function connectServer(
  overrides: Partial<VaultReadApi> = {},
  allowedCollection = "default",
) {
  const api: VaultReadApi = {
    searchVault: vi.fn(() => [searchResult]),
    fetchDocument: vi.fn(() => fetchResult),
    ...overrides,
  };
  const vault = { close: vi.fn() } as unknown as Vault;
  const diagnostics: string[] = [];
  const server = createOwnContextServer(vault, {
    api,
    allowedCollection,
    writeDiagnostic: (message) => diagnostics.push(message),
  });
  const client = new Client({ name: "owncontext-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = { api, client, diagnostics, server, vault };
  connected.push(result);
  return result;
}

afterEach(async () => {
  while (connected.length > 0) {
    const item = connected.pop();
    if (!item) continue;
    await item.client.close();
    await item.server.close();
  }
});

function requireTextContent(content: unknown): string {
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("Expected MCP text content.");
  }

  return content.text;
}

function requireCompletedToolResult(
  result: Awaited<ReturnType<Client["callTool"]>>,
): {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
} {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected an immediate MCP tool result.");
  }

  return result as {
    content: unknown[];
    isError?: boolean;
    structuredContent?: unknown;
  };
}

describe("OwnContext MCP server", () => {
  it("advertises only search and fetch as closed-world read-only tools", async () => {
    const { client } = await connectServer();
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(["search", "fetch"]);

    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
  });

  it("returns search results as structured content and JSON text", async () => {
    const { api, client, vault } = await connectServer({}, "writing");
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "search",
        arguments: {
          query: "attributable",
          collection: "writing",
          limit: 5,
        },
      }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      results: [{ ...searchResult, contentTrust: "untrusted-user-data" }],
      count: 1,
    });
    expect(JSON.parse(requireTextContent(result.content[0]))).toEqual(
      result.structuredContent,
    );
    expect(api.searchVault).toHaveBeenCalledWith(vault, {
      query: "attributable",
      collection: "writing",
      limit: 5,
    });
  });

  it("forces omitted collection searches into the connection grant", async () => {
    const { api, client, vault } = await connectServer({}, "private-notes");
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "search",
        arguments: { query: "attributable" },
      }),
    );

    expect(result.isError).not.toBe(true);
    expect(api.searchVault).toHaveBeenCalledWith(vault, {
      query: "attributable",
      collection: "private-notes",
    });
  });

  it("denies a different collection without calling or diagnosing the vault", async () => {
    const searchVaultMock = vi.fn(() => [searchResult]);
    const { client, diagnostics } = await connectServer(
      { searchVault: searchVaultMock },
      "private-alpha",
    );
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "search",
        arguments: { query: "attributable", collection: "other-beta" },
      }),
    );

    expect(result.isError).toBe(true);
    expect(requireTextContent(result.content[0])).toContain("outside this connection's allowed scope");
    expect(requireTextContent(result.content[0])).not.toContain("private-alpha");
    expect(requireTextContent(result.content[0])).not.toContain("other-beta");
    expect(searchVaultMock).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);
  });

  it("fetches bounded context by vault-issued IDs", async () => {
    const { api, client, vault } = await connectServer();
    await client.callTool({
      name: "search",
      arguments: { query: "attributable" },
    });
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: {
          documentId: DOCUMENT_ID,
          chunkId: CHUNK_ID,
          before: 1,
          after: 2,
          maxChars: 8_000,
        },
      }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      document: {
        ...fetchResult,
        contentTrust: "untrusted-user-data",
        chunks: fetchResult.chunks.map((chunk) => ({
          ...chunk,
          contentTrust: "untrusted-user-data",
        })),
      },
    });
    expect(JSON.parse(requireTextContent(result.content[0]))).toEqual(
      result.structuredContent,
    );
    expect(api.fetchDocument).toHaveBeenCalledWith(vault, {
      documentId: DOCUMENT_ID,
      chunkId: CHUNK_ID,
      before: 1,
      after: 2,
      maxChars: 8_000,
    });
  });

  it("denies a known ID until this server instance issues it through search", async () => {
    const fetchDocumentMock = vi.fn(() => fetchResult);
    const { client } = await connectServer({
      fetchDocument: fetchDocumentMock,
    });
    const denied = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: { documentId: DOCUMENT_ID },
      }),
    );

    expect(denied.isError).toBe(true);
    expect(requireTextContent(denied.content[0])).toContain("use search");
    expect(fetchDocumentMock).not.toHaveBeenCalled();

    await client.callTool({
      name: "search",
      arguments: { query: "attributable" },
    });
    const allowed = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: { documentId: DOCUMENT_ID },
      }),
    );

    expect(allowed.isError).not.toBe(true);
    expect(fetchDocumentMock).toHaveBeenCalledOnce();
  });

  it("returns a tool error when an issued ID is no longer current", async () => {
    const fetchDocumentMock = vi.fn(() => null);
    const { client } = await connectServer({ fetchDocument: fetchDocumentMock });
    await client.callTool({
      name: "search",
      arguments: { query: "attributable" },
    });
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: { documentId: DOCUMENT_ID },
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(requireTextContent(result.content[0])).toContain("No current");
  });

  it("denies a chunk ID that search did not issue for the document", async () => {
    const fetchDocumentMock = vi.fn(() => fetchResult);
    const { client } = await connectServer({
      fetchDocument: fetchDocumentMock,
    });
    await client.callTool({
      name: "search",
      arguments: { query: "attributable" },
    });
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: {
          documentId: DOCUMENT_ID,
          chunkId: "c".repeat(64),
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(fetchDocumentMock).not.toHaveBeenCalled();
  });

  it("evicts the oldest issued document when the authorization cache is full", async () => {
    const searchVaultMock = vi.fn((_vault: Vault, input: { query: string }) => {
      const ordinal = Number(input.query);
      return [
        {
          ...searchResult,
          documentId: ordinal.toString(16).padStart(64, "0"),
          chunkId: (ordinal + 1_000).toString(16).padStart(64, "0"),
        },
      ];
    });
    const fetchDocumentMock = vi.fn(() => fetchResult);
    const { client } = await connectServer({
      searchVault: searchVaultMock,
      fetchDocument: fetchDocumentMock,
    });

    for (let ordinal = 0; ordinal <= 512; ordinal += 1) {
      const result = requireCompletedToolResult(
        await client.callTool({
          name: "search",
          arguments: { query: String(ordinal) },
        }),
      );
      expect(result.isError).not.toBe(true);
    }

    const evicted = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: { documentId: "0".repeat(64) },
      }),
    );

    expect(evicted.isError).toBe(true);
    expect(fetchDocumentMock).not.toHaveBeenCalled();
  });

  it("bounds issued chunk IDs per document without revoking the document", async () => {
    const searchVaultMock = vi.fn((_vault: Vault, input: { query: string }) => {
      const ordinal = Number(input.query);
      return [
        {
          ...searchResult,
          chunkId: (ordinal + 2_000).toString(16).padStart(64, "0"),
        },
      ];
    });
    const fetchDocumentMock = vi.fn(() => fetchResult);
    const { client } = await connectServer({
      searchVault: searchVaultMock,
      fetchDocument: fetchDocumentMock,
    });

    for (let ordinal = 0; ordinal <= 64; ordinal += 1) {
      await client.callTool({
        name: "search",
        arguments: { query: String(ordinal) },
      });
    }

    const evictedChunk = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: {
          documentId: DOCUMENT_ID,
          chunkId: (2_000).toString(16).padStart(64, "0"),
        },
      }),
    );
    expect(evictedChunk.isError).toBe(true);
    expect(fetchDocumentMock).not.toHaveBeenCalled();

    const issuedDocument = requireCompletedToolResult(
      await client.callTool({
        name: "fetch",
        arguments: { documentId: DOCUMENT_ID },
      }),
    );
    expect(issuedDocument.isError).not.toBe(true);
    expect(fetchDocumentMock).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary path, URL, and SQL parameters before core is called", async () => {
    const searchVaultMock = vi.fn(() => [searchResult]);
    const { client } = await connectServer({ searchVault: searchVaultMock });
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "search",
        arguments: {
          query: "note",
          path: "C:\\private",
          url: "https://example.invalid",
          sql: "SELECT * FROM documents",
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(searchVaultMock).not.toHaveBeenCalled();
  });

  it("reports internal failures on diagnostics without exposing details to tools", async () => {
    const { client, diagnostics } = await connectServer({
      searchVault: vi.fn(() => {
        throw new Error("database path C:\\sensitive\\vault.sqlite3 failed");
      }),
    });
    const result = requireCompletedToolResult(
      await client.callTool({
        name: "search",
        arguments: { query: "note" },
      }),
    );
    const text = requireTextContent(result.content[0]);

    expect(result.isError).toBe(true);
    expect(text).toBe(
      "OwnContext search failed. Check the local server diagnostics.",
    );
    expect(text).not.toContain("sensitive");
    expect(diagnostics.join("")).toBe(
      "[owncontext-mcp] search failed (Error).\n",
    );
    expect(diagnostics.join("")).not.toContain("sensitive");
  });

  it("retains only allowlisted diagnostic categories and error codes", () => {
    const pathError = Object.assign(new Error("C:\\private\\vault.sqlite3"), {
      code: "ENOENT",
    });
    const customError = new Error("/home/ada/private/vault.sqlite3");
    customError.name = "path:/home/ada/private";

    expect(formatFailureDiagnostic("startup", pathError)).toBe(
      "[owncontext-mcp] startup failed (ENOENT).\n",
    );
    expect(formatFailureDiagnostic("startup", customError)).toBe(
      "[owncontext-mcp] startup failed (internal_error).\n",
    );
  });
});
