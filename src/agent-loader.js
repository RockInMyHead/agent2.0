#!/usr/bin/env node

/**
 * Agent Memory Loader — called by OpenClaw agent when loading context.
 *
 * Usage:
 *   node src/agent-loader.js "<user prompt>" [--max-tokens <N>]
 *
 * Outputs a compact <memory_context> Markdown block to stdout.
 * If no relevant memory found, outputs nothing (empty).
 *
 * Designed to be called from the agent's system prompt assembly
 * or from a tool/skill execution context.
 */

import { createDb, tokenEstimate } from "./db.js";
import { resolveConfig } from "./config.js";
import { existsSync } from "node:fs";

function extractKeyTerms(prompt) {
  // Extract meaningful terms from user prompt
  const terms = [];

  // Extract quoted phrases
  const quoted = prompt.match(/"([^"]+)"/g);
  if (quoted) terms.push(...quoted.map((q) => q.replace(/"/g, "")));

  // Extract hashtags
  const hashtags = prompt.match(/#(\w+)/g);
  if (hashtags) terms.push(...hashtags.map((h) => h.slice(1)));

  // Extract capitalized project names (CamelCase, UPPER_CASE)
  const projects = prompt.match(/\b[A-Z][a-z]+[A-Z]\w*\b/g);
  if (projects) terms.push(...projects);

  // Extract words with 4+ chars (skip common words)
  const words = prompt
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !["this", "that", "with", "from", "what", "when", "where", "which", "there", "about", "could", "would", "should", "have", "been", "does", "doing", "made", "make", "like", "just", "also", "very", "well", "some", "more", "than", "then", "your", "tell", "show", "need", "want", "know", "look", "work", "help", "find", "give", "take", "come", "done", "used", "using", "based", "called", "going", "thing", "things", "think", "might", "being", "said"].includes(w))
    .slice(0, 5);

  terms.push(...words);

  return [...new Set(terms)];
}

function searchMemory(db, hasFts, query, maxTokens) {
  const output = [];
  let totalTokens = 0;

  const ftsQuery = query
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .map((w) => `${w}*`)
    .join(" OR ");

  if (!ftsQuery.trim()) return output;

  // Search summaries
  let summaries;
  if (hasFts) {
    try {
      summaries = db.prepare(`
        SELECT summaries.scope, summaries.scope_key, summaries.title, summaries.content, summaries.markdown_path
        FROM summaries
        JOIN summaries_fts ON summaries.rowid = summaries_fts.rowid
        WHERE summaries_fts MATCH ?
        ORDER BY summaries.level ASC, rank
        LIMIT 3
      `).all(ftsQuery);
    } catch (e) {
      summaries = [];
    }
  }

  if (summaries && summaries.length > 0) {
    output.push(`### Summaries`);
    output.push(``);
    for (const s of summaries) {
      const tokens = tokenEstimate(s.content);
      if (totalTokens + tokens > maxTokens) break;
      output.push(`**${s.title}** (${s.scope})`);
      output.push(``);
      // Include first few lines of summary content
      const lines = s.content.split("\n").slice(0, 12).join("\n");
      output.push(lines);
      output.push(``);
      output.push(`*provenance: ${s.scope}:${s.scope_key}*`);
      output.push(``);
      totalTokens += tokens;
    }
  }

  // Search chunks
  let chunks;
  if (hasFts) {
    try {
      chunks = db.prepare(`
        SELECT c.title, c.content, c.token_estimate, s.title as source_title, s.kind as source_kind
        FROM chunks c
        JOIN chunks_fts fts ON c.rowid = fts.rowid
        JOIN sources s ON c.source_id = s.id
        WHERE chunks_fts MATCH ? AND c.status = 'active'
        ORDER BY rank
        LIMIT 3
      `).all(ftsQuery);
    } catch {
      chunks = [];
    }
  }

  if (chunks && chunks.length > 0) {
    if (output.length > 0) output.push(`### Details`);
    output.push(``);
    for (const c of chunks) {
      const tokens = tokenEstimate(c.content);
      if (totalTokens + tokens > maxTokens) break;
      output.push(`**${c.title}**`);
      output.push(``);
      output.push(c.content.substring(0, 800));
      if (c.content.length > 800) output.push("*(truncated)*");
      output.push(``);
      output.push(`*source: ${c.source_title} (${c.source_kind})*`);
      output.push(``);
      totalTokens += tokens;
    }
  }

  return output;
}

function main() {
  const args = process.argv.slice(2);
  const prompt = args.filter((a) => !a.startsWith("--")).join(" ");
  const maxTokensIdx = args.indexOf("--max-tokens");
  const maxTokens = maxTokensIdx >= 0 ? parseInt(args[maxTokensIdx + 1], 10) : 4000;

  if (!prompt) {
    process.exit(0);
  }

  const cfg = resolveConfig();
  if (!existsSync(cfg.OPENCLAW_MEMORY_DB)) {
    process.exit(0);
  }

  const { db, hasFts } = createDb(cfg.OPENCLAW_MEMORY_DB);

  // Build query from key terms
  const terms = extractKeyTerms(prompt);
  // Build query: use original prompt as primary, key terms as boosters
  const query = prompt + " " + terms.join(" ");

  if (!query.trim()) {
    db.close();
    process.exit(0);
  }

  const output = searchMemory(db, hasFts, query, maxTokens);
  db.close();

  if (output.length > 0) {
    console.log(`<memory_context>`);
    console.log(output.join("\n"));
    console.log(`</memory_context>`);
  }
}

main();
