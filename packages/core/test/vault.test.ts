import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HASH_ID_PATTERN,
  deterministicId,
  fetchDocument,
  importDirectory,
  openVault,
  purgeDocument,
  searchVault,
  type Vault,
} from "../src/index.js";

const temporaryPaths: string[] = [];
const openVaults: Vault[] = [];

afterEach(async () => {
  for (const vault of openVaults.splice(0)) vault.close();
  for (const temporaryPath of temporaryPaths.splice(0)) {
    await rm(temporaryPath, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; dbPath: string; vault: Vault }> {
  const root = await mkdtemp(join(tmpdir(), "owncontext-core-"));
  temporaryPaths.push(root);
  const documents = join(root, "documents");
  await mkdir(documents);
  const dbPath = join(root, "vault.sqlite");
  const vault = openVault(dbPath);
  openVaults.push(vault);
  return { root: documents, dbPath, vault };
}

describe("deterministic IDs", () => {
  it("uses domain-separated, unambiguous SHA-256 IDs", () => {
    const first = deterministicId("document", "ab", "c");
    expect(first).toMatch(HASH_ID_PATTERN);
    expect(first).toBe(deterministicId("document", "ab", "c"));
    expect(first).not.toBe(deterministicId("document", "a", "bc"));
    expect(first).not.toBe(deterministicId("chunk", "ab", "c"));
  });
});

describe("vault ingestion and retrieval", () => {
  it("creates the required schema and imports UTF-8 markdown and text", async () => {
    const { root, dbPath, vault } = await fixture();
    await mkdir(join(root, "nested"));
    await writeFile(
      join(root, "nested", "notes.md"),
      "# Global Notes\r\n\r\n## Decisions\r\nShip the multilingual local vault.\r\n",
      "utf8",
    );
    await writeFile(join(root, "plain.TXT"), "A searchable plain text memory.", "utf8");
    await writeFile(join(root, "ignored.json"), "{\"ignored\":true}", "utf8");

    const result = await importDirectory(vault, root, { collection: "work" });
    expect(result).toMatchObject({
      collection: "work",
      scanned: 2,
      imported: 2,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    });
    expect(result.sourceId).toMatch(HASH_ID_PATTERN);
    expect(result.documents).toHaveLength(2);

    const hits = searchVault(vault, { query: "multilingual local", collection: "work" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: "Global Notes" });
    expect(hits[0]?.documentId).toMatch(HASH_ID_PATTERN);
    expect(hits[0]?.chunkId).toMatch(HASH_ID_PATTERN);
    expect(hits[0]?.sourceUri).toMatch(/^file:/u);
    expect(new Date(hits[0]?.createdAt ?? "invalid").toString()).not.toBe("Invalid Date");
    expect(new Date(hits[0]?.modifiedAt ?? "invalid").toString()).not.toBe("Invalid Date");

    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'view')
    `).all().map((row) => String(row.name));
    expect(tables).toEqual(expect.arrayContaining([
      "sources", "documents", "revisions", "chunks", "chunks_fts", "retrieval_events",
    ]));
    db.close();
  });

  it("is idempotent and creates a new current revision after modification", async () => {
    const { root, dbPath, vault } = await fixture();
    const file = join(root, "journal.md");
    await writeFile(file, "# Journal\n\nThe old canary is cobalt.", "utf8");

    const first = await importDirectory(vault, root);
    const second = await importDirectory(vault, root);
    expect(second).toMatchObject({ imported: 0, updated: 0, unchanged: 1 });
    expect(second.documents[0]?.documentId).toBe(first.documents[0]?.documentId);
    expect(second.documents[0]?.revisionId).toBe(first.documents[0]?.revisionId);

    await writeFile(file, "# Journal\n\nThe new canary is saffron.", "utf8");
    const future = new Date(Date.now() + 2_000);
    await utimes(file, future, future);
    const third = await importDirectory(vault, root);
    expect(third).toMatchObject({ imported: 0, updated: 1, unchanged: 0 });
    expect(third.documents[0]?.documentId).toBe(first.documents[0]?.documentId);
    expect(third.documents[0]?.revisionId).not.toBe(first.documents[0]?.revisionId);
    expect(searchVault(vault, { query: "cobalt" })).toEqual([]);
    expect(searchVault(vault, { query: "saffron" })).toHaveLength(1);

    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const count = db.prepare("SELECT count(*) AS count FROM revisions").get() as { count: number };
    expect(Number(count.count)).toBe(2);
    db.close();
  });

  it("preserves markdown heading paths and returns bounded neighboring chunks", async () => {
    const { root, vault } = await fixture();
    await writeFile(
      join(root, "structured.md"),
      [
        "# Product",
        "",
        "Opening context.",
        "",
        "## Privacy",
        "",
        "Local private context ".repeat(12),
        "",
        "## Portability",
        "",
        "Portable source provenance ".repeat(12),
      ].join("\n"),
      "utf8",
    );
    await importDirectory(vault, root, { chunkSize: 96 });
    const [hit] = searchVault(vault, { query: "private context" });
    expect(hit).toBeDefined();
    if (!hit) throw new Error("Expected a search result");
    const fetched = fetchDocument(vault, {
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      before: 1,
      after: 1,
      maxChars: 250,
    });
    expect(fetched).not.toBeNull();
    expect(fetched?.chunks.length).toBeGreaterThan(0);
    expect(fetched?.chunks.length).toBeLessThanOrEqual(3);
    expect(fetched?.content.length).toBeLessThanOrEqual(250);
    expect(fetched?.chunks.some((chunk) =>
      chunk.headingPath.includes("Product") && chunk.headingPath.includes("Privacy")
    )).toBe(true);
    expect(fetched).toMatchObject({
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      snippet: fetched?.content,
    });
  });

  it("filters by collection and source timestamps", async () => {
    const { root, vault } = await fixture();
    const alpha = join(root, "alpha.md");
    await writeFile(alpha, "# Alpha\nsharedneedle in alpha", "utf8");
    const old = new Date("2024-01-02T00:00:00.000Z");
    await utimes(alpha, old, old);
    await importDirectory(vault, root, { collection: "archive" });
    await importDirectory(vault, root, { collection: "active" });

    expect(searchVault(vault, { query: "sharedneedle", collection: "archive" })).toHaveLength(1);
    expect(searchVault(vault, { query: "sharedneedle", collection: "missing" })).toEqual([]);
    expect(searchVault(vault, {
      query: "sharedneedle",
      modifiedTo: "2024-01-03T00:00:00.000Z",
    })).toHaveLength(2);
    expect(searchVault(vault, {
      query: "sharedneedle",
      modifiedFrom: "2025-01-01T00:00:00.000Z",
    })).toEqual([]);
  });

  it("purges all searchable revisions and makes stable fetch IDs unavailable", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "delete-me.md"), "# Delete me\nsecretpurgeterm", "utf8");
    const imported = await importDirectory(vault, root);
    const documentId = imported.documents[0]?.documentId ?? "";
    const hit = searchVault(vault, { query: "secretpurgeterm" })[0];
    if (!hit) throw new Error("Expected a search result before purge");
    expect(fetchDocument(vault, { documentId, chunkId: hit.chunkId })).not.toBeNull();
    expect(purgeDocument(vault, documentId)).toBe(true);
    expect(purgeDocument(vault, documentId)).toBe(false);
    expect(searchVault(vault, { query: "secretpurgeterm" })).toEqual([]);
    expect(fetchDocument(vault, { documentId })).toBeNull();

    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    for (const table of ["documents", "revisions", "chunks", "chunks_fts"] as const) {
      const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
      expect(Number(row.count)).toBe(0);
    }
    db.close();
  });

  it("does not follow a directory link outside the selected root", async () => {
    const { root, vault } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "owncontext-outside-"));
    temporaryPaths.push(outside);
    await writeFile(join(root, "inside.md"), "insideboundaryterm", "utf8");
    await writeFile(join(outside, "outside.md"), "outsideboundaryterm", "utf8");
    const link = join(root, "linked-outside");
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const imported = await importDirectory(vault, root);
    expect(imported.imported).toBe(1);
    expect(imported.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "symlink", path: "linked-outside" }),
    ]));
    expect(searchVault(vault, { query: "insideboundaryterm" })).toHaveLength(1);
    expect(searchVault(vault, { query: "outsideboundaryterm" })).toEqual([]);
  });

  it("skips invalid UTF-8 without importing replacement characters", async () => {
    const { root, vault } = await fixture();
    await writeFile(join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));
    const imported = await importDirectory(vault, root);
    expect(imported).toMatchObject({ scanned: 1, imported: 0, skipped: 1 });
    expect(imported.issues[0]).toMatchObject({ code: "invalid-utf8", path: "invalid.md" });
  });

  it("enforces the byte limit and does not index oversized input", async () => {
    const { root, vault } = await fixture();
    await writeFile(join(root, "large.txt"), "12345", "utf8");
    const imported = await importDirectory(vault, root, { maxFileBytes: 4 });
    expect(imported).toMatchObject({ scanned: 1, imported: 0, skipped: 1 });
    expect(imported.issues[0]).toMatchObject({ code: "too-large", path: "large.txt" });
    expect(searchVault(vault, { query: "12345" })).toEqual([]);
  });

  it("stores only a deterministic query hash in local retrieval events", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "audit.txt"), "ordinary indexed material", "utf8");
    await importDirectory(vault, root);
    const rawQuery = "raw-query-must-not-persist-8f9142";
    expect(searchVault(vault, { query: rawQuery })).toEqual([]);
    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const event = db.prepare(`
      SELECT query_hash FROM retrieval_events WHERE event_type = 'search'
    `).get() as { query_hash: string };
    const columns = db.prepare("PRAGMA table_info(retrieval_events)")
      .all().map((row) => String(row.name));
    expect(event.query_hash).toBe(deterministicId("retrieval-query", rawQuery));
    expect(columns).toContain("query_hash");
    expect(columns).not.toContain("query");
    db.close();
    expect((await readFile(dbPath)).includes(Buffer.from(rawQuery, "utf8"))).toBe(false);
  });

  it("rolls back a first import and exposes no partial document after interruption", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "a.md"), "first file succeeds", "utf8");
    await writeFile(join(root, "b.md"), "second file is interrupted", "utf8");
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TRIGGER test_interrupt_import
      BEFORE INSERT ON documents
      WHEN new.relative_path = 'b.md'
      BEGIN
        SELECT RAISE(ABORT, 'simulated import interruption');
      END;
    `);
    setup.close();

    await expect(importDirectory(vault, root)).rejects.toThrow("simulated import interruption");
    const rootUri = pathToFileURL(root.endsWith(sep) ? root : `${root}${sep}`).href;
    const sourceId = deterministicId("source", "folder", rootUri, "default");
    const partialDocumentId = deterministicId("document", sourceId, "a.md");
    expect(searchVault(vault, { query: "first file succeeds" })).toEqual([]);
    expect(fetchDocument(vault, { documentId: partialDocumentId })).toBeNull();

    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const sources = db.prepare("SELECT count(*) AS count FROM sources").get() as { count: number };
    const documents = db.prepare("SELECT count(*) AS count FROM documents").get() as {
      count: number;
    };
    expect(Number(sources.count)).toBe(0);
    expect(Number(documents.count)).toBe(0);
    db.close();
  });

  it("keeps the last complete snapshot visible when a refresh is rolled back", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "a.md"), "old complete alpha", "utf8");
    await writeFile(join(root, "b.md"), "old complete beta", "utf8");
    const first = await importDirectory(vault, root);
    const alphaDocumentId = first.documents.find((item) => item.relativePath === "a.md")
      ?.documentId;
    if (!alphaDocumentId) throw new Error("Expected alpha document ID");

    await writeFile(join(root, "a.md"), "new partial alpha", "utf8");
    await writeFile(join(root, "b.md"), "new partial beta", "utf8");
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TRIGGER test_interrupt_refresh
      BEFORE INSERT ON revisions
      WHEN new.ordinal = 2 AND (
        SELECT relative_path FROM documents WHERE id = new.document_id
      ) = 'b.md'
      BEGIN
        SELECT RAISE(ABORT, 'simulated refresh interruption');
      END;
    `);
    setup.close();

    await expect(importDirectory(vault, root)).rejects.toThrow("simulated refresh interruption");
    expect(searchVault(vault, { query: "new partial" })).toEqual([]);
    expect(searchVault(vault, { query: "old complete" })).toHaveLength(2);
    expect(fetchDocument(vault, { documentId: alphaDocumentId })?.content)
      .toContain("old complete alpha");

    const cleanup = new DatabaseSync(dbPath);
    cleanup.exec("DROP TRIGGER test_interrupt_refresh");
    cleanup.close();
    const recovered = await importDirectory(vault, root);
    expect(recovered.updated).toBe(2);
    expect(searchVault(vault, { query: "new partial" })).toHaveLength(2);
    expect(searchVault(vault, { query: "old complete" })).toEqual([]);
  });

  it("treats FTS operators as literal input and enforces public limits", async () => {
    const { root, vault } = await fixture();
    await writeFile(join(root, "operators.md"), "alpha OR beta", "utf8");
    await importDirectory(vault, root);
    expect(() => searchVault(vault, { query: "" })).toThrow(RangeError);
    expect(() => searchVault(vault, { query: "alpha", limit: 51 })).toThrow(RangeError);
    expect(searchVault(vault, { query: "alpha OR beta" })).toHaveLength(1);
    expect(searchVault(vault, { query: '"' })).toEqual([]);
    expect(() => fetchDocument(vault, { documentId: "not-an-id" })).toThrow(TypeError);
  });

  it("normalizes BOM, CRLF, and canonically equivalent Unicode content", async () => {
    const { root, vault } = await fixture();
    const file = join(root, "unicode.md");
    await writeFile(file, "\ufeff# Café\r\n\r\ne\u0301vidence", "utf8");
    const first = await importDirectory(vault, root);
    await writeFile(file, "# Café\n\névidence", "utf8");
    const second = await importDirectory(vault, root);
    expect(second.unchanged).toBe(1);
    expect(second.documents[0]?.revisionId).toBe(first.documents[0]?.revisionId);
    expect(searchVault(vault, { query: "évidence" })).toHaveLength(1);
  });

  it("keeps the stored source content local and readable after reopening", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "reopen.txt"), "persistent retrieval content", "utf8");
    const imported = await importDirectory(vault, root);
    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);

    const reopened = openVault(dbPath);
    openVaults.push(reopened);
    const fetched = fetchDocument(reopened, {
      documentId: imported.documents[0]?.documentId ?? "",
      before: 0,
      after: 0,
    });
    expect(fetched?.content).toContain("persistent retrieval content");
    expect(await readFile(join(root, "reopen.txt"), "utf8")).toBe("persistent retrieval content");
  });
});
