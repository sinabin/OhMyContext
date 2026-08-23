import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const VAULT_ENVIRONMENT_VARIABLE = "OWNCONTEXT_VAULT_PATH";
const ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE = "OWNCONTEXT_ALLOWED_COLLECTION";
const CLIENT_KIND_ENVIRONMENT_VARIABLE = "OWNCONTEXT_CLIENT_KIND";

type SupportedPlatform = NodeJS.Platform;

export type VaultPathOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: SupportedPlatform;
};

export type AllowedCollectionOptions = {
  env?: Readonly<Record<string, string | undefined>>;
};

export type OwnContextMcpClientKind = "codex" | "claude-code";

export type ClientKindOptions = {
  env?: Readonly<Record<string, string | undefined>>;
};

function platformPath(platform: SupportedPlatform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function requireAbsolutePath(
  value: string,
  label: string,
  platform: SupportedPlatform,
): string {
  const path = platformPath(platform);

  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute filesystem path.`);
  }

  return path.normalize(value);
}

/**
 * Resolves the one vault database path the stdio process may open.
 *
 * Tool arguments never participate in this decision. Operators may provide an
 * absolute path at process launch; otherwise OwnContext uses an OS data folder.
 */
export function resolveVaultPath(options: VaultPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configuredPath = env[VAULT_ENVIRONMENT_VARIABLE]?.trim();

  if (configuredPath) {
    return requireAbsolutePath(
      configuredPath,
      VAULT_ENVIRONMENT_VARIABLE,
      platform,
    );
  }

  const path = platformPath(platform);
  const safeHome = requireAbsolutePath(homeDirectory, "Home directory", platform);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    const dataRoot =
      localAppData && win32.isAbsolute(localAppData)
        ? win32.normalize(localAppData)
        : win32.join(safeHome, "AppData", "Local");

    return win32.join(dataRoot, "OwnContext", "vault.sqlite3");
  }

  if (platform === "darwin") {
    return posix.join(
      safeHome,
      "Library",
      "Application Support",
      "OwnContext",
      "vault.sqlite3",
    );
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  const dataRoot =
    xdgDataHome && posix.isAbsolute(xdgDataHome)
      ? posix.normalize(xdgDataHome)
      : posix.join(safeHome, ".local", "share");

  return posix.join(dataRoot, "owncontext", "vault.sqlite3");
}

/**
 * Resolves the single collection this MCP process is allowed to expose.
 *
 * The value is fixed when the process starts. Tool callers may narrow a search
 * to the same collection, but cannot select a different collection at runtime.
 */
export function resolveAllowedCollection(
  options: AllowedCollectionOptions = {},
): string {
  const env = options.env ?? process.env;
  const configured = env[ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE];
  const collection = configured?.trim().normalize("NFC");

  if (!collection || collection.length > 128) {
    throw new Error(
      `${ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE} must contain 1 to 128 characters.`,
    );
  }
  if (/\p{Cc}/u.test(collection)) {
    throw new Error(
      `${ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE} must not contain control characters.`,
    );
  }

  return collection;
}

/**
 * Resolves the trusted client identity fixed by the desktop-generated launch.
 * Tool input cannot select or override this value.
 */
export function resolveClientKind(
  options: ClientKindOptions = {},
): OwnContextMcpClientKind {
  const env = options.env ?? process.env;
  const clientKind = env[CLIENT_KIND_ENVIRONMENT_VARIABLE]?.trim();
  if (clientKind !== "codex" && clientKind !== "claude-code") {
    throw new Error(
      `${CLIENT_KIND_ENVIRONMENT_VARIABLE} must be codex or claude-code.`,
    );
  }
  return clientKind;
}

export {
  ALLOWED_COLLECTION_ENVIRONMENT_VARIABLE,
  CLIENT_KIND_ENVIRONMENT_VARIABLE,
  VAULT_ENVIRONMENT_VARIABLE,
};
