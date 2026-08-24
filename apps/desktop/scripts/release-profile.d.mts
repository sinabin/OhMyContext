export interface ReleaseSigningOptions {
  readonly certificateFile: string;
  readonly certificatePassword: string;
  readonly timestampServer: string;
  readonly description: string;
  readonly website: string;
  readonly hashes: readonly ["sha256"];
}

export interface ReleaseProfile {
  readonly profile: "developer-alpha" | "public";
  readonly publicRelease: boolean;
  readonly channel: string;
  readonly productName: string;
  readonly executableName: string;
  readonly setupExe: string;
  readonly squirrelName: string;
  readonly packagedDirectoryName: string;
  readonly description: string;
  readonly copyright: string;
  readonly version?: string;
  readonly updateUrl?: string;
  readonly signing?: ReleaseSigningOptions;
}

export declare function resolveReleaseProfile(
  environment?: Readonly<Record<string, string | undefined>>,
): ReleaseProfile;

export declare const DEVELOPMENT_PROFILE: "developer-alpha";
export declare const PUBLIC_PROFILE: "public";
