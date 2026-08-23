import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  resolveAllowedCollection,
  resolveClientKind,
  resolveVaultPath,
} from "./config.js";
import { createOwnContextServer } from "./server.js";

/**
 * Starts the local read-only MCP server on the current process' stdio streams.
 *
 * This module is deliberately import-safe. Importing it does not open a vault,
 * register process listeners, or write to stdout; callers explicitly invoke
 * this function from the Node CLI or another embedding host.
 */
export async function runStdioServer(): Promise<void> {
  const vaultPath = resolveVaultPath();
  const allowedCollection = resolveAllowedCollection();
  const clientKind = resolveClientKind();
  mkdirSync(dirname(vaultPath), { recursive: true });

  const {
    createNodeSqliteDevelopmentStorageProvider,
    fetchDocument,
    openVault,
    searchVault,
  } = await import(
    "@owncontext/core"
  );
  const vault = openVault(
    vaultPath,
    createNodeSqliteDevelopmentStorageProvider(),
  );
  let closed = false;

  const closeVault = (): void => {
    if (closed) return;
    closed = true;
    vault.close();
  };

  process.once("exit", closeVault);

  try {
    const server = createOwnContextServer(vault, {
      api: { fetchDocument, searchVault },
      allowedCollection,
      clientKind,
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.removeListener("exit", closeVault);
    closeVault();
    throw error;
  }
}
