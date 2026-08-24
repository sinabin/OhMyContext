export declare const SECURITY_RELEASE_CONTROLS: readonly string[];
export declare const CLEAN_MACHINE_STEPS: readonly string[];

export declare function validateSecurityReleaseAttestation(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly reason: string };

export declare function validateCleanMachineEvidence(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly reason: string };
