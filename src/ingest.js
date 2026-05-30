import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { generateId, tokenEstimate, now } from "./db.js";
import { deleteVaultPaths, collectVaultPathsForSource, pruneOrphanVaultFiles } from "./vault-cleanup.js";

const IGNORE_PATTERNS = [
  /\.env$/,
  /\.pem$/,
  /\.key$/,
  /\.crt$/,
  /node_modules(\/|$)/,
  /\.git(\/|$)/,
  /\/dist\//,
  /\/build\//,
  /\/logs\//,
  /memory\.db$/,
  /__pycache__(\/|$)/,
  /\.venv(\/|$)/,
  /\/venv\//,
  /\.tmp(\/|$)/,
  /\.cache(\/|$)/,
];

const SESSION_SKIP_PATTERNS = [
  /\.trajectory\.jsonl$/,
  /\.checkpoint\./,
  /\.reset\./,
  /^sessions\.json$/,
];

const TOPIC_NOISE = new Set([
  "include", "define", "endif", "ifndef", "pragma", "aaa", "bbb", "ccc", "ddd", "eee", "fff",
  "github", "features", "contact", "configuration", "installation", "license", "tools",
  "start-of-content", "end-of-content", "list-branches", "get-a-repository",
]);

function isIgnored(filePath) {
  return IGNORE_PATTERNS.some((p) => p.test(filePath));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Redact sensitive information from content before storing.
 * Only redacts:
 * - password = '...' assignments (literal password fields in code)
 * - http://user:pass@host URLs
 * - Public IP addresses (not private ranges)
 * - SSH key paths (~/.ssh/id_*)
 * 
 * Does NOT redact @mentions, npm packages, CSS params, or URLs with @.
 */
function redactSensitive(content) {
  let cleaned = content;

  // 1. Redact password = '...' or password = "..." — only whole-word assignments
  cleaned = cleaned.replace(/(password\s*=\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2");

  // 2. Redact inline passwords in URLs: protocol://user:pass@host (but not npm/GitHub @)
  // Only match when there's a port-less host after @, or known pattern
  cleaned = cleaned.replace(/(https?:\/\/)[^:/\s]+:[^@\s]+@/g, "$1[REDACTED]:[REDACTED]@");

  // 3. Redact public IP addresses (not private ranges: 0.x, 127.x, 192.168.x, 10.x, 172.16-31.x)
  cleaned = cleaned.replace(/\b(?!(?:0\.|127\.|192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])))(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
    (match) => {
      const parts = match.split(".").map(Number);
      if (parts.some((p) => p > 255)) return match;
      return "[REDACTED_IP]";
    }
  );

  // 4. Redact SSH key paths (~/.ssh/id_*, /home/*/.ssh/id_*)
  cleaned = cleaned.replace(/(~|(\/home\/[\w-]+))\/\.ssh\/id_\S+/g, "[REDACTED_SSH_KEY]");

  // 5. Redact inline API keys: token = '...', secret = '...' (but not env-var references)
  cleaned = cleaned.replace(/\b(?:token|secret|api_key|apikey)\s*=\s*['"][A-Za-z0-9_\-=]{16,}['"]/gi, (match) => {
    const eqIdx = match.indexOf("=");
    const prefix = match.substring(0, eqIdx + 1).trim();
    return `${prefix} '[REDACTED]'`;
  });

  // 6. Standalone API key patterns in chat/logs
  cleaned = cleaned.replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_KEY]");
  cleaned = cleaned.replace(/\b(fc_pat_[A-Za-z0-9]{20,})\b/g, "[REDACTED_KEY]");
  cleaned = cleaned.replace(/\b(?:api[_-]?key|ключ)\s*[:=-]\s*['"]?[A-Za-z0-9_\-=]{16,}['"]?/gi, "[REDACTED_KEY]");

  return cleaned;
}

function stripSessionEnrichment(text) {
  let s = text;
  s = s.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/gi, "");
  s = s.replace(/Sender \(untrusted metadata\):[\s\S]*?```\s*/gi, "");
  s = s.replace(/Conversation context \(untrusted[^)]*\):[\s\S]*?(?=\n\n### |\n\n[A-Z#]|\n*$)/gi, "");
  s = s.replace(/Reply target of current user message[\s\S]*?```\s*/gi, "");
  s = s.replace(/\[media attached:[^\]]+\]\s*/gi, "");
  s = s.replace(/^\[Image\]\s*$/gim, "");
  s = s.replace(/^User text:\s*/gim, "");
  s = s.replace(/^Description:\s*/gim, "");
  s = s.replace(/^\[[^\]]+\]\s+[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\n]*\n/gm, "");
  return s.trim();
}

function isLowValueSessionMessage(role, text) {
  if (!text || text.length < 2) return true;
  const t = text.trim();
  if (/^\[OpenClaw heartbeat poll\]$/i.test(t)) return true;
  if (/^HEARTBEAT_OK$/i.test(t)) return true;
  if (/^\[assistant turn failed/i.test(t)) return true;
  if (/^⚠️ Something went wrong while processing/i.test(t)) return true;
  if (/^NO_REPLY$/i.test(t)) return true;
  if (role === "tool" && t.length > 4000) return true;
  return false;
}

function shouldSkipSessionFile(name) {
  return SESSION_SKIP_PATTERNS.some((p) => p.test(name));
}

function shouldSkipWorkspaceMd(name, relPath) {
  const lower = name.toLowerCase();
  // Skip boilerplate from cloned repos (keep root-level agent docs)
  if (lower === "readme.md" && relPath.split("/").length > 2) return true;
  if (lower === "contributing.md" && relPath.includes("/")) return true;
  if (lower === "security.md" && relPath.includes("/")) return true;
  if (lower === "changelog.md" && relPath.includes("/")) return true;
  return false;
}

/** Convert any string to a safe, human-readable filename */
function toSafeFilename(name) {
  // Remove extension, lowercase, replace non-alphanumeric with dashes
  let clean = name.replace(/\.[^.]+$/, ""); // strip extension
  clean = clean
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-") // keep cyrillic
    .replace(/^-+|-+$/g, "")
    .substring(0, 100);
  return clean || "untitled";
}

function splitIntoChunks(text, sourceId, sourceTitle, agent, scope, targetTokens, maxTokens) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    const paraTokens = tokenEstimate(para);

    if (currentLen + paraTokens > maxTokens && current.length > 0) {
      chunks.push(current.join("\n\n"));
      current = [para];
      currentLen = paraTokens;
    } else if (currentLen + paraTokens > targetTokens && current.length > 0) {
      // Check if adding this para would exceed hard limit
      if (currentLen + paraTokens > maxTokens) {
        chunks.push(current.join("\n\n"));
        current = [para];
        currentLen = paraTokens;
      } else {
        current.push(para);
        currentLen += paraTokens;
      }
    } else {
      current.push(para);
      currentLen += paraTokens;
    }

    // If a single paragraph exceeds max, force-split it
    if (currentLen > maxTokens && current.length === 1) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentLen = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  // Split any chunk that's still > maxTokens
  const result = [];
  for (const chunk of chunks) {
    if (tokenEstimate(chunk) > maxTokens) {
      // Rough split by sentences
      const sentences = chunk.match(/[^.!?\n]+[.!?]?/g) || [chunk];
      let buf = [];
      let bufLen = 0;
      for (const s of sentences) {
        const sTokens = tokenEstimate(s);
        if (bufLen + sTokens > maxTokens && buf.length > 0) {
          result.push(buf.join(""));
          buf = [s];
          bufLen = sTokens;
        } else {
          buf.push(s);
          bufLen += sTokens;
        }
      }
      if (buf.length > 0) result.push(buf.join(""));
    } else {
      result.push(chunk);
    }
  }

  return result.filter((c) => c.trim().length > 0);
}

export function ingestFile(filePath, sourceKind, sourceTitle, agent, scope, cfg, db) {
  try {
    if (isIgnored(filePath)) return 0;

    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      console.warn(`[memory]  ⚠  Cannot read ${filePath}, skipping`);
      return 0;
    }

    // Canonicalize to Markdown
    let markdownContent = content;
    if (extname(filePath) === ".jsonl") {
      markdownContent = canonicalizeJsonl(content, filePath, agent);
    } else if (extname(filePath) === ".py" || extname(filePath) === ".js" || extname(filePath) === ".sh") {
      // Wrap scripts in code blocks
      markdownContent = `## ${basename(filePath)}\n\n\`\`\`${extname(filePath).slice(1)}\n${content}\n\`\`\``;
    }

    // Redact sensitive information
    if (markdownContent) {
      markdownContent = redactSensitive(markdownContent);
    }

    if (!markdownContent || markdownContent.trim().length === 0) return 0;

    const contentHash = sha256(markdownContent);

    // Check if this file already exists as a source
    const existingSource = db.prepare("SELECT id FROM sources WHERE path = ? AND content_hash = ?").get(filePath, contentHash);
    if (existingSource) {
      return 0; // Duplicate, skip
    }

    const vaultSourcesDir = join(cfg.OPENCLAW_MEMORY_VAULT, "sources");
    mkdirSync(vaultSourcesDir, { recursive: true });

    const existingByPath = db.prepare("SELECT id, title FROM sources WHERE path = ?").get(filePath);
    if (existingByPath) {
      const oldSafe = toSafeFilename(existingByPath.title || basename(filePath));
      deleteVaultPaths(collectVaultPathsForSource(db, filePath, vaultSourcesDir, oldSafe));
    }

    // Clean up chunks from old hash of same file
    db.prepare("DELETE FROM chunk_entities WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE path = ?))").run(filePath);
    db.prepare("DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE path = ?)").run(filePath);
    db.prepare("DELETE FROM sources WHERE path = ?").run(filePath);

    const sourceId = generateId(`source:${filePath}:${contentHash}`);

    // Insert source
    const insertSource = db.prepare(`
      INSERT INTO sources (id, kind, path, agent, title, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSource.run(sourceId, sourceKind, filePath, agent, sourceTitle || basename(filePath), contentHash, now(), now());

    // Chunk the content — limit to MAX_CHUNKS_PER_SOURCE to prevent imbalance
    const MAX_CHUNKS_PER_SOURCE = 5;
    let chunks = splitIntoChunks(
      markdownContent,
      sourceId,
      sourceTitle || basename(filePath),
      agent,
      scope,
      cfg.chunkTargetTokens,
      cfg.chunkMaxTokens,
    );
    if (chunks.length > MAX_CHUNKS_PER_SOURCE) {
      console.log(`[memory]  ∼ Limiting ${basename(filePath)} from ${chunks.length} to ${MAX_CHUNKS_PER_SOURCE} chunks (balance)`);
      chunks = chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
    }

    const vaultChunksDir = join(cfg.OPENCLAW_MEMORY_VAULT, "chunks");
    mkdirSync(vaultChunksDir, { recursive: true });

    const insertChunk = db.prepare(`
      INSERT INTO chunks (id, source_id, agent, scope, title, content, markdown_path, token_estimate, content_hash, status, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1.0, ?, ?)
    `);

    const localTitle = sourceTitle || basename(filePath);
    const safeName = toSafeFilename(localTitle);

    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];
      const chunkHash = sha256(chunkContent);
      const chunkId = generateId(`chunk:${sourceId}:${i}:${chunkHash}`);

      // Write markdown file with human-readable name
      const chunkDir = join(vaultChunksDir, chunkId.substring(0, 2));
      mkdirSync(chunkDir, { recursive: true });
      const chunkFileName = `${safeName}--part-${i + 1}.md`;
      const mdPath = join(chunkDir, chunkFileName);

      // Obsidian wikilink to the source file
      const sourceFileName = `${safeName}.md`;
      const sourceWikilink = `[[../sources/${sourceFileName}|${localTitle}]]`;

      const mdContent = [
        "---",
        `id: ${chunkId}`,
        `source_id: ${sourceId}`,
        `source_kind: ${sourceKind}`,
        `agent: ${agent || ""}`,
        `scope: ${scope || ""}`,
        `source_path: ${filePath}`,
        `content_hash: ${chunkHash}`,
        `status: active`,
        `created_at: ${now()}`,
        `updated_at: ${now()}`,
        "---",
        "",
        `# ${localTitle} — part ${i + 1}`,
        "",
        chunkContent,
        "",
        "---",
        "",
        `**Source**: ${sourceWikilink}`,
      ].join("\n");

      const chunkMdPath = cfg.vaultWriteChunks ? mdPath : null;
      if (cfg.vaultWriteChunks) {
        try {
          writeFileSync(mdPath, mdContent, "utf-8");
        } catch (err) {
          console.warn(`[memory]  ⚠  Cannot write ${mdPath}: ${err.message}`);
        }
      }

      insertChunk.run(
        chunkId, sourceId, agent, scope,
        `${localTitle} — part ${i + 1}`,
        chunkContent,
        chunkMdPath,
        tokenEstimate(chunkContent),
        chunkHash,
        now(), now(),
      );

      // Extract lightweight entities
      extractEntities(cfg, db, chunkId, chunkContent);
    }

    // Write source markdown with human-readable name
    const sourceFileName = `${safeName}.md`;
    const sourceMdPath = join(vaultSourcesDir, sourceFileName);
    try {
      // Build list of chunk wikilinks
      const chunkWikilinks = chunks.map((_, ci) => {
        const cId = generateId(`chunk:${sourceId}:${ci}:${sha256(chunks[ci])}`);
        const cDir = cId.substring(0, 2);
        return `- [[../chunks/${cDir}/${safeName}--part-${ci + 1}.md|Part ${ci + 1}]]`;
      }).join("\n");

      const sourceMd = [
        "---",
        `id: ${sourceId}`,
        `kind: ${sourceKind}`,
        `path: ${filePath}`,
        `agent: ${agent || ""}`,
        `title: ${sourceTitle || basename(filePath)}`,
        `content_hash: ${contentHash}`,
        `chunks: ${chunks.length}`,
        `created_at: ${now()}`,
        "---",
        "",
        `# ${sourceTitle || basename(filePath)}`,
        "",
        `- **Source**: \`${filePath}\``,
        `- **Kind**: ${sourceKind}`,
        `- **Agent**: ${agent || "none"}`,
        `- **Chunks**: ${chunks.length}`,
        "",
        "## Chunks",
        "",
        chunkWikilinks,
      ].join("\n");
      writeFileSync(sourceMdPath, sourceMd, "utf-8");
    } catch (err) {
      console.warn(`[memory]  ⚠  Cannot write source ${sourceMdPath}: ${err.message}`);
    }

    return chunks.length;
  } catch (err) {
    console.warn(`[memory]  ⚠  Error ingesting ${filePath}: ${err.message}`);
    return 0;
  }
}

function extractEntities(cfg, db, chunkId, content) {
  // Simple regex-based entity extraction
  // People mentions: @username or capitalized names in context
  const personRegex = /\B@(\w+)/g;
  // Hashtags / topics — exclude CSS hex colors (6-char hex after #)
  const topicRegex = /#((?![\da-fA-F]{6}\b)\w[\w-]+)/g;
  // Technical terms: CAPS_WORDS or CamelCaseTerms
  const techRegex = /\b([A-Z][a-z]+[A-Z]\w+)\b/g;

  const addEntity = db.prepare(`
    INSERT INTO entities (id, name, kind, normalized_name, mentions_count, last_seen_at)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      mentions_count = mentions_count + 1,
      last_seen_at = excluded.last_seen_at
  `);
  const linkEntity = db.prepare(`
    INSERT OR IGNORE INTO chunk_entities (chunk_id, entity_id)
    VALUES (?, ?)
  `);

  const seen = new Set();

  for (const match of content.matchAll(personRegex)) {
    const name = match[1].toLowerCase();
    const id = generateId(`entity:person:${name}`);
    if (seen.has(id)) continue;
    seen.add(id);
    addEntity.run(id, match[1], "person", name, now());
    linkEntity.run(chunkId, id);
  }

  for (const match of content.matchAll(topicRegex)) {
    const name = match[1];
    // Filter out garbage topics
    if (!isMeaningfulTopic(name)) continue;
    const normalized = name.toLowerCase();
    const id = generateId(`entity:topic:${normalized}`);
    if (seen.has(id)) continue;
    seen.add(id);
    addEntity.run(id, name, "topic", normalized, now());
    linkEntity.run(chunkId, id);
  }

  for (const match of content.matchAll(techRegex)) {
    const name = match[1].toLowerCase();
    const id = generateId(`entity:tech:${name}`);
    if (seen.has(id)) continue;
    seen.add(id);
    addEntity.run(id, match[1], "technology", name, now());
    linkEntity.run(chunkId, id);
  }
}

/** Reject noise topics: pure numbers, hex codes, timestamps, single chars, very short tokens */
function isMeaningfulTopic(name) {
  const normalized = name.toLowerCase();
  if (TOPIC_NOISE.has(normalized)) return false;
  // Too short (< 3 chars after #) — likely noise
  if (name.length < 3) return false;
  // Pure digits — PR numbers, CLI flags, issue IDs
  if (/^\d+$/.test(name)) return false;
  // Hex color codes (6 or 8 hex digits, possibly with lowercase)
  if (/^[a-fA-F0-9]{6,8}$/.test(name) && /[a-fA-F]/.test(name)) return false;
  // Timestamp fragments (e.g. "3q2026")
  if (/^[0-9]{1,2}[qQ]\d{4}/.test(name)) return false;
  // Single letters or very short noise
  if (/^[a-z0-9]{1,2}$/i.test(name)) return false;
  // Common noise from CLI/CI output
  if (/^[0-9]+[a-z]$/i.test(name) && name.length < 5) return false;
  return true;
}

function canonicalizeJsonl(content, filePath, agent) {
  // Strip binary/non-printable characters before parsing
  const cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\xBF\uFFFD]+/g, "").trim();
  const lines = cleaned.split("\n").filter((l) => l.trim());
  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        const role = entry.message.role || "unknown";
        let text = extractText(entry.message.content);
        if (role === "user") text = stripSessionEnrichment(text);
        if (text && !isLowValueSessionMessage(role, text)) {
          messages.push({ role, text, ts: entry.timestamp || entry.createdAt });
        }
      }
    } catch {
      // skip unparseable lines
    }
  }

  if (messages.length === 0) return "";

  let md = `# Session: ${basename(filePath)}\n\n`;
  md += `- **Agent**: ${agent || "unknown"}\n`;
  md += `- **Messages**: ${messages.length}\n`;
  md += `- **Source**: \`${filePath}\`\n\n`;
  md += `---\n\n`;

  for (const msg of messages) {
    const ts = msg.ts ? new Date(msg.ts).toISOString().substring(0, 19) : "";
    // Strip binary/non-printable chars from message text
    const cleanText = msg.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x80-\xBF\uFFFD]+/g, "").trim();
    if (!cleanText) continue;
    md += `### ${msg.role.toUpperCase()} ${ts ? `(${ts})` : ""}\n\n`;
    md += `${cleanText}\n\n`;
  }

  return md;
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === "text") return part.text || "";
        if (part.type === "thinking") return "";
        if (part.type === "toolCall" || part.type === "tool_use") return `[Tool: ${part.name || "call"}]`;
        if (part.type === "tool_result") {
          if (typeof part.content === "string") return `[Result: ${part.content.substring(0, 500)}]`;
          if (Array.isArray(part.content)) return extractText(part.content);
          return "[Result]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function purgeStaleSources(cfg, db) {
  const vaultSourcesDir = join(cfg.OPENCLAW_MEMORY_VAULT, "sources");
  const allSources = db.prepare("SELECT id, path, title FROM sources").all();
  let removed = 0;

  for (const src of allSources) {
    const base = basename(src.path);
    const ext = extname(src.path);
    let stale = false;

    if (ext === ".jsonl" && shouldSkipSessionFile(base)) stale = true;
    if (!cfg.workspaceScripts && [".py", ".js", ".sh"].includes(ext)) stale = true;
    if (ext === ".md") {
      const rel = relative(cfg.OPENCLAW_WORKSPACE, src.path);
      if (!rel.startsWith("..") && shouldSkipWorkspaceMd(base, rel)) stale = true;
    }

    if (!stale) continue;

    const oldSafe = toSafeFilename(src.title || base);
    deleteVaultPaths(collectVaultPathsForSource(db, src.path, vaultSourcesDir, oldSafe));
    db.prepare("DELETE FROM chunk_entities WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)").run(src.id);
    db.prepare("DELETE FROM chunks WHERE source_id = ?").run(src.id);
    db.prepare("DELETE FROM summaries WHERE scope = 'source' AND scope_key = ?").run(src.id);
    db.prepare("DELETE FROM sources WHERE id = ?").run(src.id);
    removed++;
  }

  if (removed > 0) {
    console.log(`[memory]  ✓ Purged ${removed} stale source(s) (checkpoints, scripts, README clones)\n`);
  }
  return removed;
}

export function ingestAllSources(cfg, db) {
  console.log("[memory]  Starting ingestion pipeline...\n");

  purgeStaleSources(cfg, db);

  const workspace = cfg.OPENCLAW_WORKSPACE;
  const vault = cfg.OPENCLAW_MEMORY_VAULT;

  // Sources to process: file paths with their metadata
  const sources = [];

  // 1. Agent session files (JSONL)
  const agentDirs = [
    join(cfg.OPENCLAW_HOME, "agents", "main", "sessions"),
    join(cfg.OPENCLAW_HOME, "agents", "crestodian", "sessions"),
  ];
  for (const dir of agentDirs) {
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (f.endsWith(".jsonl") && !shouldSkipSessionFile(f)) {
          sources.push({
            path: join(dir, f),
            kind: "session",
            title: `Session: ${f}`,
            agent: dir.includes("crestodian") ? "crestodian" : "main",
            scope: "session",
          });
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  // 2. Workspace markdown files
  function walkDir(dirPath, baseDir) {
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        const relPath = relative(baseDir, fullPath);

        // Skip ignored paths
        if (IGNORE_PATTERNS.some((p) => p.test(fullPath))) continue;

        // Skip vault system dirs — prevent loops, avoid re-ingesting mirrors
        const vaultRel = relative(vault, fullPath);
        if (vaultRel && !vaultRel.startsWith("..") && !vaultRel.startsWith("/")) {
          const firstComponent = vaultRel.split(/[/\\]/)[0];
          if (["chunks", "summaries", "sources"].includes(firstComponent)) continue;
          if (!entry.isDirectory() && vaultRel.startsWith("notes")) {
            // notes files are ingested separately, skip in workspace walk
            continue;
          }
        }

        if (entry.isDirectory()) {
          walkDir(fullPath, baseDir);
        } else if (entry.isFile()) {
          const isMd = entry.name.endsWith(".md");
          const isScript = cfg.workspaceScripts && (entry.name.endsWith(".py") || entry.name.endsWith(".js") || entry.name.endsWith(".sh"));
          if (!isMd && !isScript) continue;
          if (isMd && shouldSkipWorkspaceMd(entry.name, relPath)) continue;
          sources.push({
            path: fullPath,
            kind: "workspace",
            title: entry.name,
            agent: "main",
            scope: "workspace",
          });
        }
      }
    } catch {
      // Permission denied, skip
    }
  }
  walkDir(workspace, workspace);

  // 3. Manual notes from wiki/notes
  const notesDir = join(vault, "notes");
  try {
    const files = readdirSync(notesDir);
    for (const f of files) {
      if (f.endsWith(".md")) {
        sources.push({
          path: join(notesDir, f),
          kind: "note",
          title: `Note: ${f}`,
          agent: "main",
          scope: "note",
        });
      }
    }
  } catch {
    // Directory may not exist yet
  }

  // Deduplicate by path
  const seenPaths = new Set();
  const uniqueSources = sources.filter((s) => {
    if (seenPaths.has(s.path)) return false;
    seenPaths.add(s.path);
    return true;
  });

  console.log(`[memory]  Found ${uniqueSources.length} source(s) to process\n`);

  let totalChunks = 0;
  let processedFiles = 0;

  for (const src of uniqueSources) {
    const chunks = ingestFile(
      src.path,
      src.kind,
      src.title,
      src.agent,
      src.scope,
      cfg,
      db,
    );
    if (chunks > 0) {
      totalChunks += chunks;
      processedFiles++;
      console.log(`[memory]  ✓ ${basename(src.path)} → ${chunks} chunk(s)`);
    }
  }

  const pruned = pruneOrphanVaultFiles(cfg, db);
  if (pruned.removedChunks > 0 || pruned.removedSources > 0 || pruned.removedSummaries > 0) {
    console.log(`[memory]  ✓ Pruned ${pruned.removedChunks} orphan chunk(s), ${pruned.removedSources} source index file(s), ${pruned.removedSummaries || 0} summary file(s)`);
  }

  console.log(`\n[memory]  Done. ${processedFiles} file(s) ingested, ${totalChunks} total chunk(s).`);
  return { processedFiles, totalChunks, pruned };
}
