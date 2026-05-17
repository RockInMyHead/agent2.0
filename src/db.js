import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  agent TEXT,
  title TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  agent TEXT,
  scope TEXT,
  title TEXT,
  content TEXT NOT NULL,
  markdown_path TEXT,
  token_estimate INTEGER DEFAULT 0,
  content_hash TEXT,
  status TEXT DEFAULT 'active',
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT,
  level INTEGER DEFAULT 0,
  title TEXT,
  content TEXT,
  markdown_path TEXT,
  source_chunk_ids TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'unknown',
  normalized_name TEXT,
  mentions_count INTEGER DEFAULT 1,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS chunk_entities (
  chunk_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (chunk_id, entity_id),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id),
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrieval_events (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  result_chunk_ids TEXT,
  created_at TEXT NOT NULL
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, title,
  content='chunks', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content, title,
  content='summaries', content_rowid='rowid',
  tokenize='porter unicode61'
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, old.title);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, old.title);
  INSERT INTO chunks_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, old.title);
END;

CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content, title) VALUES('delete', old.rowid, old.content, old.title);
  INSERT INTO summaries_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
END;
`;

export function createDb(dbPath) {
  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath);

  if (isNew) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }

  db.exec(SCHEMA_SQL);

  // Try FTS5 — graceful fallback if not available
  let hasFts = false;
  try {
    db.exec("SELECT 1 FROM sqlite_master WHERE name='chunks_fts'");
    const hasftsTable = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").get();
    if (!hasftsTable) {
      db.exec(FTS_SQL);
      db.exec(FTS_TRIGGERS_SQL);
    }
    hasFts = true;
  } catch {
    try {
      db.exec(FTS_SQL);
      db.exec(FTS_TRIGGERS_SQL);
      hasFts = true;
    } catch {
      console.warn("[memory] FTS5 not available, falling back to LIKE search");
    }
  }

  return { db, hasFts };
}

export function generateId(seed) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(seed).digest("hex").substring(0, 32);
}

export function tokenEstimate(text) {
  return Math.ceil((text || "").length / 4);
}

export function now() {
  return new Date().toISOString();
}
