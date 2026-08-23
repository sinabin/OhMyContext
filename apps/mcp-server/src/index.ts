export {
  CLIENT_KIND_ENVIRONMENT_VARIABLE,
  VAULT_ENVIRONMENT_VARIABLE,
  resolveClientKind,
  resolveVaultPath,
  type ClientKindOptions,
  type OwnContextMcpClientKind,
  type VaultPathOptions,
} from "./config.js";
export {
  createOwnContextServer,
  fetchInputSchema,
  searchInputSchema,
  type OwnContextServerOptions,
  type VaultReadApi,
} from "./server.js";
export { runStdioServer } from "./stdio.js";
