import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { generateId, tokenEstimate, now } from "./db.js";

/**
 * Extractive summary generator for MVP.
 * No LLM required — uses simple heuristics:
 * - title, source count, chunk count, top entities
 * - bullet list of first relevant sentences per chunk
 * 
 * Architecture supports swapping in LLM summary generator later
 * via the OpenClaw model routing / Ollama Bridge.
 */

/** Convert any string to a safe, human-readable filename */
function toSafeFilename(name) {
  let clean = name.replace(/\.[^.]+$/, ""); // strip extension
  clean = clean
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 100);
  return clean || "untitled";
}

function firstRelevantSentences(text, maxSentences = 3) {
  // For code files, prefer function/class/method signatures (full line)
  const lines = text.split('\n');
  const sigLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Match: def ..., class ..., async def ..., function ..., etc.
    if (/^(def |class |async def |function |export (default )?(function|class) )/.test(trimmed)) {
      // Extract full signature up to the first ':'
      const sigEnd = trimmed.indexOf(':');
      sigLines.push(sigEnd > 0 ? trimmed.substring(0, sigEnd).trim() : trimmed);
      if (sigLines.length >= maxSentences) break;
    }
  }
  if (sigLines.length > 0) return sigLines;

  const sentences = text.match(/[^.!?\n]+[.!?]?/g) || [];
  const result = [];
  for (const s of sentences) {
    const trimmed = s.trim();
    if (trimmed.length < 10) continue;
    if (result.length >= maxSentences) break;
    result.push(trimmed);
  }
  return result;
}

function summarizeSource(sourceId, db, cfg) {
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
  if (!source) return;

  const chunks = db.prepare("SELECT * FROM chunks WHERE source_id = ? AND status = 'active'").all(sourceId);
  if (chunks.length === 0) return;

  const safeName = toSafeFilename(source.title);

  // Build summary content
  const lines = [];
  lines.push(`# ${source.title}`);
  lines.push(``);
  lines.push(`- **Source**: \`${source.path}\``);
  lines.push(`- **Kind**: ${source.kind}`);
  lines.push(`- **Agent**: ${source.agent || "none"}`);
  lines.push(`- **Chunks**: ${chunks.length}`);
  lines.push(`- **Created**: ${source.created_at}`);
  lines.push(`- **Updated**: ${source.updated_at}`);
  lines.push(``);
  lines.push(`## Overview`);
  lines.push(``);

  // Gather first chunk content preview with wikilinks
  for (const chunk of chunks) {
    const chunkLink = `[[../chunks/${chunk.id.substring(0, 2)}/${safeName}--part-${chunk.title.match(/part (\d+)/i)?.[1] || "?"}.md|${chunk.title}]]`;
    const sentences = firstRelevantSentences(chunk.content, 2);
    if (sentences.length > 0) {
      lines.push(`- ${chunkLink}: ${sentences[0]}`);
      if (sentences.length > 1) {
        lines.push(`  ${sentences[1]}`);
      }
    } else {
      lines.push(`- ${chunkLink}`);
    }
  }

  // Top entities — use DISTINCT to avoid duplicates across chunks
  const entities = db.prepare(`
    SELECT DISTINCT e.name, e.kind, e.mentions_count
    FROM entities e
    JOIN chunk_entities ce ON e.id = ce.entity_id
    WHERE ce.chunk_id IN (${chunks.map(() => "?").join(",")})
    ORDER BY e.mentions_count DESC
    LIMIT 10
  `).all(...chunks.map((c) => c.id));

  if (entities.length > 0) {
    lines.push(``);
    lines.push(`## Key Entities`);
    lines.push(``);
    for (const e of entities) {
      lines.push(`- **${e.name}** (${e.kind}) — ${e.mentions_count} mention(s)`);
    }
  }

  const content = lines.join("\n");
  const summaryHash = createHash("sha256").update(content).digest("hex");
  const summaryId = generateId(`summary:source:${sourceId}`);

  const mdDir = join(cfg.OPENCLAW_MEMORY_VAULT, "summaries", "sources");
  mkdirSync(mdDir, { recursive: true });
  const mdPath = join(mdDir, `${safeName}.md`);

  writeFileSync(mdPath, content, "utf-8");

  const insertSummary = db.prepare(`
    INSERT INTO summaries (id, scope, scope_key, level, title, content, markdown_path, source_chunk_ids, content_hash, created_at, updated_at)
    VALUES (?, 'source', ?, 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      markdown_path = excluded.markdown_path,
      source_chunk_ids = excluded.source_chunk_ids,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);
  insertSummary.run(
    summaryId,
    sourceId,
    source.title,
    content,
    mdPath,
    chunks.map((c) => c.id).join(","),
    summaryHash,
    now(),
    now(),
  );
}

function summarizeTopics(db, cfg) {
  const topics = db.prepare(`
    SELECT e.id, e.name, e.normalized_name, e.mentions_count
    FROM entities e
    WHERE e.kind = 'topic' AND e.mentions_count >= 2
    ORDER BY e.mentions_count DESC
  `).all();

  for (const topic of topics) {
    const chunks = db.prepare(`
      SELECT c.id, c.title, c.content, c.source_id, c.created_at
      FROM chunks c
      JOIN chunk_entities ce ON c.id = ce.chunk_id
      WHERE ce.entity_id = ? AND c.status = 'active'
      ORDER BY c.created_at DESC
      LIMIT 10
    `).all(topic.id);

    if (chunks.length < 2) continue;

    const lines = [];
    lines.push(`# Topic: ${topic.name}`);
    lines.push(``);
    lines.push(`- **Mentions**: ${topic.mentions_count}`);
    lines.push(`- **Chunks**: ${chunks.length}`);
    lines.push(`- **Last updated**: ${now()}`);
    lines.push(``);
    lines.push(`## Related Chunks`);
    lines.push(``);

    for (const chunk of chunks) {
      // Derive safe filename from chunk title (format: "filename -- part N")
      const partMatch = chunk.title.match(/part (\d+)/i);
      const sourceTitle = chunk.title.replace(/ — part \d+$/i, "").trim();
      const safeName = toSafeFilename(sourceTitle);
      const partNum = partMatch?.[1] || "1";
      const chunkLink = `[[../chunks/${chunk.id.substring(0, 2)}/${safeName}--part-${partNum}.md|${chunk.title}]]`;
      const sentences = firstRelevantSentences(chunk.content, 1);
      if (sentences.length > 0) {
        lines.push(`- ${chunkLink}: ${sentences[0]}`);
      } else {
        lines.push(`- ${chunkLink}`);
      }
    }

    const content = lines.join("\n");
    const summaryHash = createHash("sha256").update(content).digest("hex");
    const summaryId = generateId(`summary:topic:${topic.normalized_name}`);

    const safeTopicName = toSafeFilename(topic.name);
    const mdDir = join(cfg.OPENCLAW_MEMORY_VAULT, "summaries", "topics");
    mkdirSync(mdDir, { recursive: true });
    const mdPath = join(mdDir, `${safeTopicName}.md`);

    writeFileSync(mdPath, content, "utf-8");

    const insertSummary = db.prepare(`
      INSERT INTO summaries (id, scope, scope_key, level, title, content, markdown_path, source_chunk_ids, content_hash, created_at, updated_at)
      VALUES (?, 'topic', ?, 2, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        markdown_path = excluded.markdown_path,
        source_chunk_ids = excluded.source_chunk_ids,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `);
    insertSummary.run(
      summaryId,
      topic.name,
      `Topic: ${topic.name}`,
      content,
      mdPath,
      chunks.map((c) => c.id).join(","),
      summaryHash,
      now(),
      now(),
    );
  }
}

function summarizeGlobal(db, cfg) {
  // Generate daily summary for today
  const today = now().substring(0, 10);
  const todayChunks = db.prepare(`
    SELECT c.*, s.title as source_title, s.kind as source_kind
    FROM chunks c
    JOIN sources s ON c.source_id = s.id
    WHERE c.created_at >= ? AND c.status = 'active'
    ORDER BY c.created_at DESC
    LIMIT 50
  `).all(`${today}T00:00:00.000Z`);

  const totalSources = db.prepare("SELECT COUNT(*) as count FROM sources").get().count;
  const totalChunks = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE status = 'active'").get().count;
  const totalEntities = db.prepare("SELECT COUNT(*) as count FROM entities").get().count;

  const lines = [];
  lines.push(`# Memory Overview — ${today}`);
  lines.push(``);
  lines.push(`## Statistics`);
  lines.push(``);
  lines.push(`- **Total sources**: ${totalSources}`);
  lines.push(`- **Total chunks**: ${totalChunks}`);
  lines.push(`- **Total entities**: ${totalEntities}`);

  if (todayChunks.length > 0) {
    lines.push(``);
    lines.push(`## Today's Activity`);
    lines.push(``);

    const seenSources = new Map(); // source_id -> { title, kind }
    for (const chunk of todayChunks) {
      if (!seenSources.has(chunk.source_id)) {
        seenSources.set(chunk.source_id, {
          title: chunk.source_title,
          kind: chunk.source_kind,
        });
      }
    }

    for (const [sourceId, info] of seenSources) {
      const safeName = toSafeFilename(info.title);
      const srcLink = `[[../sources/${safeName}.md|${info.title}]]`;
      lines.push(`- **${srcLink}** (${info.kind})`);
    }
  }

  // Top entities overall — DISTINCT to avoid duplicates
  const topEntities = db.prepare(`
    SELECT DISTINCT name, kind, mentions_count FROM entities ORDER BY mentions_count DESC LIMIT 15
  `).all();

  if (topEntities.length > 0) {
    lines.push(``);
    lines.push(`## Top Entities`);
    lines.push(``);
    for (const e of topEntities) {
      const safeName = toSafeFilename(e.name);
      const topicLink = `[[../summaries/topics/${safeName}.md|${e.name}]]`;
      lines.push(`- **${topicLink}** (${e.kind}) — ${e.mentions_count}`);
    }
  }

  // Link to topic summaries
  const topicSourcesSummary = db.prepare("SELECT scope_key, title FROM summaries WHERE scope = 'topic' ORDER BY title LIMIT 10").all();
  if (topicSourcesSummary.length > 0) {
    lines.push(``);
    lines.push(`## Topic Summaries`);
    lines.push(``);
    for (const t of topicSourcesSummary) {
      const safeName = toSafeFilename(t.scope_key);
      lines.push(`- [[../summaries/topics/${safeName}.md|${t.title.replace(/^Topic: /, "")}]]`);
    }
  }

  const content = lines.join("\n");
  const summaryHash = createHash("sha256").update(content).digest("hex");
  const summaryId = generateId(`summary:global:${today}`);

  const mdDir = join(cfg.OPENCLAW_MEMORY_VAULT, "summaries", "global");
  mkdirSync(mdDir, { recursive: true });
  const mdPath = join(mdDir, `${today}_global-summary.md`);

  writeFileSync(mdPath, content, "utf-8");

  const insertSummary = db.prepare(`
    INSERT INTO summaries (id, scope, scope_key, level, title, content, markdown_path, source_chunk_ids, content_hash, created_at, updated_at)
    VALUES (?, 'global', ?, 0, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      markdown_path = excluded.markdown_path,
      source_chunk_ids = excluded.source_chunk_ids,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);

  const sourceIds = [...new Set(todayChunks.map((c) => c.source_id))];
  insertSummary.run(
    summaryId,
    today,
    `Memory Overview — ${today}`,
    content,
    mdPath,
    sourceIds.join(","),
    summaryHash,
    now(),
    now(),
  );
}

export function summarizeAll(db, cfg) {
  console.log("[memory]  Generating summaries...\n");

  // 1. Source summaries
  const sources = db.prepare("SELECT id FROM sources").all();
  for (const src of sources) {
    summarizeSource(src.id, db, cfg);
  }
  console.log(`[memory]  ✓ ${sources.length} source summary(ies)`);

  // 2. Topic summaries
  summarizeTopics(db, cfg);
  const topicCount = db.prepare("SELECT COUNT(*) as c FROM summaries WHERE scope = 'topic'").get().c;
  console.log(`[memory]  ✓ ${topicCount} topic summary(ies)`);

  // 3. Global daily summary
  summarizeGlobal(db, cfg);
  console.log(`[memory]  ✓ Global summary generated`);

  return { sources: sources.length, topics: topicCount };
}
