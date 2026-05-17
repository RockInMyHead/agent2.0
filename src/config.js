import { homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const HOME = homedir();

export const DEFAULTS = {
  OPENCLAW_HOME: process.env.OPENCLAW_HOME || join(HOME, ".openclaw"),
  OPENCLAW_WORKSPACE: process.env.OPENCLAW_WORKSPACE || join(HOME, ".openclaw", "workspace"),
  OPENCLAW_MEMORY_DB: process.env.OPENCLAW_MEMORY_DB || join(HOME, ".openclaw", "memory", "memory.db"),
  OPENCLAW_MEMORY_VAULT: process.env.OPENCLAW_MEMORY_VAULT || join(HOME, ".openclaw", "workspace", "wiki"),
};

export function resolveConfig() {
  const configPath = join(DEFAULTS.OPENCLAW_HOME, "memory", "config.json");
  const userConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};

  return {
    ...DEFAULTS,
    ...userConfig,
    denylist: userConfig.denylist || [
      ".env", ".pem", ".key", ".crt",
      "node_modules", ".git", "dist", "build", "logs",
      "memory.db",
    ],
    chunkMinTokens: userConfig.chunkMinTokens || 1200,
    chunkMaxTokens: userConfig.chunkMaxTokens || 3000,
    chunkTargetTokens: userConfig.chunkTargetTokens || 1800,
    recallMaxTokens: userConfig.recallMaxTokens || 5000,
  };
}

export function ensureDirectories(cfg) {
  const dirs = [
    join(cfg.OPENCLAW_HOME, "memory", "logs"),
    join(cfg.OPENCLAW_MEMORY_VAULT, "summaries", "global"),
    join(cfg.OPENCLAW_MEMORY_VAULT, "summaries", "sources"),
    join(cfg.OPENCLAW_MEMORY_VAULT, "summaries", "topics"),
    join(cfg.OPENCLAW_MEMORY_VAULT, "notes"),
    join(cfg.OPENCLAW_MEMORY_VAULT, "chunks"),
    join(cfg.OPENCLAW_MEMORY_VAULT, "sources"),
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }
}
