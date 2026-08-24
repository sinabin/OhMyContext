const PROFILE_ENVIRONMENT_NAME = "OWNCONTEXT_RELEASE_PROFILE";
const PUBLIC_PROFILE = "public";
const DEVELOPMENT_PROFILE = "developer-alpha";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required for the public release profile.`);
  }
  return value.trim();
}

function requiredHttps(environment, name) {
  const value = required(environment, name);
  if (!/^https:\/\/[^/\s]+/u.test(value)) {
    throw new Error(`${name} must be an HTTPS URL for the public release profile.`);
  }
  return value;
}

/**
 * Resolve the build boundary before Electron Forge loads any signing or maker
 * configuration. The default is intentionally unsigned developer alpha.
 * Public profile inputs are environment-only so certificates and passwords
 * never enter the repository or package metadata.
 */
export function resolveReleaseProfile(environment = process.env) {
  const selected = environment[PROFILE_ENVIRONMENT_NAME] ?? DEVELOPMENT_PROFILE;
  if (selected === DEVELOPMENT_PROFILE) {
    return Object.freeze({
      profile: DEVELOPMENT_PROFILE,
      publicRelease: false,
      channel: DEVELOPMENT_PROFILE,
      productName: "OwnContext Developer Preview",
      executableName: "OwnContextDeveloperPreview",
      setupExe: "OwnContext-Developer-Preview-Unsigned-Setup.exe",
      squirrelName: "OwnContextDeveloperPreview",
      packagedDirectoryName: "OwnContext Developer Preview-win32-x64",
      description: "Unsigned developer preview for non-sensitive OwnContext evaluation data.",
      copyright: "Copyright (c) OwnContext project contributors",
      signing: undefined,
      updateUrl: undefined,
    });
  }

  if (selected !== PUBLIC_PROFILE) {
    throw new Error(`${PROFILE_ENVIRONMENT_NAME} must be ${DEVELOPMENT_PROFILE} or ${PUBLIC_PROFILE}.`);
  }

  const version = required(environment, "OWNCONTEXT_RELEASE_VERSION");
  if (!VERSION_PATTERN.test(version) || /^0\.0\.0(?:$|-)/u.test(version)) {
    throw new Error("OWNCONTEXT_RELEASE_VERSION must be a non-placeholder semver.");
  }
  const certificateFile = required(environment, "OWNCONTEXT_SIGNING_CERTIFICATE_FILE");
  const certificatePassword = required(environment, "OWNCONTEXT_SIGNING_CERTIFICATE_PASSWORD");
  const timestampServer = requiredHttps(environment, "OWNCONTEXT_TIMESTAMP_SERVER");
  const updateUrl = requiredHttps(environment, "OWNCONTEXT_UPDATE_URL");
  const website = requiredHttps(environment, "OWNCONTEXT_SIGNING_WEBSITE");
  const signing = {
    certificateFile,
    timestampServer,
    description: "OwnContext local-first personal context",
    website,
    hashes: ["sha256"],
  };
  Object.defineProperty(signing, "certificatePassword", {
    value: certificatePassword,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze({
    profile: PUBLIC_PROFILE,
    publicRelease: true,
    channel: "stable",
    version,
    productName: "OwnContext",
    executableName: "OwnContext",
    setupExe: "OwnContext-Setup.exe",
    squirrelName: "OwnContext",
    packagedDirectoryName: "OwnContext-win32-x64",
    description: "Local-first personal context for AI clients.",
    copyright: "Copyright (c) NextH and OwnContext contributors",
    updateUrl,
    signing: Object.freeze(signing),
  });
}

export { DEVELOPMENT_PROFILE, PUBLIC_PROFILE };
