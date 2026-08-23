export { HASH_ID_PATTERN, deterministicId } from "./ids.js";
export {
  fetchDocument,
  importDirectory,
  listSources,
  openVault,
  purgeDocument,
  searchVault,
} from "./vault.js";
export type {
  FetchDocumentInput,
  FetchedChunk,
  ImportDirectoryOptions,
  ImportDirectoryResult,
  ImportPhase,
  ImportProgress,
  ImportedDocument,
  ImportIssue,
  ImportIssueCode,
  SearchVaultInput,
  Vault,
  VaultFetchResult,
  VaultResult,
  VaultSearchResult,
  VaultSource,
} from "./types.js";
