import { describe, expect, it } from "vitest";
import {
  CLEAN_MACHINE_STEPS,
  SECURITY_RELEASE_CONTROLS,
  validateCleanMachineEvidence,
  validateSecurityReleaseAttestation,
} from "../scripts/release-evidence.mjs";

const sourceCommit = "a".repeat(40);
const installerSha256 = "b".repeat(64);

describe("public release evidence contracts", () => {
  it("requires every security gate and a source-bound installer hash", () => {
    const controls = Object.fromEntries(SECURITY_RELEASE_CONTROLS.map((key) => [key, true]));
    expect(validateSecurityReleaseAttestation({
      schemaVersion: 1,
      status: "release-gate-passed",
      sourceCommit,
      platform: "Windows x64",
      installerSha256,
      controls,
    })).toEqual({ ok: true });

    controls[SECURITY_RELEASE_CONTROLS[0]] = false;
    expect(validateSecurityReleaseAttestation({
      schemaVersion: 1,
      status: "release-gate-passed",
      sourceCommit,
      platform: "Windows x64",
      installerSha256,
      controls,
    }).ok).toBe(false);
  });

  it("requires every disposable clean-machine step and no Node prerequisite", () => {
    const steps = Object.fromEntries(CLEAN_MACHINE_STEPS.map((key) => [key, true]));
    const evidence = {
      schemaVersion: 1,
      status: "passed",
      sourceCommit,
      runner: "github-hosted/windows-latest",
      nodeRequired: false,
      installerSha256,
      steps,
    };
    expect(validateCleanMachineEvidence(evidence)).toEqual({ ok: true });
    expect(validateCleanMachineEvidence({ ...evidence, nodeRequired: true }).ok).toBe(false);
    delete steps[CLEAN_MACHINE_STEPS.at(-1) as string];
    expect(validateCleanMachineEvidence(evidence).ok).toBe(false);
  });
});
