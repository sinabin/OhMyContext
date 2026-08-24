import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "alpha-ci.yml",
);
const publicWorkflowPath = resolve(
  import.meta.dirname,
  "..",
  ".github",
  "workflows",
  "public-release.yml",
);
const lifecycleScriptPath = resolve(
  import.meta.dirname,
  "..",
  ".github",
  "scripts",
  "Invoke-InstalledLifecycleSmoke.ps1",
);
const installedMcpSmokePath = resolve(
  import.meta.dirname,
  "..",
  ".github",
  "scripts",
  "installed-mcp-smoke.mjs",
);
const packagedSmokePath = resolve(
  import.meta.dirname,
  "..",
  "apps",
  "desktop",
  "scripts",
  "smoke-packaged.mjs",
);

describe("unsigned alpha workflow policy", () => {
  it("has read-only repository permissions and no release mutation path", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/u);
    expect(workflow).not.toMatch(/contents:\s*write/u);
    expect(workflow).not.toMatch(/id-token:\s*write|attestations:\s*write/u);
    expect(workflow).not.toMatch(/pull_request_target/u);
    expect(workflow).not.toMatch(/gh\s+release|action-gh-release|releases\/create|createRelease/u);
  });

  it("pins actions and exercises the complete local verification chain", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
    expect(uses).toHaveLength(5);
    for (const action of uses) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/u);
      expect(action).not.toMatch(/@v\d/u);
    }
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("npm run make --workspace @owncontext/desktop");
    expect(workflow).toContain("npm run release:bundle:verify");
  });

  it("uploads unsigned binaries only for a private repository with short retention", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toContain("if: ${{ github.event.repository.private == true }}");
    expect(workflow).toContain("retention-days: 3");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("OWNCONTEXT-RELEASE-CANDIDATE.json");
    expect(workflow).toContain("${{ env.OWNCONTEXT_BUILD_DIR }}/evidence/*");
  });

  it("keeps the public workflow protected by a tag, signing inputs, and release gates", async () => {
    const workflow = await readFile(publicWorkflowPath, "utf8");
    expect(workflow).toContain('"v*.*.*"');
    expect(workflow).toContain("permissions:\n  contents: write");
    expect(workflow).toContain("environment: owncontext-public-release");
    expect(workflow).toContain("OWNCONTEXT_SIGNING_CERTIFICATE_BASE64");
    expect(workflow).toContain("OWNCONTEXT_SIGNING_CERTIFICATE_PASSWORD");
    expect(workflow).toContain("OWNCONTEXT_SECURITY_ATTESTATION_BASE64");
    expect(workflow).toContain("Decode the protected security attestation");
    expect(workflow).toContain("Normalize the release version");
    expect(workflow).toContain("RAW_RELEASE_VERSION: ${{ inputs.version || github.ref_name }}");
    expect(workflow).toContain("OWNCONTEXT_RELEASE_VERSION=$releaseVersion");
    expect(workflow).not.toContain("OWNCONTEXT_RELEASE_VERSION: ${{ inputs.version || github.ref_name }}");
    expect(workflow).toContain("Finalize the source-bound public bundle");
    expect(workflow).toContain("OWNCONTEXT_RELEASE_PROFILE: public");
    expect(workflow).toContain("OWNCONTEXT_PUBLIC_RELEASE_APPROVAL: \"true\"");
    expect(workflow).toContain("npm run release:bundle:generate -- --build");
    expect(workflow).toContain("node scripts/release-preflight.mjs --json");
    expect(workflow).toContain("-ExecuteDisposableGitHubHostedLifecycle");
    expect(workflow).toContain("gh release create");
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
    for (const action of uses) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/u);
    }
  });

  it("requires the clean-machine lifecycle to exercise the encrypted MCP broker", async () => {
    const lifecycle = await readFile(lifecycleScriptPath, "utf8");
    expect(lifecycle).toContain("--owncontext-mcp-broker-smoke");
    expect(lifecycle).toContain("OWNCONTEXT_MCP_BROKER_PIPE");
    expect(lifecycle).toContain("encrypted-vault-broker-ready");
    const mcpSmoke = await readFile(installedMcpSmokePath, "utf8");
    expect(mcpSmoke).toContain("installed-packaged-mcp-broker-search-fetch");
    expect(mcpSmoke).toContain("brokered");
  });

  it("keeps preview-only notice and draft compliance checks out of public smoke", async () => {
    const smoke = await readFile(packagedSmokePath, "utf8");
    expect(smoke).toContain("draft: !releaseProfile.publicRelease");
    expect(smoke).toContain("if (noticePath)");
    expect(smoke).toContain("Packaged encrypted SQLite runtime is not approved for public distribution.");
  });
});
