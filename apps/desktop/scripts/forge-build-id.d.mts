export const FORGE_BUILD_ID_ENV: "OWNCONTEXT_FORGE_BUILD_ID";

export function validateForgeBuildIdentifier(value: unknown): string;

export function createForgeBuildIdentifier(now?: Date, pid?: number): string;

export function resolveForgeBuildIdentifier(
  environment?: Record<string, string | undefined>,
): string;
