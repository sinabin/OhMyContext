import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];
const originalVaultPath = process.env.OWNCONTEXT_VAULT_PATH;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalVaultPath === undefined) {
    delete process.env.OWNCONTEXT_VAULT_PATH;
  } else {
    process.env.OWNCONTEXT_VAULT_PATH = originalVaultPath;
  }
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("stdio entry module", () => {
  it("is import-safe and exports an explicit runner through the package entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncontext-mcp-import-"));
    temporaryRoots.push(root);
    const vaultPath = join(root, "must-not-exist.sqlite3");
    process.env.OWNCONTEXT_VAULT_PATH = vaultPath;
    const exitListeners = process.listenerCount("exit");
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const imported = await import("../src/stdio.js");
    const packageEntry = await import("../src/index.js");

    expect(imported.runStdioServer).toBeTypeOf("function");
    expect(packageEntry.runStdioServer).toBe(imported.runStdioServer);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(existsSync(vaultPath)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });
});
