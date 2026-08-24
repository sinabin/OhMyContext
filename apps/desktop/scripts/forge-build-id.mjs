export const FORGE_BUILD_ID_ENV = "OWNCONTEXT_FORGE_BUILD_ID";

const BUILD_ID_PATTERN =
  /^(?:unsigned|public)-[A-Za-z0-9](?:[A-Za-z0-9_-]{0,84}[A-Za-z0-9])?$/u;

export function validateForgeBuildIdentifier(value) {
  if (typeof value !== "string" || !BUILD_ID_PATTERN.test(value)) {
    throw new Error(
      `${FORGE_BUILD_ID_ENV} must be an unsigned-* identifier containing only ASCII letters, digits, underscores, and hyphens.`,
    );
  }
  return value;
}

export function createForgeBuildIdentifier(
  now = new Date(),
  pid = process.pid,
  profile = process.env.OWNCONTEXT_RELEASE_PROFILE === "public" ? "public" : "unsigned",
) {
  const timestamp = now.toISOString().replace(/[:.]/gu, "-");
  const prefix = profile === "public" ? "public" : "unsigned";
  return validateForgeBuildIdentifier(`${prefix}-${timestamp}-${pid}`);
}

export function resolveForgeBuildIdentifier(environment = process.env) {
  const configured = environment[FORGE_BUILD_ID_ENV];
  return configured === undefined
    ? createForgeBuildIdentifier(new Date(), process.pid, environment.OWNCONTEXT_RELEASE_PROFILE)
    : validateForgeBuildIdentifier(configured);
}
