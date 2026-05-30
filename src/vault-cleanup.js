import { existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function toSafeFilename(name) {
  let clean = name.replace(/\.[^.]+$/, "");
  clean = clean
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 100);
  return `${clean || "untitled"}.md`;
}

export function deleteVaultPaths(paths) {
  let removed = 0;
  for (const p of paths) {
    if (!p || !existsSync(p)) continue;
    try {
      unlinkSync(p);
      removed++;
    } catch {
      // ignore
    }
  }
  return removed;
}

/** Remove chunk/source markdown files on disk that are no longer referenced in SQLite. */
export function pruneOrphanVaultFiles(cfg, db) {
  const vault = cfg.OPENCLAW_MEMORY_VAULT;
  const active = new Set(
    db
      .prepare("SELECT markdown_path FROM chunks WHERE status = 'active' AND markdown_path IS NOT NULL")
      .all()
      .map((r) => r.markdown_path),
  );

  db
    .prepare("SELECT markdown_path FROM summaries WHERE markdown_path IS NOT NULL")
    .all()
    .forEach((r) => active.add(r.markdown_path));

  const activeSources = new Set(
    db
      .prepare(
        `SELECT DISTINCT lower(replace(replace(title, 'Session: ', ''), '.jsonl', '')) as t FROM sources`,
      )
      .all()
      .map((r) => r.t),
  );

  let removedChunks = 0;
  let removedSources = 0;

  const chunksDir = join(vault, "chunks");
  if (existsSync(chunksDir)) {
    for (const sub of readdirSync(chunksDir)) {
      const subDir = join(chunksDir, sub);
      if (!statSync(subDir).isDirectory()) continue;
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith(".md")) continue;
        const full = join(subDir, f);
        if (!active.has(full)) {
          try {
            unlinkSync(full);
            removedChunks++;
          } catch {
            // ignore
          }
        }
      }
    }
  }

  const sourcesDir = join(vault, "sources");
  const activeSourceFiles = new Set(
    db.prepare("SELECT title FROM sources").all().map((r) => toSafeFilename(r.title || "untitled")),
  );

  if (existsSync(sourcesDir)) {
    for (const f of readdirSync(sourcesDir)) {
      if (!f.endsWith(".md")) continue;
      if (activeSourceFiles.has(f)) continue;
      try {
        unlinkSync(join(sourcesDir, f));
        removedSources++;
      } catch {
        // ignore
      }
    }
  }

  let removedSummaries = 0;
  for (const sub of ["sources", "topics", "global"]) {
    const dir = join(vault, "summaries", sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      if (active.has(full)) continue;
      const inDb = db.prepare("SELECT 1 FROM summaries WHERE markdown_path = ?").get(full);
      if (!inDb) {
        try {
          unlinkSync(full);
          removedSummaries++;
        } catch {
          // ignore
        }
      }
    }
  }

  return { removedChunks, removedSources, removedSummaries, activeSources: activeSources.size };
}

export function collectVaultPathsForSource(db, filePath, vaultSourcesDir, safeName) {
  const paths = [];
  const rows = db
    .prepare(
      `SELECT c.markdown_path FROM chunks c
       JOIN sources s ON c.source_id = s.id
       WHERE s.path = ?`,
    )
    .all(filePath);
  for (const r of rows) {
    if (r.markdown_path) paths.push(r.markdown_path);
  }
  paths.push(join(vaultSourcesDir, `${safeName}.md`));
  const summaryPath = db
    .prepare("SELECT markdown_path FROM summaries WHERE scope = 'source' AND scope_key IN (SELECT id FROM sources WHERE path = ?)")
    .get(filePath);
  if (summaryPath?.markdown_path) paths.push(summaryPath.markdown_path);
  return paths;
}
