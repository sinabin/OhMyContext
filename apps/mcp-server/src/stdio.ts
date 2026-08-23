import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveVaultPath } from "./config.js";
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
  mkdirSync(dirname(vaultPath), { recursive: true });

  const { fetchDocument, openVault, searchVault } = await import(
    "@owncontext/core"
  );
  const vault = openVault(vaultPath);
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
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.removeListener("exit", closeVault);
    closeVault();
    throw error;
  }
}
