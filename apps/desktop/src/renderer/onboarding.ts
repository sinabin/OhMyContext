export type LibraryEmptyState =
  | "first-run"
  | "ready-to-search"
  | "no-results"
  | "has-results";

export interface LibraryOnboardingInput {
  documentCount: number;
  resultCount: number;
  hasSearched: boolean;
  hasManagedConnection: boolean;
}

export interface LibraryOnboardingState {
  emptyState: LibraryEmptyState;
  canContinueToConnections: boolean;
  aiConfigurationSaved: boolean;
}

/** Derives first-run guidance only from persisted source/config state and session search state. */
export function deriveLibraryOnboarding(
  input: LibraryOnboardingInput,
): LibraryOnboardingState {
  if (
    !Number.isInteger(input.documentCount) ||
    input.documentCount < 0 ||
    !Number.isInteger(input.resultCount) ||
    input.resultCount < 0
  ) {
    throw new RangeError("Onboarding counts must be non-negative integers.");
  }

  const hasDocuments = input.documentCount > 0;
  const emptyState: LibraryEmptyState = input.resultCount > 0
    ? "has-results"
    : !hasDocuments
      ? "first-run"
      : input.hasSearched
        ? "no-results"
        : "ready-to-search";

  return {
    emptyState,
    canContinueToConnections: hasDocuments,
    // This means only that OwnContext's managed config exists. It deliberately
    // does not claim the Codex process has loaded or connected to the server.
    aiConfigurationSaved: input.hasManagedConnection,
  };
}
