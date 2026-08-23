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
    expect(uses).toHaveLength(3);
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
});
