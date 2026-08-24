import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  resolveAllowedCollection,
  resolveClientKind,
  resolveVaultPath,
} from "./config.js";
import {
  OWNCONTEXT_MCP_BROKER_PIPE,
  runBrokerStdioServer,
} from "./broker.js";
import { createOwnContextServer } from "./server.js";

/**
 * Starts the local read-only MCP server on the current process' stdio streams.
 * Packaged Windows launches select the broker bridge before this direct,
 * plaintext-development vault path is considered.
 *
 * This module is deliberately import-safe. Importing it does not open a vault,
 * register process listeners, or write to stdout; callers explicitly invoke
 * this function from the Node CLI or another embedding host.
 */
export async function runStdioServer(): Promise<void> {
  const allowedCollection = resolveAllowedCollection();
  const clientKind = resolveClientKind();
  const brokerPipe = process.env[OWNCONTEXT_MCP_BROKER_PIPE]?.trim();
  if (brokerPipe) {
    await runBrokerStdioServer(brokerPipe, clientKind);
    return;
  }

  const vaultPath = resolveVaultPath();
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
