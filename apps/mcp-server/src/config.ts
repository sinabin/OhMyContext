import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const VAULT_ENVIRONMENT_VARIABLE = "OWNCONTEXT_VAULT_PATH";

type SupportedPlatform = NodeJS.Platform;

export type VaultPathOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: SupportedPlatform;
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

export { VAULT_ENVIRONMENT_VARIABLE };
