#!/usr/bin/env node

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetchDocument, openVault, searchVault } from "@owncontext/core";
import { resolveVaultPath } from "./config.js";
import { formatFailureDiagnostic } from "./diagnostics.js";
import { createOwnContextServer } from "./server.js";

function diagnostic(error: unknown): void {
  process.stderr.write(formatFailureDiagnostic("startup", error));
}

export async function runStdioServer(): Promise<void> {
  const vaultPath = resolveVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });

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

void runStdioServer().catch((error: unknown) => {
  diagnostic(error);
  process.exitCode = 1;
});
