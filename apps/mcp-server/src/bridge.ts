import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  fetchDocument,
  searchVault,
  Vault,
} from "@owncontext/core";
import { resolveAllowedCollection, resolveClientKind } from "./config.js";
import { createOwnContextServer } from "./server.js";

type BridgeApi = {
  fetchDocument: typeof fetchDocument;
  searchVault: typeof searchVault;
};

/**
 * Runs the stdio protocol over a vault owned by the Electron main process.
 * The bridge never opens a database or receives a key; the host supplies the
 * already-open vault and its same-process core API functions.
 */
export async function runStdioServerWithApi(
  vault: Vault,
  api: BridgeApi,
): Promise<void> {
  const server = createOwnContextServer(vault, {
    api,
    allowedCollection: resolveAllowedCollection(),
    clientKind: resolveClientKind(),
  });
  await server.connect(new StdioServerTransport());
  // `connect()` installs the transport and returns immediately. Keep the
  // Electron host alive until the MCP client closes stdin; otherwise the
  // broker would close its encrypted vault immediately after initialization.
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.stdin.removeListener("end", finish);
      process.stdin.removeListener("close", finish);
      resolve();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.stdin.resume();
  });
}
