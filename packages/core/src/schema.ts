import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    PRAGMA journal_mode = WAL;
  `);

  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  let version = Number(row?.user_version ?? 0);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Vault schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }

  if (version === 0) {
    createVersionOne(db);
    version = 1;
  }

  if (version === 1) {
    migrateVersionOneToTwo(db);
    version = 2;
  }

  if (version === 2) {
    ensureFtsSecureDelete(db);
  }
}

function createVersionOne(db: DatabaseSync): void {
  db.exec(`
    BEGIN IMMEDIATE;

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
    COMMIT;
  `);
}

function migrateVersionOneToTwo(db: DatabaseSync): void {
  db.exec(`
    BEGIN IMMEDIATE;

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
    COMMIT;
  `);
}

function ensureFtsSecureDelete(db: DatabaseSync): void {
  const row = db.prepare(`
    SELECT v FROM chunks_fts_config WHERE k = 'secure-delete'
  `).get() as { v: number | bigint } | undefined;
  if (Number(row?.v ?? 0) === 1) return;

  db.exec(`
    BEGIN IMMEDIATE;
    INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 1);
    INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
    COMMIT;
  `);
}
