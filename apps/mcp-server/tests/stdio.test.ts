import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const temporaryRoots: string[] = [];

function requireTemporaryRoot(candidate: string): string {
  const base = resolve(tmpdir());
  const target = resolve(candidate);
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normalizedTarget =
    process.platform === "win32" ? target.toLowerCase() : target;

  if (
    normalizedTarget === normalizedBase ||
    !normalizedTarget.startsWith(`${normalizedBase}${sep}`)
  ) {
    throw new Error("Refusing to remove a path outside the OS temporary folder.");
  }

  return target;
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

function firstSearchDocumentId(structuredContent: unknown): string {
  if (
    typeof structuredContent !== "object" ||
    structuredContent === null ||
    !("results" in structuredContent) ||
    !Array.isArray(structuredContent.results)
  ) {
    throw new Error("Search returned no structured results array.");
  }

  const first = structuredContent.results[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("documentId" in first) ||
    typeof first.documentId !== "string"
  ) {
    throw new Error("Search returned no stable document ID.");
  }

  return first.documentId;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const candidate = temporaryRoots.pop();
    if (!candidate) continue;
    await rm(requireTemporaryRoot(candidate), { recursive: true, force: true });
  }
});

describe.skipIf(!existsSync(CLI_PATH))("stdio protocol smoke test", () => {
  it(
    "initializes, lists tools, searches a temporary vault, and fetches a result",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "owncontext-mcp-"));
      temporaryRoots.push(root);
      const sourceDirectory = join(root, "source");
      const deniedSourceDirectory = join(root, "denied-source");
      const vaultPath = join(root, "vault.sqlite3");
      const {
        createNodeSqliteDevelopmentStorageProvider,
        importDirectory,
        openVault,
      } = await import("@owncontext/core");
      await mkdir(sourceDirectory);
      await mkdir(deniedSourceDirectory);
      await writeFile(
        join(sourceDirectory, "memory.md"),
        "# Protocol memory\n\nThe orchard meeting moved to Friday morning.",
        "utf8",
      );
      await writeFile(
        join(deniedSourceDirectory, "private.md"),
        "# Outside the grant\n\nThe crosscollectioncanary must remain unavailable.",
        "utf8",
      );

      const vault = openVault(
        vaultPath,
        createNodeSqliteDevelopmentStorageProvider(),
      );
      await importDirectory(vault, sourceDirectory);
      await importDirectory(vault, deniedSourceDirectory, {
        collection: "denied",
      });
      vault.close();

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_PATH],
        cwd: dirname(CLI_PATH),
        env: {
          ...getDefaultEnvironment(),
          NODE_NO_WARNINGS: "1",
          OWNCONTEXT_VAULT_PATH: vaultPath,
          OWNCONTEXT_ALLOWED_COLLECTION: "default",
        },
        stderr: "pipe",
      });
      const stderr: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
      });
      const client = new Client({
        name: "owncontext-stdio-smoke",
        version: "0.0.0",
      });

      try {
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual([
          "search",
          "fetch",
        ]);

        const search = requireCompletedToolResult(
          await client.callTool({
            name: "search",
            arguments: { query: "orchard meeting" },
          }),
        );
        expect(search.isError).not.toBe(true);
        expect(search.structuredContent).toMatchObject({
          results: [{ contentTrust: "untrusted-user-data" }],
        });
        const documentId = firstSearchDocumentId(search.structuredContent);

        const deniedCanary = requireCompletedToolResult(
          await client.callTool({
            name: "search",
            arguments: { query: "crosscollectioncanary" },
          }),
        );
        expect(deniedCanary.isError).not.toBe(true);
        expect(deniedCanary.structuredContent).toEqual({ results: [], count: 0 });
        expect(JSON.stringify(deniedCanary)).not.toContain("Outside the grant");

        const scopeEscape = requireCompletedToolResult(
          await client.callTool({
            name: "search",
            arguments: {
              query: "crosscollectioncanary",
              collection: "denied",
            },
          }),
        );
        expect(scopeEscape.isError).toBe(true);
        expect(JSON.stringify(scopeEscape)).not.toContain("crosscollectioncanary");

        const fetched = requireCompletedToolResult(
          await client.callTool({
            name: "fetch",
            arguments: { documentId },
          }),
        );
        expect(fetched.isError).not.toBe(true);
        expect(fetched.structuredContent).toMatchObject({
          document: {
            documentId,
            content: expect.stringContaining("Friday morning"),
            contentTrust: "untrusted-user-data",
            chunks: [{ contentTrust: "untrusted-user-data" }],
          },
        });
        expect(stderr.join("")).not.toContain("startup failed");
      } finally {
        await client.close();
      }
    },
    20_000,
  );
});
