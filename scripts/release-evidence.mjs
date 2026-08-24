const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export const SECURITY_RELEASE_CONTROLS = Object.freeze([
  "normal-desktop-vault-encrypted",
  "mcp-vault-encrypted",
  "sidecars-temp-and-page-cache-covered",
  "configuration-backups-encrypted",
  "process-restart-recovery",
  "crash-power-loss-and-directory-durability",
  "cross-process-locking",
  "windows-dacl-preservation",
  "key-rotation-and-interrupted-migration",
  "external-writer-race-rejected",
  "parser-isolation-and-resource-budgets",
  "collection-candidate-non-interference",
  "authenticated-client-launch-discovery",
]);

const CLEAN_MACHINE_STEPS = Object.freeze([
  "setup-install",
  "no-node-launch",
  "sample-import-and-search",
  "mcp-search-and-fetch",
  "forced-termination-recovery",
  "managed-client-cleanup",
  "squirrel-uninstall",
  "clean-profile-relaunch",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function validCommit(value) {
  return typeof value === "string" && SOURCE_COMMIT_PATTERN.test(value);
}

function validSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

export function validateSecurityReleaseAttestation(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.status !== "release-gate-passed") {
    return { ok: false, reason: "security attestation is not a release-gate-passed v1 record" };
  }
  if (!validCommit(value.sourceCommit) || value.platform !== "Windows x64") {
    return { ok: false, reason: "security attestation is not bound to a Windows source commit" };
  }
  if (!hasExactKeys(value.controls, SECURITY_RELEASE_CONTROLS)) {
    return { ok: false, reason: "security attestation control inventory is incomplete" };
  }
  if (SECURITY_RELEASE_CONTROLS.some((control) => value.controls[control] !== true)) {
    return { ok: false, reason: "one or more required security controls are not passed" };
  }
  if (!validSha256(value.installerSha256)) {
    return { ok: false, reason: "security attestation is missing the candidate installer hash" };
  }
  return { ok: true };
}

export function validateCleanMachineEvidence(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.status !== "passed") {
    return { ok: false, reason: "clean-machine evidence is not a passed v1 record" };
  }
  if (
    !validCommit(value.sourceCommit) ||
    value.runner !== "github-hosted/windows-latest" ||
    value.nodeRequired !== false ||
    !validSha256(value.installerSha256)
  ) {
    return { ok: false, reason: "clean-machine evidence is not bound to the required disposable runner and artifact" };
  }
  if (!hasExactKeys(value.steps, CLEAN_MACHINE_STEPS)) {
    return { ok: false, reason: "clean-machine evidence step inventory is incomplete" };
  }
  if (CLEAN_MACHINE_STEPS.some((step) => value.steps[step] !== true)) {
    return { ok: false, reason: "one or more clean-machine lifecycle steps are not passed" };
  }
  return { ok: true };
}

export { CLEAN_MACHINE_STEPS };
