import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createNodeSqliteDevelopmentStorageProvider,
  fetchDocument,
  importOwnContextSampleLibrary,
  openVault,
  searchVault,
} from "@owncontext/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SAMPLE_LIBRARY_COLLECTION,
  SAMPLE_LIBRARY_PROVENANCE_ROOT,
  SAMPLE_LIBRARY_SOURCE_LABEL,
  SAMPLE_LIBRARY_SUGGESTED_QUERY,
  SAMPLE_LIBRARY_VERSION,
  materializeSampleLibrary,
} from "../src/electron/sample-library.js";

describe("built-in sample library materializer", () => {
  let testRoot: string;
  let userDataRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "owncontext-sample-library-"));
    userDataRoot = join(testRoot, "user-data");
    await mkdir(userDataRoot);
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it("creates one stable, bounded, versioned Unicode sample inventory", async () => {
    const sample = await materializeSampleLibrary(userDataRoot);

    expect(sample).toEqual({
      version: SAMPLE_LIBRARY_VERSION,
      directoryPath: resolve(userDataRoot, "sample-library", "v1"),
      sourceLabel: SAMPLE_LIBRARY_SOURCE_LABEL,
      collection: SAMPLE_LIBRARY_COLLECTION,
      suggestedQuery: SAMPLE_LIBRARY_SUGGESTED_QUERY,
      provenanceRootUri: SAMPLE_LIBRARY_PROVENANCE_ROOT,
    });

    const entries = await readdir(sample.directoryPath);
    expect(entries.sort()).toEqual([
      ".owncontext-sample.json",
      "getting-started.md",
      "multilingual-note.md",
    ]);

    const contents = await Promise.all(
      entries.map((name) => readFile(join(sample.directoryPath, name))),
    );
    expect(contents).toHaveLength(3);
    expect(contents.every((content) => content.byteLength <= 16 * 1024)).toBe(true);
    expect(contents.reduce((total, content) => total + content.byteLength, 0)).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(Buffer.concat(contents).toString("utf8")).toContain("주간 회고");

    expect(await readdir(join(userDataRoot, "sample-library"))).toEqual(["v1"]);
  });

  it("is idempotent and accepts only the complete exact inventory", async () => {
    const first = await materializeSampleLibrary(userDataRoot);
    const firstMetadata = await lstat(join(first.directoryPath, "getting-started.md"));
    const firstBytes = await readFile(join(first.directoryPath, "getting-started.md"));

    const second = await materializeSampleLibrary(userDataRoot);
    const secondMetadata = await lstat(join(second.directoryPath, "getting-started.md"));

    expect(second).toEqual(first);
    expect(secondMetadata.ino).toBe(firstMetadata.ino);
    expect(await readFile(join(second.directoryPath, "getting-started.md"))).toEqual(
      firstBytes,
    );
  });

  it("leaves modified or additional content untouched instead of claiming ownership", async () => {
    const sample = await materializeSampleLibrary(userDataRoot);
    const expectedPath = join(sample.directoryPath, "getting-started.md");
    const unexpectedPath = join(sample.directoryPath, "personal-note.md");
    await writeFile(expectedPath, "user changed this file\n", "utf8");
    await writeFile(unexpectedPath, "private user content\n", "utf8");

    await expect(materializeSampleLibrary(userDataRoot)).rejects.toThrow(
      "content OhMyContext does not own",
    );
    await expect(readFile(expectedPath, "utf8")).resolves.toBe(
      "user changed this file\n",
    );
    await expect(readFile(unexpectedPath, "utf8")).resolves.toBe(
      "private user content\n",
    );
  });

  it("rejects relative roots and roots that are links or junctions", async () => {
    await expect(materializeSampleLibrary("relative-user-data")).rejects.toThrow(
      "absolute path",
    );

    const linkedRoot = join(testRoot, "linked-user-data");
    await symlink(
      userDataRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(materializeSampleLibrary(linkedRoot)).rejects.toThrow(
      "regular directory",
    );
  });

  it("rejects a nested link or junction that would escape the trusted root", async () => {
    const outside = join(testRoot, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(userDataRoot, "sample-library"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(materializeSampleLibrary(userDataRoot)).rejects.toThrow(
      "regular directory",
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("imports through the core and proves English and Korean search plus fetch", async () => {
    const sample = await materializeSampleLibrary(userDataRoot);
    const vault = openVault(
      join(testRoot, "sample-vault.sqlite"),
      createNodeSqliteDevelopmentStorageProvider(),
    );

    try {
      const imported = await importOwnContextSampleLibrary(
        vault,
        sample.directoryPath,
      );
      expect(imported).toMatchObject({
        collection: SAMPLE_LIBRARY_COLLECTION,
        scanned: 2,
        imported: 2,
        updated: 0,
        unchanged: 0,
        skipped: 0,
      });

      const englishResults = searchVault(vault, {
        query: sample.suggestedQuery,
        collection: sample.collection,
      });
      expect(englishResults.length).toBeGreaterThan(0);
      const englishResult = englishResults[0]!;
      const fetched = fetchDocument(vault, {
        documentId: englishResult.documentId,
        chunkId: englishResult.chunkId,
      });
      expect(fetched?.content).toContain("Every Friday");
      expect(fetched?.sourceUri).toBe(
        "owncontext-sample://library/v1/getting-started.md",
      );
      expect(fetched?.sourceUri).not.toContain(userDataRoot);

      const koreanResults = searchVault(vault, {
        query: "한국어",
        collection: sample.collection,
      });
      expect(koreanResults).toHaveLength(1);
      expect(koreanResults[0]?.sourceUri).toContain("multilingual-note.md");
    } finally {
      vault.close();
    }
  });
});
