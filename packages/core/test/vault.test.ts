import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HASH_ID_PATTERN,
  OWNCONTEXT_SAMPLE_LIBRARY_FILES,
  OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
  deterministicId,
  fetchDocument,
  importDirectory,
  importOwnContextSampleLibrary,
  listDeletionReceipts,
  listSources,
  openVault,
  prepareSourcePurge,
  purgeDocument,
  purgeSource,
  searchVault,
  verifyDeletionReceipt,
  type Vault,
  type ImportDirectoryOptions,
  type ImportProgress,
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
  it("grants virtual sample provenance only after exact built-in verification", async () => {
    const { root, dbPath, vault } = await fixture();
    for (const file of OWNCONTEXT_SAMPLE_LIBRARY_FILES) {
      await writeFile(join(root, file.name), file.content, "utf8");
    }

    const sampleSourceId = deterministicId(
      "source",
      "folder",
      OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
      "default",
    );
    const legacySpoofDocumentId = deterministicId(
      "document",
      sampleSourceId,
      "legacy-spoof.md",
    );
    const setup = new DatabaseSync(dbPath);
    setup.prepare(`
      INSERT INTO sources(
        id, kind, root_uri, collection, display_name, created_at, last_scanned_at
      ) VALUES (?, 'folder', ?, 'default', 'Spoofed sample', ?, ?)
    `).run(
      sampleSourceId,
      OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    );
    setup.prepare(`
      INSERT INTO documents(
        id, source_id, relative_path, source_uri, title,
        created_at, modified_at, current_revision_id
      ) VALUES (?, ?, 'legacy-spoof.md', ?, 'Spoofed', ?, ?, NULL)
    `).run(
      legacySpoofDocumentId,
      sampleSourceId,
      `${OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT}legacy-spoof.md`,
      "2026-08-23T00:00:00.000Z",
      "2026-08-23T00:00:00.000Z",
    );
    setup.close();

    const sample = await importOwnContextSampleLibrary(vault, root);
    expect(sample.rootUri).toBe(OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT);
    expect(sample.documents).toHaveLength(2);
    expect(sample.documents.every((document) =>
      document.sourceUri.startsWith(OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT)
    )).toBe(true);
    expect(listSources(vault)).toEqual([
      expect.objectContaining({
        sourceId: sampleSourceId,
        name: "OwnContext Sample Library",
        documentCount: 2,
      }),
    ]);

    const otherRoot = await mkdtemp(join(tmpdir(), "owncontext-not-sample-"));
    temporaryPaths.push(otherRoot);
    await writeFile(join(otherRoot, "other.md"), "not a built-in sample", "utf8");
    const spoofAttempt = await importDirectory(vault, otherRoot, {
      provenanceRootUri: OWNCONTEXT_SAMPLE_LIBRARY_PROVENANCE_ROOT,
    } as ImportDirectoryOptions);
    expect(spoofAttempt.rootUri).toBe(pathToFileURL(`${otherRoot}${sep}`).href);
    expect(spoofAttempt.documents[0]?.sourceUri).toBe(
      pathToFileURL(join(otherRoot, "other.md")).href,
    );

    await writeFile(join(root, "getting-started.md"), "tampered\n", "utf8");
    await expect(importOwnContextSampleLibrary(vault, root)).rejects.toThrow(
      "bytes do not match",
    );
  });

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
      "deletion_receipts",
    ]));
    db.close();
  });

  it("lists content-free source health and document counts", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "one.md"), "first source document", "utf8");
    await writeFile(join(root, "two.txt"), "second source document", "utf8");
    const imported = await importDirectory(vault, root, {
      collection: "personal",
      sourceName: "Personal notes",
    });

    expect(listSources(vault)).toEqual([
      expect.objectContaining({
        sourceId: imported.sourceId,
        name: "Personal notes",
        rootUri: imported.rootUri,
        collection: "personal",
        status: "ready",
        documentCount: 2,
      }),
    ]);
    const ready = listSources(vault)[0];
    expect(ready?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(ready?.lastScannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(ready).not.toHaveProperty("content");

    const setup = new DatabaseSync(dbPath);
    setup.prepare("UPDATE sources SET last_scanned_at = NULL WHERE id = ?")
      .run(imported.sourceId);
    setup.close();
    expect(listSources(vault)[0]).toMatchObject({
      status: "incomplete",
      lastScannedAt: null,
      documentCount: 2,
    });
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

  it("keeps collection-scoped results stable when a denied collection changes", async () => {
    const { root, vault } = await fixture();
    await writeFile(join(root, "allowed.md"), "# Allowed\nsharedterm stays visible", "utf8");
    await importDirectory(vault, root, { collection: "allowed" });
    const before = searchVault(vault, {
      query: "sharedterm",
      collection: "allowed",
    });

    const deniedRoot = join(dirname(root), "denied-source");
    await mkdir(deniedRoot);
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        join(deniedRoot, `denied-${index}.md`),
        `# Denied ${index}\nsharedterm denied corpus ${index}`,
        "utf8",
      );
    }
    await importDirectory(vault, deniedRoot, { collection: "denied" });
    const after = searchVault(vault, {
      query: "sharedterm",
      collection: "allowed",
    });

    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after[0]?.score).toBeLessThan(0);
    expect(JSON.stringify(after)).not.toContain("Denied");
  });

  it("keeps useful relevance ordering inside a scoped collection", async () => {
    const { root, vault } = await fixture();
    const titleHit = join(root, "title-hit.md");
    const bodyHit = join(root, "body-hit.md");
    await writeFile(titleHit, "# scopedrankingterm\nOlder but directly titled", "utf8");
    await writeFile(bodyHit, "# Recent note\nA newer scopedrankingterm mention", "utf8");
    const old = new Date("2024-01-01T00:00:00.000Z");
    const recent = new Date("2026-01-01T00:00:00.000Z");
    await utimes(titleHit, old, old);
    await utimes(bodyHit, recent, recent);
    await importDirectory(vault, root, { collection: "allowed" });

    const results = searchVault(vault, {
      query: "scopedrankingterm",
      collection: "allowed",
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe("scopedrankingterm");
    expect(results[0]!.score).toBeLessThan(results[1]!.score);
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

  it("atomically purges a complete source lineage and persists a content-free receipt", async () => {
    const { root, dbPath, vault } = await fixture();
    const firstFile = join(root, "one.md");
    await writeFile(firstFile, "# One\nsourcepurgecanary first revision", "utf8");
    await writeFile(join(root, "two.txt"), "sourcepurgecanary second document", "utf8");
    const first = await importDirectory(vault, root, { collection: "remove" });

    await writeFile(firstFile, "# One\nsourcepurgecanary updated revision", "utf8");
    const future = new Date(Date.now() + 2_000);
    await utimes(firstFile, future, future);
    await importDirectory(vault, root, { collection: "remove" });
    await importDirectory(vault, root, { collection: "keep" });

    const targetHits = searchVault(vault, {
      query: "sourcepurgecanary",
      collection: "remove",
      limit: 10,
    });
    expect(targetHits.length).toBeGreaterThan(0);
    const targetHit = targetHits[0];
    if (!targetHit) throw new Error("Expected a target search result");
    expect(fetchDocument(vault, {
      documentId: targetHit.documentId,
      chunkId: targetHit.chunkId,
    })).not.toBeNull();

    const audit = new DatabaseSync(dbPath, { readOnly: true });
    const linkedAuditBefore = audit.prepare(`
      SELECT count(*) AS count
      FROM retrieval_events
      WHERE document_id IN (
        SELECT id FROM documents WHERE source_id = ?
      )
    `).get(first.sourceId) as { count: number };
    audit.close();

    const prepared = prepareSourcePurge(vault, first.sourceId);
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected purge preview");
    expect(prepared.preview).toMatchObject({
      sourceId: first.sourceId,
      documentCount: 2,
    });

    const result = purgeSource(vault, {
      sourceId: prepared.preview.sourceId,
      confirmationToken: prepared.preview.confirmationToken,
      expectedDocumentCount: prepared.preview.documentCount,
      expectedLastScannedAt: prepared.preview.lastScannedAt,
    });
    expect(result.status).toBe("purged");
    if (result.status !== "purged") throw new Error("Expected a deletion receipt");
    expect(result.receipt).toMatchObject({
      targetKind: "source",
      targetId: first.sourceId,
      sourceCount: 1,
      documentCount: 2,
      revisionCount: 3,
      assurance: "logical-non-addressability",
      originalFilesModified: false,
      secureEraseClaimed: false,
      retrievalEventCount: Number(linkedAuditBefore.count),
    });
    expect(result.receipt.receiptId).toMatch(HASH_ID_PATTERN);
    expect(result.receipt.chunkCount).toBeGreaterThanOrEqual(2);
    expect(result.receipt.ftsEntryCount).toBe(result.receipt.chunkCount);

    expect(listSources(vault).map((source) => source.collection)).toEqual(["keep"]);
    expect(fetchDocument(vault, { documentId: targetHit.documentId })).toBeNull();
    expect(searchVault(vault, {
      query: "sourcepurgecanary",
      collection: "remove",
    })).toEqual([]);
    expect(searchVault(vault, {
      query: "sourcepurgecanary",
      collection: "keep",
    }).length).toBeGreaterThan(0);

    expect(listDeletionReceipts(vault)).toEqual([result.receipt]);
    expect(verifyDeletionReceipt(vault, result.receipt.receiptId)).toEqual({
      status: "verified",
      receipt: result.receipt,
    });

    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    const remaining = inspection.prepare(`
      SELECT
        (SELECT count(*) FROM sources WHERE id = ?) AS sources,
        (SELECT count(*) FROM documents WHERE source_id = ?) AS documents,
        (SELECT count(*) FROM retrieval_events WHERE document_id IN (
          SELECT id FROM documents WHERE source_id = ?
        )) AS linked_events
    `).get(first.sourceId, first.sourceId, first.sourceId) as Record<string, number>;
    const storedReceipt = inspection.prepare(`
      SELECT * FROM deletion_receipts WHERE id = ?
    `).get(result.receipt.receiptId) as Record<string, unknown>;
    inspection.close();
    expect(Object.values(remaining).map(Number)).toEqual([0, 0, 0]);
    const serializedReceipt = JSON.stringify(storedReceipt);
    expect(serializedReceipt).not.toContain("sourcepurgecanary");
    expect(serializedReceipt).not.toContain(root);
    expect(serializedReceipt).not.toContain("One");
    expect(await readFile(firstFile, "utf8")).toContain("sourcepurgecanary");
  });

  it("creates no receipt when a source is missing", async () => {
    const { vault } = await fixture();
    const missingId = "a".repeat(64);
    expect(prepareSourcePurge(vault, missingId)).toEqual({ status: "not-found" });
    expect(purgeSource(vault, {
      sourceId: missingId,
      confirmationToken: "b".repeat(64),
      expectedDocumentCount: 0,
      expectedLastScannedAt: null,
    })).toEqual({ status: "not-found" });
    expect(listDeletionReceipts(vault)).toEqual([]);
  });

  it("fails closed when the confirmed source count or scan time is stale", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "one.md"), "stale confirmation source", "utf8");
    const imported = await importDirectory(vault, root);
    const first = prepareSourcePurge(vault, imported.sourceId);
    if (first.status !== "ready") throw new Error("Expected purge preview");

    await writeFile(join(root, "two.md"), "a newly discovered document", "utf8");
    await importDirectory(vault, root);
    expect(purgeSource(vault, {
      sourceId: first.preview.sourceId,
      confirmationToken: first.preview.confirmationToken,
      expectedDocumentCount: first.preview.documentCount,
      expectedLastScannedAt: first.preview.lastScannedAt,
    })).toEqual({ status: "stale-confirmation" });
    expect(listSources(vault)[0]?.documentCount).toBe(2);
    expect(listDeletionReceipts(vault)).toEqual([]);

    const second = prepareSourcePurge(vault, imported.sourceId);
    if (second.status !== "ready") throw new Error("Expected refreshed purge preview");
    const changedScanTime = "2099-01-01T00:00:00.000Z";
    const setup = new DatabaseSync(dbPath);
    setup.prepare("UPDATE sources SET last_scanned_at = ? WHERE id = ?")
      .run(changedScanTime, imported.sourceId);
    setup.close();
    expect(purgeSource(vault, {
      sourceId: second.preview.sourceId,
      confirmationToken: second.preview.confirmationToken,
      expectedDocumentCount: second.preview.documentCount,
      expectedLastScannedAt: second.preview.lastScannedAt,
    })).toEqual({ status: "stale-confirmation" });
    expect(listDeletionReceipts(vault)).toEqual([]);
  });

  it("rejects source purge while an import is active", async () => {
    const { root, vault } = await fixture();
    await writeFile(join(root, "one.md"), "import interleave guard", "utf8");
    const imported = await importDirectory(vault, root);
    const prepared = prepareSourcePurge(vault, imported.sourceId);
    if (prepared.status !== "ready") throw new Error("Expected purge preview");
    await writeFile(join(root, "two.md"), "refresh in progress", "utf8");

    const observed: string[] = [];
    await importDirectory(vault, root, {
      onProgress: (progress) => {
        if (progress.phase !== "discovering" || observed.length > 0) return;
        observed.push(prepareSourcePurge(vault, imported.sourceId).status);
        observed.push(purgeSource(vault, {
          sourceId: prepared.preview.sourceId,
          confirmationToken: prepared.preview.confirmationToken,
          expectedDocumentCount: prepared.preview.documentCount,
          expectedLastScannedAt: prepared.preview.lastScannedAt,
        }).status);
      },
    });

    expect(observed).toEqual(["import-in-progress", "import-in-progress"]);
    expect(listSources(vault)[0]?.documentCount).toBe(2);
    expect(listDeletionReceipts(vault)).toEqual([]);
  });

  it("rolls back source deletion when its receipt cannot be stored", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "keep.md"), "receipt rollback canary", "utf8");
    const imported = await importDirectory(vault, root);
    const prepared = prepareSourcePurge(vault, imported.sourceId);
    if (prepared.status !== "ready") throw new Error("Expected purge preview");
    const setup = new DatabaseSync(dbPath);
    setup.exec(`
      CREATE TRIGGER test_reject_deletion_receipt
      BEFORE INSERT ON deletion_receipts
      BEGIN
        SELECT RAISE(ABORT, 'simulated receipt failure');
      END;
    `);
    setup.close();

    expect(() => purgeSource(vault, {
      sourceId: prepared.preview.sourceId,
      confirmationToken: prepared.preview.confirmationToken,
      expectedDocumentCount: prepared.preview.documentCount,
      expectedLastScannedAt: prepared.preview.lastScannedAt,
    })).toThrow("simulated receipt failure");
    expect(listSources(vault)[0]?.documentCount).toBe(1);
    expect(searchVault(vault, { query: "receipt rollback canary" })).toHaveLength(1);
    expect(listDeletionReceipts(vault)).toEqual([]);
  });

  it("persists FTS5 secure-delete through a version-one schema upgrade", async () => {
    const { dbPath, vault } = await fixture();
    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    const downgrade = new DatabaseSync(dbPath);
    downgrade.exec(`
      DROP TABLE deletion_receipts;
      INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 0);
      PRAGMA user_version = 1;
    `);
    downgrade.close();

    const migrated = openVault(dbPath);
    openVaults.push(migrated);
    const inspection = new DatabaseSync(dbPath, { readOnly: true });
    const version = inspection.prepare("PRAGMA user_version").get() as { user_version: number };
    const ftsConfig = inspection.prepare(`
      SELECT v FROM chunks_fts_config WHERE k = 'secure-delete'
    `).get() as { v: number };
    const receiptTable = inspection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deletion_receipts'
    `).get();
    inspection.close();
    expect(Number(version.user_version)).toBe(2);
    expect(Number(ftsConfig.v)).toBe(1);
    expect(receiptTable).toBeDefined();
  });

  it("rebuilds a version-one FTS index to scrub previously deleted terms", async () => {
    const { root, dbPath, vault } = await fixture();
    const canary = "legacydeletedftsindexcanaryxqz123456789";
    await writeFile(join(root, "legacy.md"), canary.repeat(20), "utf8");
    const imported = await importDirectory(vault, root);
    const legacyMode = new DatabaseSync(dbPath);
    legacyMode.exec(`
      INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 0);
    `);
    legacyMode.close();
    expect(purgeDocument(vault, imported.documents[0]?.documentId ?? "")).toBe(true);
    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    expect((await readFile(dbPath)).includes(Buffer.from(canary, "utf8"))).toBe(true);

    const downgrade = new DatabaseSync(dbPath);
    downgrade.exec(`
      DROP TABLE deletion_receipts;
      PRAGMA user_version = 1;
    `);
    downgrade.close();
    const migrated = openVault(dbPath);
    migrated.close();
    expect((await readFile(dbPath)).includes(Buffer.from(canary, "utf8"))).toBe(false);
  });

  it("removes a persisted canary from the closed database with FTS secure-delete", async () => {
    const { root, dbPath, vault } = await fixture();
    const canary = "ftssecuredeletecanaryxqz987654321";
    await writeFile(join(root, "canary.md"), canary.repeat(20), "utf8");
    const imported = await importDirectory(vault, root);
    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    expect((await readFile(dbPath)).includes(Buffer.from(canary, "utf8"))).toBe(true);

    const reopened = openVault(dbPath);
    openVaults.push(reopened);
    const prepared = prepareSourcePurge(reopened, imported.sourceId);
    if (prepared.status !== "ready") throw new Error("Expected purge preview");
    const purged = purgeSource(reopened, {
      sourceId: prepared.preview.sourceId,
      confirmationToken: prepared.preview.confirmationToken,
      expectedDocumentCount: prepared.preview.documentCount,
      expectedLastScannedAt: prepared.preview.lastScannedAt,
    });
    expect(purged.status).toBe("purged");
    reopened.close();
    openVaults.splice(openVaults.indexOf(reopened), 1);
    expect((await readFile(dbPath)).includes(Buffer.from(canary, "utf8"))).toBe(false);
  });

  it("keeps the receipt and reports reintroduction after an explicit reimport", async () => {
    const { root, vault } = await fixture();
    await writeFile(join(root, "return.md"), "explicit reimport can restore this", "utf8");
    const imported = await importDirectory(vault, root);
    const prepared = prepareSourcePurge(vault, imported.sourceId);
    if (prepared.status !== "ready") throw new Error("Expected purge preview");
    const purged = purgeSource(vault, {
      sourceId: prepared.preview.sourceId,
      confirmationToken: prepared.preview.confirmationToken,
      expectedDocumentCount: prepared.preview.documentCount,
      expectedLastScannedAt: prepared.preview.lastScannedAt,
    });
    if (purged.status !== "purged") throw new Error("Expected purge receipt");
    expect(verifyDeletionReceipt(vault, purged.receipt.receiptId).status).toBe("verified");

    const restored = await importDirectory(vault, root);
    expect(restored.sourceId).toBe(imported.sourceId);
    expect(restored.imported).toBe(1);
    expect(searchVault(vault, { query: "explicit reimport" })).toHaveLength(1);
    expect(verifyDeletionReceipt(vault, purged.receipt.receiptId)).toEqual({
      status: "target-reintroduced",
      receipt: purged.receipt,
    });
    expect(listDeletionReceipts(vault)).toEqual([purged.receipt]);
  });

  it("reports receipt verification as an integrity error for an orphan FTS row", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "remove.md"), "fts receipt integrity", "utf8");
    const imported = await importDirectory(vault, root);
    const prepared = prepareSourcePurge(vault, imported.sourceId);
    if (prepared.status !== "ready") throw new Error("Expected purge preview");
    const purged = purgeSource(vault, {
      sourceId: prepared.preview.sourceId,
      confirmationToken: prepared.preview.confirmationToken,
      expectedDocumentCount: prepared.preview.documentCount,
      expectedLastScannedAt: prepared.preview.lastScannedAt,
    });
    if (purged.status !== "purged") throw new Error("Expected purge receipt");

    const corruption = new DatabaseSync(dbPath);
    corruption.prepare(`
      INSERT INTO chunks_fts(
        chunk_id, document_id, revision_id, title, heading_path, content
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      "orphan",
      "",
      "orphan fts content",
    );
    corruption.close();

    expect(verifyDeletionReceipt(vault, purged.receipt.receiptId)).toEqual({
      status: "integrity-error",
      receipt: purged.receipt,
    });
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

  it("reports bounded progress and atomically rolls back when aborted", async () => {
    const { root, dbPath, vault } = await fixture();
    await writeFile(join(root, "a.md"), "abortable first document", "utf8");
    await writeFile(join(root, "b.md"), "abortable second document", "utf8");
    const controller = new AbortController();
    const events: ImportProgress[] = [];

    await expect(importDirectory(vault, root, {
      signal: controller.signal,
      onProgress: (progress) => {
        events.push(progress);
        if (progress.phase === "importing" && progress.processed === 1) {
          controller.abort();
        }
      },
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(events.some((event) => event.phase === "discovering")).toBe(true);
    expect(events.some((event) => event.phase === "importing" && event.processed === 1))
      .toBe(true);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual([
        "imported",
        "phase",
        "processed",
        "skipped",
        "total",
        "unchanged",
        "updated",
      ]);
    }

    const rootUri = pathToFileURL(root.endsWith(sep) ? root : `${root}${sep}`).href;
    const sourceId = deterministicId("source", "folder", rootUri, "default");
    const partialDocumentId = deterministicId("document", sourceId, "a.md");
    expect(searchVault(vault, { query: "abortable" })).toEqual([]);
    expect(fetchDocument(vault, { documentId: partialDocumentId })).toBeNull();
    expect(listSources(vault)).toEqual([]);

    vault.close();
    openVaults.splice(openVaults.indexOf(vault), 1);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const counts = db.prepare(`
      SELECT
        (SELECT count(*) FROM sources) AS sources,
        (SELECT count(*) FROM documents) AS documents,
        (SELECT count(*) FROM revisions) AS revisions,
        (SELECT count(*) FROM chunks) AS chunks
    `).get() as Record<string, number>;
    expect(Number(counts.sources)).toBe(0);
    expect(Number(counts.documents)).toBe(0);
    expect(Number(counts.revisions)).toBe(0);
    expect(Number(counts.chunks)).toBe(0);
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
