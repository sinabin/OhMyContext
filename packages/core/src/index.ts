export { HASH_ID_PATTERN, deterministicId } from "./ids.js";
export {
  fetchDocument,
  importDirectory,
  openVault,
  purgeDocument,
  searchVault,
} from "./vault.js";
export type {
  FetchDocumentInput,
  FetchedChunk,
  ImportDirectoryOptions,
  ImportDirectoryResult,
  ImportedDocument,
  ImportIssue,
  ImportIssueCode,
  SearchVaultInput,
  Vault,
  VaultFetchResult,
  VaultResult,
  VaultSearchResult,
} from "./types.js";
