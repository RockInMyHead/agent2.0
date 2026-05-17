#!/usr/bin/env node

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolveConfig, ensureDirectories } from "./config.js";
import { createDb, tokenEstimate } from "./db.js";
import { ingestAllSources } from "./ingest.js";
import { summarizeAll } from "./summarize.js";

const COMMANDS = [
  "init",
  "ingest",
  "sync-vault",
  "search",
  "recall",
  "status",
  "open-vault",
  "help",
];

function printHelp() {
  console.log(`
OpenClaw Memory Tree — hierarchical memory subsystem

USAGE:
  openclaw-memory <command> [options]

COMMANDS:
  init                  Create directories and SQLite schema
  ingest                Ingest all sources (sessions, workspace, notes)
  sync-vault            Sync edited notes from Obsidian vault back to SQLite
  search "<query>"      Keyword / FTS search over memory
  recall "<query>"      Return compact Markdown context for agent
  status                Show memory statistics
  open-vault            Open Obsidian vault (macOS)
  help                  Show this help

ENV:
  OPENCLAW_HOME          (default: ~/.openclaw)
  OPENCLAW_WORKSPACE     (default: ~/.openclaw/workspace)
  OPENCLAW_MEMORY_DB     (default: ~/.openclaw/memory/memory.db)
  OPENCLAW_MEMORY_VAULT  (default: ~/.openclaw/workspace/wiki)
`);
}

function cmdInit(cfg) {
  console.log("[memory]  Initializing...\n");
  ensureDirectories(cfg);

  const db = createDb(cfg.OPENCLAW_MEMORY_DB);
  db.db.close();

  const ftsStatus = db.hasFts ? "available" : "not available (fallback to LIKE)";
  console.log(`  Memory DB:   ${cfg.OPENCLAW_MEMORY_DB}`);
  console.log(`  Vault:       ${cfg.OPENCLAW_MEMORY_VAULT}`);
  console.log(`  FTS5:        ${ftsStatus}`);
  console.log(`\n[memory]  ✓ Initialized. Run "openclaw-memory ingest" to populate.`);
}

function cmdIngest(cfg) {
  ensureDirectories(cfg);
  const { db } = createDb(cfg.OPENCLAW_MEMORY_DB);

  // Backup ingest state
  const result = ingestAllSources(cfg, db);

  // Generate summaries
  const summaryResult = summarizeAll(db, cfg);

  db.close();
  console.log(`\n[memory]  ✓ Ingestion complete.`);
}

function cmdSyncVault(cfg) {
  console.log("[memory]  Syncing Obsidian vault notes → SQLite...\n");
  ensureDirectories(cfg);
  const { db } = createDb(cfg.OPENCLAW_MEMORY_DB);

  const notesDir = join(cfg.OPENCLAW_MEMORY_VAULT, "notes");
  if (!existsSync(notesDir)) {
    console.log("[memory]  No notes directory found.");
    db.close();
    return;
  }

  // Find notes that have been modified since last sync
  const notes = [];
  try {
    const files = readdirSync(notesDir);
    for (const f of files) {
      if (f.endsWith(".md")) {
        notes.push(join(notesDir, f));
      }
    }
  } catch {
    console.log("[memory]  Cannot read notes directory.");
    db.close();
    return;
  }

  if (notes.length === 0) {
    console.log("[memory]  No notes to sync.");
    db.close();
    return;
  }

  // Import sync-vault logic directly here (or from ingest)
  // We reuse ingestFile for each note
  let synced = 0;
  for (const notePath of notes) {
    const noteStat = statSync(notePath);
    const noteMtime = noteStat.mtime.toISOString();

    // Check if this note has been modified after its last sync
    const existing = db.prepare("SELECT updated_at FROM sources WHERE path = ?").get(notePath);
    if (existing && existing.updated_at >= noteMtime) {
      continue; // unchanged
    }

    const result = ingestFile(
      notePath,
      "note",
      `Note: ${basename(notePath)}`,
      "main",
      "note",
      cfg,
      db,
    );
    if (result > 0) {
      synced++;
      console.log(`[memory]  ✓ Synced ${basename(notePath)} → ${result} chunk(s)`);
    }
  }

  // Regenerate summaries after sync
  if (synced > 0) {
    console.log("");
    summarizeAll(db, cfg);
  }

  db.close();
  console.log(`\n[memory]  ✓ Sync complete. ${synced} note(s) updated.`);
}

function cmdSearch(cfg, query) {
  if (!query) {
    console.error("[memory]  ✗ Usage: openclaw-memory search \"<query>\"");
    process.exit(1);
  }

  const { db, hasFts } = createDb(cfg.OPENCLAW_MEMORY_DB);

  let results;
  if (hasFts) {
    // FTS5 search with prefix matching
    const ftsQuery = query.split(/\s+/).filter((w) => w.length >= 2).map((w) => `${w}*`).join(" OR ");
    results = db.prepare(`
      SELECT c.id, c.title, c.content, c.source_id, c.token_estimate, c.created_at,
             substr(c.content, 1, 300) as snippet,
             s.title as source_title, s.kind as source_kind
      FROM chunks c
      JOIN chunks_fts fts ON c.rowid = fts.rowid
      JOIN sources s ON c.source_id = s.id
      WHERE chunks_fts MATCH ? AND c.status = 'active'
      ORDER BY rank
      LIMIT 10
    `).all(ftsQuery);
  } else {
    // LIKE fallback
    const likeQuery = `%${query}%`;
    results = db.prepare(`
      SELECT c.id, c.title, c.content, c.source_id, c.token_estimate, c.created_at,
             substr(c.content, 1, 300) as snippet,
             s.title as source_title, s.kind as source_kind
      FROM chunks c
      JOIN sources s ON c.source_id = s.id
      WHERE (c.content LIKE ? OR c.title LIKE ?) AND c.status = 'active'
      ORDER BY c.created_at DESC
      LIMIT 10
    `).all(likeQuery, likeQuery);
  }

  // Also search summaries
  let summaries;
  if (hasFts) {
    const ftsQuery = query.split(/\s+/).filter((w) => w.length >= 2).map((w) => `${w}*`).join(" OR ");
    summaries = db.prepare(`
      SELECT summaries.id, summaries.scope, summaries.scope_key, summaries.title, summaries.content, summaries.markdown_path,
             substr(summaries.content, 1, 300) as snippet
      FROM summaries
      JOIN summaries_fts ON summaries.rowid = summaries_fts.rowid
      WHERE summaries_fts MATCH ?
      ORDER BY rank
      LIMIT 5
    `).all(ftsQuery);
  } else {
    const likeQuery = `%${query}%`;
    summaries = db.prepare(`
      SELECT summaries.id, summaries.scope, summaries.scope_key, summaries.title, summaries.content, summaries.markdown_path,
             substr(summaries.content, 1, 300) as snippet
      FROM summaries
      WHERE summaries.content LIKE ? OR summaries.title LIKE ?
      LIMIT 5
    `).all(likeQuery, likeQuery);
  }

  db.close();

  console.log(`\n🔍 Results for "${query}"\n`);

  if (results.length === 0 && summaries.length === 0) {
    console.log("  No results found.\n");
    return;
  }

  if (results.length > 0) {
    console.log(`── Chunks (${results.length}) ──\n`);
    for (const r of results) {
      const score = hasFts ? "" : " (LIKE)";
      console.log(`  [${r.id.substring(0, 8)}] ${r.title}`);
      console.log(`  Source: ${r.source_title} (${r.source_kind})`);
      console.log(`  Tokens: ~${r.token_estimate}`);
      console.log(`  ${r.snippet.replace(/\n/g, " ").substring(0, 200)}...`);
      console.log(`  Provenance: ${r.source_id}`);
      console.log();
    }
  }

  if (summaries.length > 0) {
    console.log(`── Summaries (${summaries.length}) ──\n`);
    for (const s of summaries) {
      console.log(`  [${s.scope}] ${s.title}`);
      console.log(`  Path: ${s.markdown_path || "db-only"}`);
      console.log(`  ${s.snippet.replace(/\n/g, " ").substring(0, 200)}...`);
      console.log();
    }
  }
}

function cmdRecall(cfg, query) {
  if (!query) {
    console.error("[memory]  ✗ Usage: openclaw-memory recall \"<query>\"");
    process.exit(1);
  }

  const { db, hasFts } = createDb(cfg.OPENCLAW_MEMORY_DB);
  const maxTokens = cfg.recallMaxTokens;
  let totalTokens = 0;
  const output = [];

  output.push(`<memory_context>`);
  output.push(`## Relevant Memory`);
  output.push(``);

  // First: find relevant summaries
  let summaries;
  if (hasFts) {
    const ftsQuery = query.split(/\s+/).filter((w) => w.length >= 2).map((w) => `${w}*`).join(" OR ");
    summaries = db.prepare(`
      SELECT summaries.scope, summaries.scope_key, summaries.title, summaries.content, summaries.markdown_path
      FROM summaries
      JOIN summaries_fts ON summaries.rowid = summaries_fts.rowid
      WHERE summaries_fts MATCH ?
      ORDER BY summaries.level ASC, rank
      LIMIT 5
    `).all(ftsQuery);
  } else {
    const likeQuery = `%${query}%`;
    summaries = db.prepare(`
      SELECT summaries.scope, summaries.scope_key, summaries.title, summaries.content, summaries.markdown_path
      FROM summaries
      WHERE summaries.content LIKE ? OR summaries.title LIKE ?
      LIMIT 5
    `).all(likeQuery, likeQuery);
  }

  if (summaries.length > 0) {
    output.push(`### Summaries`);
    output.push(``);

    for (const s of summaries) {
      const tokens = tokenEstimate(s.content);
      if (totalTokens + tokens > maxTokens) break;

      output.push(`**${s.title}** (${s.scope})`);
      output.push(``);
      output.push(s.content);
      output.push(``);
      output.push(`*provenance: ${s.markdown_path || s.scope_key}*`);
      output.push(``);
      totalTokens += tokens;
    }
  }

  // Then: find relevant chunks
  let chunks;
  if (hasFts) {
    const ftsQuery = query.split(/\s+/).filter((w) => w.length >= 2).map((w) => `${w}*`).join(" OR ");
    chunks = db.prepare(`
      SELECT c.id, c.title, c.content, c.source_id, c.token_estimate, c.markdown_path,
             s.title as source_title, s.kind as source_kind
      FROM chunks c
      JOIN chunks_fts fts ON c.rowid = fts.rowid
      JOIN sources s ON c.source_id = s.id
      WHERE chunks_fts MATCH ? AND c.status = 'active'
      ORDER BY rank
      LIMIT 5
    `).all(ftsQuery);
  } else {
    const likeQuery = `%${query}%`;
    chunks = db.prepare(`
      SELECT c.id, c.title, c.content, c.source_id, c.token_estimate, c.markdown_path,
             s.title as source_title, s.kind as source_kind
      FROM chunks c
      JOIN sources s ON c.source_id = s.id
      WHERE (c.content LIKE ? OR c.title LIKE ?) AND c.status = 'active'
      ORDER BY c.created_at DESC
      LIMIT 5
    `).all(likeQuery, likeQuery);
  }

  if (chunks.length > 0) {
    if (summaries.length > 0) {
      output.push(`### Chunks`);
      output.push(``);
    }

    for (const c of chunks) {
      const tokens = tokenEstimate(c.content);
      if (totalTokens + tokens > maxTokens) break;

      output.push(`**${c.title}**`);
      output.push(``);
      output.push(c.content.substring(0, 1000));
      if (c.content.length > 1000) output.push("*(truncated)*");
      output.push(``);
      output.push(`*provenance: ${c.source_title} (${c.source_kind}) — ${c.markdown_path || c.source_id}*`);
      output.push(``);
      totalTokens += tokens;
    }
  }

  output.push(`</memory_context>`);

  db.close();

  if (summaries.length === 0 && chunks.length === 0) {
    console.log(`<memory_context>`);
    console.log(`No relevant memory found for "${query}".`);
    console.log(`</memory_context>`);
    return;
  }

  console.log(`<!-- ~${totalTokens} estimated tokens -->`);
  console.log(output.join("\n"));
}

function cmdStatus(cfg) {
  if (!existsSync(cfg.OPENCLAW_MEMORY_DB)) {
    console.log("\n  Memory not initialized. Run: openclaw-memory init\n");
    return;
  }

  const { db } = createDb(cfg.OPENCLAW_MEMORY_DB);

  const sourceCount = db.prepare("SELECT COUNT(*) as c FROM sources").get().c;
  const chunkCount = db.prepare("SELECT COUNT(*) as c FROM chunks WHERE status = 'active'").get().c;
  const summaryCount = db.prepare("SELECT COUNT(*) as c FROM summaries").get().c;
  const entityCount = db.prepare("SELECT COUNT(*) as c FROM entities").get().c;
  const retrievalCount = db.prepare("SELECT COUNT(*) as c FROM retrieval_events").get().c;

  const totalTokens = db.prepare("SELECT COALESCE(SUM(token_estimate), 0) as t FROM chunks WHERE status = 'active'").get().t;
  const dbSize = existsSync(cfg.OPENCLAW_MEMORY_DB) ? (readFileSync(cfg.OPENCLAW_MEMORY_DB).length) : 0;

  // Source distribution
  const sourceKinds = db.prepare("SELECT kind, COUNT(*) as c FROM sources GROUP BY kind ORDER BY c DESC").all();

  db.close();

  console.log(`\n🧠 Memory Tree Status\n`);
  console.log(`  Database:`);
  console.log(`    Path:   ${cfg.OPENCLAW_MEMORY_DB}`);
  console.log(`    Size:   ${(dbSize / 1024).toFixed(1)} KB`);
  console.log(``);
  console.log(`  Vault:`);
  console.log(`    Path:   ${cfg.OPENCLAW_MEMORY_VAULT}`);
  console.log(``);
  console.log(`  Statistics:`);
  console.log(`    Sources:    ${sourceCount}`);
  console.log(`    Chunks:     ${chunkCount}`);
  console.log(`    Summaries:  ${summaryCount}`);
  console.log(`    Entities:   ${entityCount}`);
  console.log(`    Retrievals: ${retrievalCount}`);
  console.log(`    Total tokens: ~${totalTokens.toLocaleString()}`);
  console.log(``);

  if (sourceKinds.length > 0) {
    console.log(`  Source Distribution:`);
    for (const sk of sourceKinds) {
      console.log(`    ${sk.kind}: ${sk.c}`);
    }
    console.log(``);
  }
}

function cmdOpenVault(cfg) {
  const vaultPath = cfg.OPENCLAW_MEMORY_VAULT;

  // Try Obsidian deep link first
  const encodedPath = encodeURIComponent(vaultPath);
  const obsidianUrl = `obsidian://open?path=${encodedPath}`;

  try {
    execSync(`open "${obsidianUrl}"`, { stdio: "ignore", timeout: 3000 });
    console.log(`\n  Opened Obsidian vault: ${vaultPath}\n`);
  } catch {
    // Fallback: open in Finder
    try {
      execSync(`open "${vaultPath}"`, { stdio: "ignore" });
      console.log(`\n  Opened vault in Finder: ${vaultPath}\n`);
    } catch {
      console.log(`\n  Vault path: ${vaultPath}\n`);
    }
  }
}

// ── Main ──

const cmd = process.argv[2];
const query = process.argv[3];

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

if (!COMMANDS.includes(cmd)) {
  console.error(`[memory]  ✗ Unknown command: "${cmd}"`);
  printHelp();
  process.exit(1);
}

const cfg = resolveConfig();

switch (cmd) {
  case "init":
    cmdInit(cfg);
    break;
  case "ingest":
    cmdIngest(cfg);
    break;
  case "sync-vault":
    cmdSyncVault(cfg);
    break;
  case "search":
    cmdSearch(cfg, query);
    break;
  case "recall":
    cmdRecall(cfg, query);
    break;
  case "status":
    cmdStatus(cfg);
    break;
  case "open-vault":
    cmdOpenVault(cfg);
    break;
}
