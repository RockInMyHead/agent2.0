import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createDb } from "./db.js";

const SYSTEM_PROMPT = `You are OpenClaw — a personal AI agent running on Mac Mini.
Primary model: MiniMax-M2.7. Delegate complex coding to @codex (GPT-5.5).
Use openclaw-memory for context. Respond in the user's language (Russian or English).
For 3D/CAD tasks: write valid OpenSCAD, fit parts on 200x200mm bed, export STL when asked.`;

const NOISE = [
  /^\[OpenClaw heartbeat poll\]$/i,
  /^HEARTBEAT_OK$/i,
  /^\[assistant turn failed/i,
  /^⚠️ Something went wrong while processing/i,
  /^NO_REPLY$/i,
  /^System:\s*\[/i,
];

const CAD_KEYWORDS = /\b(openscad|\.scad|\.stl|forgecad|onshape|3d.?print|bambu|slicer|servo|robot.?arm|stepper|mg996|28byj|uln2003)\b/i;
const AGENT_KEYWORDS = /\b(openclaw|@codex|codex|telegram|gateway|openclaw-memory|minimax|delegate|memory.?tree)\b/i;

function redactForTraining(text) {
  if (!text) return "";
  let s = text;

  // API keys, tokens, secrets
  s = s.replace(/\b(?:sk|pk|on|Bearer)[-_a-zA-Z0-9]{20,}\b/g, "[REDACTED_KEY]");
  s = s.replace(/\b(?:Client\s*(?:ID|Secret)|API\s*(?:Key|Secret))\s*[:=]\s*[`'"]?[^`'"\s]+[`'"]?/gi, "[REDACTED_CREDENTIAL]");
  s = s.replace(/\b[A-Z0-9]{20,}={2,}\b/g, "[REDACTED_SECRET]");
  s = s.replace(/(password\s*=\s*['"])[^'"]+(['"])/gi, "$1[REDACTED]$2");
  s = s.replace(/(https?:\/\/)[^:/\s]+:[^@\s]+@/g, "$1[REDACTED]:[REDACTED]@");
  s = s.replace(/\b(?:token|secret|api_key|apikey)\s*=\s*['"][A-Za-z0-9_\-=]{16,}['"]/gi, (m) => {
    const eq = m.indexOf("=");
    return `${m.slice(0, eq + 1).trim()} '[REDACTED]'`;
  });

  // Telegram user metadata blocks
  s = s.replace(/Reply target of current user message[\s\S]*?```json[\s\S]*?```/gi, "");
  s = s.replace(/```json\s*\{[\s\S]*?"sender_label"[\s\S]*?\}\s*```/gi, "");

  return s.trim();
}

function extractPublicText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && part.text) parts.push(part.text);
    if (part.type === "toolCall" && part.name && part.arguments) {
      const args = typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments);
      parts.push(`[Tool: ${part.name}] ${args.substring(0, 2000)}`);
    }
  }
  return parts.join("\n").trim();
}

function extractToolWrites(content) {
  if (!Array.isArray(content)) return [];
  const writes = [];
  for (const part of content) {
    if (part?.type !== "toolCall" || part.name !== "write") continue;
    const args = typeof part.arguments === "string" ? JSON.parse(part.arguments) : part.arguments;
    if (args?.path && args?.content) {
      writes.push({ path: args.path, content: args.content });
    }
  }
  return writes;
}

function isNoise(text) {
  if (!text || text.length < 5) return true;
  return NOISE.some((re) => re.test(text.trim()));
}

function cleanUserMessage(text) {
  let s = text;
  s = s.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*/gi, "");
  s = s.replace(/^\[[^\]]+\]\s*/, ""); // strip [Sat 2026-...] prefix
  s = s.replace(/^#\d+\s+\w+\s+\d{4}-\d{2}-\d{2}[^\n]*\n?/gm, "");
  return redactForTraining(s);
}

function writeJsonl(path, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, body, "utf-8");
}

function dedupeByHash(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function hashSimple(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

function parseSessions(sessionsDir) {
  const conversations = [];
  const instructionPairs = [];
  const cadExamples = [];
  const toolUseExamples = [];

  if (!existsSync(sessionsDir)) return { conversations, instructionPairs, cadExamples, toolUseExamples };

  const files = readdirSync(sessionsDir).filter(
    (f) => f.endsWith(".jsonl") && !f.endsWith(".trajectory.jsonl") && !f.includes("checkpoint") && !f.includes("reset"),
  );

  for (const file of files) {
    const path = join(sessionsDir, file);
    const messages = [];

    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;

      const role = entry.message.role;
      const text = extractPublicText(entry.message.content);
      const writes = extractToolWrites(entry.message.content);

      if (text) messages.push({ role, text, writes });
    }

    const cleaned = [];
    for (const m of messages) {
      const text = m.role === "user" ? cleanUserMessage(m.text) : redactForTraining(m.text);
      if (!isNoise(text)) cleaned.push({ ...m, text });
    }

    if (cleaned.length >= 2) {
      conversations.push({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...cleaned.map((m) => ({ role: m.role, content: m.text })),
        ],
        metadata: { source: file, type: "session" },
      });
    }

    for (let i = 0; i < cleaned.length - 1; i++) {
      const u = cleaned[i];
      const a = cleaned[i + 1];
      if (u.role !== "user" || a.role !== "assistant") continue;
      if (u.text.length < 10 || a.text.length < 30) continue;

      const pair = {
        instruction: u.text,
        output: a.text,
        metadata: { source: file, category: "general" },
      };

      if (CAD_KEYWORDS.test(u.text) || CAD_KEYWORDS.test(a.text)) {
        pair.metadata.category = "cad";
      } else if (AGENT_KEYWORDS.test(u.text) || AGENT_KEYWORDS.test(a.text)) {
        pair.metadata.category = "agent";
      }

      instructionPairs.push(pair);

      if (CAD_KEYWORDS.test(u.text) && a.writes?.length) {
        for (const w of a.writes) {
          if (!/\.scad$/i.test(w.path) && !/\.(js|py|sh)$/i.test(w.path)) continue;
          cadExamples.push({
            instruction: u.text,
            output: w.content,
            metadata: {
              source: file,
              path: w.path,
              format: w.path.endsWith(".scad") ? "openscad" : "code",
            },
          });
        }
      }
    }

    // Also capture tool writes from assistant turns (even without following text)
    for (let i = 0; i < cleaned.length; i++) {
      const m = cleaned[i];
      if (m.role !== "assistant" || !m.writes?.length) continue;
      const prevUser = cleaned.slice(0, i).reverse().find((x) => x.role === "user");
      if (!prevUser) continue;

      for (const w of m.writes) {
        toolUseExamples.push({
          instruction: prevUser.text,
          tool: "write",
          arguments: { path: w.path, content: w.content.substring(0, 8000) },
          metadata: { source: file },
        });
      }
    }
  }

  return { conversations, instructionPairs, cadExamples, toolUseExamples };
}

function extractFromVault(db, vaultPath) {
  const knowledgeQa = [];
  const cadChunks = [];

  const summaries = db
    .prepare(
      `SELECT scope, scope_key, title, content FROM summaries
       WHERE scope IN ('topic', 'source', 'global') AND length(content) > 100
       ORDER BY length(content) DESC LIMIT 200`,
    )
    .all();

  for (const s of summaries) {
    const content = redactForTraining(s.content);
    if (content.length < 80) continue;

    const topic = s.title || s.scope_key || "memory";
    knowledgeQa.push({
      instruction: `Что известно из памяти OpenClaw про «${topic}»?`,
      output: content.substring(0, 4000),
      metadata: { source: "obsidian_summary", scope: s.scope, topic },
    });

    if (CAD_KEYWORDS.test(content)) {
      knowledgeQa[knowledgeQa.length - 1].metadata.category = "cad";
    }
  }

  const chunks = db
    .prepare(
      `SELECT c.title, c.content, s.kind, s.title as source_title
       FROM chunks c JOIN sources s ON c.source_id = s.id
       WHERE c.status = 'active' AND (
         c.content LIKE '%module %' OR c.content LIKE '%OpenSCAD%' OR c.content LIKE '%.stl%'
         OR c.content LIKE '%forgecad%' OR c.content LIKE '%robot_arm%'
       )
       ORDER BY c.token_estimate DESC LIMIT 100`,
    )
    .all();

  for (const c of chunks) {
    const content = redactForTraining(c.content);
    const scadMatch = content.match(/```(?:scad|openscad)?\n([\s\S]*?)```/i)
      || content.match(/(module\s+\w+[\s\S]{200,})/);

    if (scadMatch) {
      cadChunks.push({
        instruction: `OpenSCAD контекст из: ${c.title}`,
        output: scadMatch[1].substring(0, 6000),
        metadata: { source: c.source_title, kind: c.kind, type: "chunk_extract" },
      });
    }
  }

  return { knowledgeQa, cadChunks };
}

function buildDelegationExamples() {
  return [
    {
      instruction: "MiniMax API timeout при сложной задаче по рефакторингу",
      output: "@codex проведи рефакторинг модуля openclaw-memory/src/ingest.js — разбей на функции, сохрани поведение, добавь JSDoc.",
      metadata: { category: "agent", synthetic: true },
    },
    {
      instruction: "Нужно сгенерировать OpenSCAD модель UV exposure box с 8 деталями",
      output: "@codex создай полный OpenSCAD проект UV Exposure Box: base, walls, LED plate, glass frame. Все детали на стол 200x200mm, комментарии на русском.",
      metadata: { category: "agent_cad", synthetic: true },
    },
    {
      instruction: "Пользователь спрашивает что делали вчера",
      output: "Сначала проверю память:\n```bash\nopenclaw-memory recall \"activity yesterday\"\n```\nЗатем отвечу на основе найденных summaries и chunks.",
      metadata: { category: "agent_memory", synthetic: true },
    },
    {
      instruction: "production_v3.stl выходит за границы стола Bambu Studio",
      output: "Модель выходит за build volume. Проверю:\n1. Размеры каждой детали в OpenSCAD (print_layout mode)\n2. Переразложу детали в пределах 200×200×250 mm\n3. Экспортирую отдельные STL или исправлю translate() координаты\n4. Если сложно — делегирую @codex для автоматической раскладки",
      metadata: { category: "cad_stl", synthetic: true },
    },
  ];
}

function loadScadFiles(extraDirs) {
  const examples = [];
  for (const dir of extraDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".scad")) continue;
      const content = readFileSync(join(dir, f), "utf-8");
      examples.push({
        instruction: `Существующий OpenSCAD файл ${f} — используй как референс для похожих задач`,
        output: content.substring(0, 12000),
        metadata: { source: join(dir, f), format: "openscad", type: "filesystem" },
      });
    }
  }
  return examples;
}

export function exportDataset(cfg, outDir) {
  mkdirSync(outDir, { recursive: true });

  const sessionsDir = join(cfg.OPENCLAW_HOME, "agents", "main", "sessions");
  const { db } = createDb(cfg.OPENCLAW_MEMORY_DB);

  const sessionData = parseSessions(sessionsDir);
  const vaultData = extractFromVault(db, cfg.OPENCLAW_MEMORY_VAULT);
  const delegation = buildDelegationExamples();
  const scadFiles = loadScadFiles([
    "/Users/artem/robot_arm",
    join(cfg.OPENCLAW_WORKSPACE, "cad"),
  ]);

  db.close();

  const instructionPairs = dedupeByHash(
    [...sessionData.instructionPairs],
    (r) => hashSimple(r.instruction + r.output.substring(0, 200)),
  );

  const cadAll = dedupeByHash(
    [...sessionData.cadExamples, ...vaultData.cadChunks, ...scadFiles],
    (r) => hashSimple(r.output.substring(0, 300)),
  );

  const agentPairs = instructionPairs.filter((p) => p.metadata.category === "agent");
  const cadPairs = instructionPairs.filter((p) => p.metadata.category === "cad");

  const conversations = sessionData.conversations.filter(
    (c) => c.messages.length >= 4 && !c.messages.every((m) => m.content.length < 20),
  );

  // OpenAI chat fine-tuning format
  const chatRows = conversations.slice(0, 500).map((c) => ({
    messages: c.messages.slice(0, 20),
  }));

  // Alpaca / instruction format
  const alpacaRows = instructionPairs.map((p) => ({
    instruction: p.instruction,
    input: "",
    output: p.output,
    category: p.metadata.category,
  }));

  writeJsonl(join(outDir, "train_conversations.jsonl"), chatRows);
  writeJsonl(join(outDir, "train_instructions.jsonl"), alpacaRows);
  writeJsonl(join(outDir, "train_agent.jsonl"), [...agentPairs, ...delegation]);
  writeJsonl(join(outDir, "train_cad_stl.jsonl"), [...cadPairs, ...cadAll]);
  writeJsonl(join(outDir, "train_knowledge_qa.jsonl"), vaultData.knowledgeQa.slice(0, 150));
  writeJsonl(join(outDir, "train_tool_use.jsonl"), sessionData.toolUseExamples.slice(0, 200));

  const stats = {
    exported_at: new Date().toISOString(),
    output_dir: outDir,
    counts: {
      conversations: chatRows.length,
      instructions: alpacaRows.length,
      agent: agentPairs.length + delegation.length,
      cad_stl: cadPairs.length + cadAll.length,
      knowledge_qa: Math.min(vaultData.knowledgeQa.length, 150),
      tool_use: Math.min(sessionData.toolUseExamples.length, 200),
    },
    categories: {
      general: instructionPairs.filter((p) => p.metadata.category === "general").length,
      agent: agentPairs.length,
      cad: cadPairs.length,
    },
    sources: {
      sessions_dir: sessionsDir,
      vault: cfg.OPENCLAW_MEMORY_VAULT,
      scad_files: scadFiles.length,
    },
  };

  writeFileSync(join(outDir, "dataset_stats.json"), JSON.stringify(stats, null, 2), "utf-8");

  writeFileSync(
    join(outDir, "README.md"),
    `# OpenClaw Agent SFT Dataset

Generated from Obsidian Memory Tree + agent sessions.

## Files

| File | Format | Purpose |
|------|--------|---------|
| \`train_conversations.jsonl\` | OpenAI messages | Multi-turn chat fine-tuning |
| \`train_instructions.jsonl\` | Alpaca (instruction/input/output) | General SFT |
| \`train_agent.jsonl\` | instruction/output | OpenClaw delegation, memory, gateway |
| \`train_cad_stl.jsonl\` | instruction/output | OpenSCAD, STL, 3D printing, robot arm |
| \`train_knowledge_qa.jsonl\` | instruction/output | Memory recall from Obsidian summaries |
| \`train_tool_use.jsonl\` | instruction/tool/arguments | Tool-calling examples (write/exec) |

## Stats

\`\`\`json
${JSON.stringify(stats.counts, null, 2)}
\`\`\`

## Usage

\`\`\`bash
# OpenAI fine-tuning
openai api fine_tuning.jobs.create -t train_conversations.jsonl -m gpt-4o-mini-2024-07-18

# Unsloth / LLaMA-Factory Alpaca
llamafactory-cli train --dataset train_instructions.jsonl
\`\`\`

Sensitive data redacted: API keys, OAuth secrets, passwords.
`,
    "utf-8",
  );

  return stats;
}
