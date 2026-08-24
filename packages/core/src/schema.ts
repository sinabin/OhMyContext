import type { VaultStorageConnection } from "./storage.js";

const SCHEMA_VERSION = 3;

/** Hard storage bound for physical retrieval-event rows, not UI entries. */
export const MAX_RETRIEVAL_ACTIVITY_ROWS = 10_000;
const LEGACY_RETRIEVAL_PRUNE_BATCH_ROWS = 1_000;

export function assertSupportedSchemaVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Vault schema version is invalid.");
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Vault schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
}

export function initializeSchema(
  db: VaultStorageConnection,
  inspectedVersion: number,
): void {
  assertSupportedSchemaVersion(inspectedVersion);

  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    PRAGMA journal_mode = WAL;
  `);

  // A healthy current vault needs connection-local pragmas, but no write.
  // Avoid taking BEGIN IMMEDIATE here: another process may legitimately hold
  // the writer slot for a long import while a new read-oriented MCP process
  // opens the same WAL database.
  if (currentSchemaNeedsNoMaintenance(db)) return;

  // v1/v2 history had no physical cap. Securely deleting an unbounded legacy
  // table in the final migration transaction can mirror the entire table into
  // WAL and exhaust disk space. Trim oldest rows in restart-safe committed
  // batches and truncate WAL between them while the old schema remains valid.
  boundLegacyRetrievalRowsBeforeMigration(db);

  // A concurrent opener may have completed the upgrade while this connection
  // was coordinating a legacy WAL checkpoint. Reuse the lock-free current-v3
  // path instead of taking an unnecessary writer transaction afterward.
  if (currentSchemaNeedsNoMaintenance(db)) return;

  db.exec("BEGIN IMMEDIATE;");
  try {
    // The read-only compatibility inspection happens before open and can become
    // stale if two processes race an upgrade. Re-read only after taking the
    // write lock so every migration decision is based on the live generation.
    let version = liveSchemaVersion(db);
    assertSupportedSchemaVersion(version);

    if (version === 0) {
      createVersionOne(db);
      version = 1;
    }

    if (version === 1) {
      migrateVersionOneToTwo(db);
      version = 2;
    }

    if (version === 2) {
      migrateVersionTwoToThree(db);
      version = 3;
    }

    ensureFtsSecureDelete(db);
    pruneRetrievalActivityRows(db);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration error. SQLite may already have rolled back a
      // transaction after a fatal statement failure.
    }
    throw error;
  }
}

function boundLegacyRetrievalRowsBeforeMigration(
  db: VaultStorageConnection,
): void {
  while (true) {
    const observedVersion = liveSchemaVersion(db);
    assertSupportedSchemaVersion(observedVersion);
    if (observedVersion !== 1 && observedVersion !== 2) return;

    // A prior interrupted attempt may already have committed one bounded
    // deletion batch. Never append another batch—or enter the final table
    // replacement—until that WAL has actually been truncated. This makes
    // repeated retries with the same pinned reader write-idempotent.
    if (!truncatedWalCheckpointSucceeded(db)) {
      // The observed v1/v2 generation may already be stale. Serialize a final
      // version read with concurrent migrators before surfacing a pause; a
      // winner that reached v3 makes the legacy checkpoint unnecessary.
      if (!schemaStillNeedsMigrationUnderLock(db)) return;
      throw historyMigrationPausedError();
    }

    db.exec("BEGIN IMMEDIATE;");
    let deleted = 0;
    try {
      const version = liveSchemaVersion(db);
      assertSupportedSchemaVersion(version);
      if (version !== 1 && version !== 2) {
        db.exec("COMMIT;");
        return;
      }

      const cutoff = db.prepare(`
        SELECT id
        FROM retrieval_events
        ORDER BY id DESC
        LIMIT 1 OFFSET ?
      `).get(MAX_RETRIEVAL_ACTIVITY_ROWS - 1) as {
        id?: number | bigint;
      } | undefined;
      if (cutoff?.id === undefined) {
        db.exec("COMMIT;");
        return;
      }

      deleted = Number(db.prepare(`
        DELETE FROM retrieval_events
        WHERE id IN (
          SELECT id
          FROM retrieval_events
          WHERE id < ?
          ORDER BY id
          LIMIT ?
        )
      `).run(cutoff.id, LEGACY_RETRIEVAL_PRUNE_BATCH_ROWS).changes);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Preserve the pruning error if SQLite already ended the transaction.
      }
      throw error;
    }

    if (deleted === 0) return;
  }
}

function truncatedWalCheckpointSucceeded(db: VaultStorageConnection): boolean {
  const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy?: number | bigint;
    log?: number | bigint;
    checkpointed?: number | bigint;
  } | undefined;
  return Number(result?.busy ?? 1) === 0 && Number(result?.log ?? 1) === 0;
}

function schemaStillNeedsMigrationUnderLock(
  db: VaultStorageConnection,
): boolean {
  try {
    db.exec("BEGIN IMMEDIATE;");
  } catch {
    throw historyMigrationPausedError();
  }
  try {
    const version = liveSchemaVersion(db);
    assertSupportedSchemaVersion(version);
    db.exec("COMMIT;");
    return version < SCHEMA_VERSION;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the schema/version error if SQLite already ended the lock.
    }
    throw error;
  }
}

function historyMigrationPausedError(): Error {
  return new Error(
    "Vault history migration paused because another reader prevented a bounded WAL checkpoint. Close other OhMyContext clients and retry.",
  );
}

function currentSchemaNeedsNoMaintenance(db: VaultStorageConnection): boolean {
  if (liveSchemaVersion(db) !== SCHEMA_VERSION) return false;

  const ftsConfig = db.prepare(`
    SELECT v FROM chunks_fts_config WHERE k = 'secure-delete'
  `).get() as { v?: number | bigint } | undefined;
  if (Number(ftsConfig?.v ?? 0) !== 1) return false;

  const excessRow = db.prepare(`
    SELECT 1 AS present
    FROM retrieval_events
    ORDER BY id DESC
    LIMIT 1 OFFSET ?
  `).get(MAX_RETRIEVAL_ACTIVITY_ROWS);
  return excessRow === undefined;
}

function liveSchemaVersion(db: VaultStorageConnection): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: number | bigint;
  } | undefined;
  const version = Number(row?.user_version);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Vault schema version is invalid.");
  }
  return version;
}

function createVersionOne(db: VaultStorageConnection): void {
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      kind TEXT NOT NULL CHECK(kind IN ('folder')),
      root_uri TEXT NOT NULL,
      collection TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_scanned_at TEXT,
      UNIQUE(root_uri, collection)
    ) STRICT;

    CREATE TABLE documents (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      current_revision_id TEXT,
      UNIQUE(source_id, relative_path)
    ) STRICT;

    CREATE TABLE revisions (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(document_id, ordinal)
    ) STRICT;

    CREATE TABLE chunks (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
      heading_path TEXT NOT NULL,
      start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
      end_offset INTEGER NOT NULL CHECK(end_offset >= start_offset),
      content TEXT NOT NULL,
      title TEXT NOT NULL,
      UNIQUE(revision_id, chunk_index)
    ) STRICT;

    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      chunk_id UNINDEXED,
      document_id UNINDEXED,
      revision_id UNINDEXED,
      title,
      heading_path,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER chunks_fts_after_insert AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(
        chunk_id, document_id, revision_id, title, heading_path, content
      ) VALUES (
        new.id, new.document_id, new.revision_id,
        new.title, new.heading_path, new.content
      );
    END;

    CREATE TRIGGER chunks_fts_before_delete BEFORE DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
    END;

    CREATE TRIGGER chunks_fts_after_update AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE chunk_id = old.id;
      INSERT INTO chunks_fts(
        chunk_id, document_id, revision_id, title, heading_path, content
      ) VALUES (
        new.id, new.document_id, new.revision_id,
        new.title, new.heading_path, new.content
      );
    END;

    CREATE TABLE retrieval_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL CHECK(event_type IN ('search', 'fetch')),
      query_hash TEXT CHECK(query_hash IS NULL OR length(query_hash) = 64),
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL,
      result_count INTEGER NOT NULL CHECK(result_count >= 0),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX documents_source_idx ON documents(source_id);
    CREATE INDEX documents_current_revision_idx ON documents(current_revision_id);
    CREATE INDEX revisions_document_idx ON revisions(document_id, ordinal);
    CREATE INDEX chunks_document_revision_idx
      ON chunks(document_id, revision_id, chunk_index);
    CREATE INDEX retrieval_events_created_idx ON retrieval_events(created_at);

    PRAGMA user_version = 1;
  `);
}

function migrateVersionOneToTwo(db: VaultStorageConnection): void {
  db.exec(`
    CREATE TABLE deletion_receipts (
      id TEXT PRIMARY KEY CHECK(length(id) = 64),
      target_kind TEXT NOT NULL CHECK(target_kind = 'source'),
      target_id TEXT NOT NULL CHECK(length(target_id) = 64),
      completed_at TEXT NOT NULL,
      source_count INTEGER NOT NULL CHECK(source_count = 1),
      document_count INTEGER NOT NULL CHECK(document_count >= 0),
      revision_count INTEGER NOT NULL CHECK(revision_count >= 0),
      chunk_count INTEGER NOT NULL CHECK(chunk_count >= 0),
      fts_entry_count INTEGER NOT NULL CHECK(fts_entry_count >= 0),
      retrieval_event_count INTEGER NOT NULL CHECK(retrieval_event_count >= 0),
      assurance TEXT NOT NULL CHECK(assurance = 'logical-non-addressability'),
      original_files_modified INTEGER NOT NULL CHECK(original_files_modified = 0),
      secure_erase_claimed INTEGER NOT NULL CHECK(secure_erase_claimed = 0)
    ) STRICT;

    CREATE INDEX deletion_receipts_completed_idx
      ON deletion_receipts(completed_at DESC, id DESC);
    CREATE INDEX deletion_receipts_target_idx
      ON deletion_receipts(target_kind, target_id, completed_at DESC);

    INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 1);
    -- Rebuild once so a version-one vault does not retain index entries from a
    -- document that was logically deleted before FTS secure-delete existed.
    INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
    PRAGMA user_version = 2;
  `);
}

function migrateVersionTwoToThree(db: VaultStorageConnection): void {
  db.exec(`
    CREATE TABLE retrieval_events_v3 (
      id INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL CHECK(
        length(request_id) = 64 AND
        request_id NOT GLOB '*[^0-9a-f]*'
      ),
      client_kind TEXT NOT NULL CHECK(
        client_kind IN ('legacy', 'desktop', 'codex', 'claude-code')
      ),
      event_type TEXT NOT NULL CHECK(event_type IN ('search', 'fetch')),
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      chunk_id TEXT REFERENCES chunks(id) ON DELETE SET NULL,
      result_count INTEGER NOT NULL CHECK(result_count >= 0),
      created_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO retrieval_events_v3(
      id, request_id, client_kind, event_type, document_id,
      chunk_id, result_count, created_at
    )
    WITH source_rows AS (
      -- Bound the copy itself instead of copying an unbounded v2 table and
      -- pruning afterward. This avoids temporarily duplicating the complete
      -- legacy history inside the same database during upgrade.
      SELECT *
      FROM retrieval_events
      ORDER BY id DESC
      LIMIT ${MAX_RETRIEVAL_ACTIVITY_ROWS}
    ),
    partitioned AS (
      SELECT
        source_rows.*,
        row_number() OVER (
          PARTITION BY event_type, query_hash, result_count, created_at
          ORDER BY id
        ) AS family_ordinal
      FROM source_rows
    ),
    segmented AS (
      SELECT
        partitioned.*,
        id - family_ordinal AS contiguous_key
      FROM partitioned
    ),
    numbered AS (
      SELECT
        segmented.*,
        row_number() OVER (
          PARTITION BY
            event_type, query_hash, result_count, created_at, contiguous_key
          ORDER BY id
        ) AS segment_ordinal
      FROM segmented
    ),
    batched AS (
      SELECT
        numbered.*,
        CASE
          WHEN event_type = 'search' AND result_count > 0
            THEN CAST((segment_ordinal - 1) / result_count AS INTEGER)
          ELSE segment_ordinal - 1
        END AS batch_ordinal
      FROM numbered
    ),
    anchored AS (
      SELECT
        batched.*,
        min(id) OVER (
          PARTITION BY
            event_type, query_hash, result_count, created_at,
            contiguous_key, batch_ordinal
        ) AS request_anchor_id
      FROM batched
    )
    SELECT
      id,
      printf('6c65676163790000%048x', request_anchor_id),
      'legacy',
      event_type,
      document_id,
      chunk_id,
      result_count,
      created_at
    FROM anchored;

    DROP TABLE retrieval_events;
    ALTER TABLE retrieval_events_v3 RENAME TO retrieval_events;

    CREATE INDEX retrieval_events_created_idx
      ON retrieval_events(created_at DESC, id DESC);
    CREATE INDEX retrieval_events_request_idx
      ON retrieval_events(request_id, id);

    PRAGMA user_version = 3;
  `);
}

/** Keeps both migrated and newly written databases inside the physical row cap. */
export function pruneRetrievalActivityRows(db: VaultStorageConnection): void {
  db.prepare(`
    DELETE FROM retrieval_events
    WHERE id NOT IN (
      SELECT id
      FROM retrieval_events
      ORDER BY id DESC
      LIMIT ?
    )
  `).run(MAX_RETRIEVAL_ACTIVITY_ROWS);
}

function ensureFtsSecureDelete(db: VaultStorageConnection): void {
  const row = db.prepare(`
    SELECT v FROM chunks_fts_config WHERE k = 'secure-delete'
  `).get() as { v: number | bigint } | undefined;
  if (Number(row?.v ?? 0) === 1) return;

  db.exec(`
    INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 1);
    INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
  `);
}
