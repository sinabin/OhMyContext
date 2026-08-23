export const PACKAGED_CLIENT_SMOKE_TIMEOUT_MS: number;
export const PACKAGED_CLIENT_SMOKE_MAX_OUTPUT_BYTES: number;

export class PackagedClientSmokeError extends Error {
  readonly code: string;
  constructor(code: string);
}

export interface PackagedClientLaunch {
  commandPath: string;
  args: readonly string[];
  vaultPath: string;
  allowedCollection: string;
  runtime: "electron";
}

export function assertCodexConfigParse(
  output: string,
  expectedLaunch: PackagedClientLaunch,
): void;

export function assertClaudeMcpHealth(output: string): void;

export function parseWindowsCommandLine(commandLine: string): string[];

export function createIsolatedClientEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  paths: {
    homeDirectory: string;
    codexHome?: string;
    claudeConfigDirectory?: string;
  },
): Readonly<NodeJS.ProcessEnv>;

export function discoverClaudeNpmNativeCommand(options?: {
  environment?: Readonly<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  architecture?: string;
}): Promise<Readonly<{
  commandPath: string;
  prefixArgs: readonly string[];
}> | undefined>;
