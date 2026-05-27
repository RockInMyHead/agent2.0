# Agent 2.0 — OpenClaw + Memory Tree

Персональный AI-агент на Mac: **OpenClaw Gateway**, **MiniMax-M2.7** (основная модель), **Codex / GPT-5.5** (sub-agent для сложных задач), **Telegram-бот**, иерархическая память **SQLite + Obsidian**.

```
Telegram  →  OpenClaw Gateway  →  MiniMax-M2.7 (main)
                    │                    │
                    │                    └─ @codex → GPT-5.5 (sub-agent)
                    │
                    └─ openclaw-memory (SQLite + Obsidian vault)
```

## Требования

| Компонент | Версия |
|-----------|--------|
| macOS | 13+ |
| Node.js | 20+ (рекомендуется через Homebrew) |
| OpenClaw | `2026.5.6+` |
| Obsidian | опционально, для просмотра vault |

API-ключи (минимум один провайдер):
- **MiniMax** — основная модель
- **OpenAI Codex** (OAuth) — sub-agent `@codex`

---

## 1. Установка OpenClaw

```bash
npm install -g openclaw@latest

# Первичная настройка (создаёт ~/.openclaw/)
openclaw onboard
```

Проверка:

```bash
openclaw --version
openclaw doctor
```

---

## 2. Установка Memory Tree

```bash
git clone https://github.com/RockInMyHead/agent2.0.git
cd agent2.0          # или openclaw-memory — имя папки после clone

npm install
npm link             # добавляет команду openclaw-memory в PATH
```

Инициализация памяти:

```bash
openclaw-memory init
openclaw-memory ingest
openclaw-memory status
```

---

## 3. Конфигурация OpenClaw

Основной конфиг: `~/.openclaw/openclaw.json`

### 3.1 Модели и агенты

```json
{
  "agents": {
    "defaults": {
      "workspace": "/Users/YOU/.openclaw/workspace",
      "model": {
        "primary": "minimax/MiniMax-M2.7",
        "fallbacks": ["openai-codex/gpt-5.5"]
      },
      "models": {
        "minimax/MiniMax-M2.7": {},
        "openai-codex/gpt-5.5": {
          "agentRuntime": { "id": "codex" }
        }
      }
    },
    "list": [
      { "id": "main", "default": true, "model": "minimax/MiniMax-M2.7" },
      {
        "id": "codex",
        "name": "Codex",
        "model": "openai-codex/gpt-5.5",
        "models": {
          "openai-codex/gpt-5.5": { "agentRuntime": { "id": "codex" } }
        }
      }
    ]
  }
}
```

### 3.2 API-ключи

Файл: `~/.openclaw/agents/main/agent/auth-profiles.json`

```json
{
  "minimax": { "apiKey": "YOUR_MINIMAX_API_KEY" },
  "openai-codex": { "type": "oauth", "profile": "default" }
}
```

OAuth для Codex:

```bash
openclaw auth login openai-codex
```

### 3.3 Telegram-бот

1. Создай бота через [@BotFather](https://t.me/BotFather) → получи токен.
2. Добавь в `openclaw.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
      "dmPolicy": "pairing"
    }
  },
  "plugins": {
    "allow": ["codex", "telegram", "minimax", "memory-core"],
    "entries": {
      "telegram": { "enabled": true },
      "minimax": { "enabled": true },
      "codex": { "enabled": true }
    }
  }
}
```

3. Запусти gateway и напиши боту — при `dmPolicy: "pairing"` нужно подтвердить pairing-код:

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### 3.4 Инструкции агента

Создай `~/.openclaw/agents/main/system.md`:

```markdown
# Agent Instructions

## Delegation to Codex
Primary: MiniMax-M2.7. For complex coding, timeouts, or errors — delegate via @codex.

Example: `@codex проверь ошибки в этом проекте`

## Memory
At session start run: openclaw-memory recall "today's activity"
```

---

## 4. Запуск Gateway

```bash
# Запуск (порт по умолчанию 18789)
openclaw gateway --port 18789

# Или в фоне
nohup openclaw gateway --port 18789 >> ~/.openclaw/logs/gateway.log 2>&1 &
```

Проверка:

```bash
curl -s http://127.0.0.1:18789/health
openclaw logs --follow
```

### Автозапуск через launchd (macOS)

```bash
# Пример plist — адаптируй пути под себя
cp com.openclaw.memory-ingest.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.memory-ingest.plist
```

Для gateway создай аналогичный plist с `openclaw gateway --port 18789`.

---

## 5. Memory Tree — ежедневное использование

| Команда | Описание |
|---------|----------|
| `openclaw-memory ingest` | Загрузить сессии, workspace, notes → SQLite + Obsidian |
| `openclaw-memory search "query"` | Полнотекстовый поиск по памяти |
| `openclaw-memory recall "query"` | Контекст для агента (Markdown) |
| `openclaw-memory status` | Статистика: sources, chunks, tokens |
| `openclaw-memory open-vault` | Открыть Obsidian vault |
| `openclaw-memory sync-vault` | Синхронизировать ручные notes → SQLite |
| `openclaw-memory export-sft [dir]` | Экспорт SFT-датасета для fine-tuning |

### Структура vault

```
~/.openclaw/workspace/wiki/
├── chunks/      # фрагменты с wikilinks
├── sources/     # исходники (сессии, файлы)
├── summaries/   # global / topic / source summaries
└── notes/       # ручные заметки
```

### Авто-ingest каждый час

```bash
# Отредактируй пути в com.openclaw.memory-ingest.plist, затем:
cp com.openclaw.memory-ingest.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.memory-ingest.plist

# Проверка
launchctl list | grep openclaw
tail -f ~/.openclaw/memory/logs/ingest-stdout.log
```

### Переменные окружения

```bash
export OPENCLAW_HOME=~/.openclaw
export OPENCLAW_WORKSPACE=~/.openclaw/workspace
export OPENCLAW_MEMORY_DB=~/.openclaw/memory/memory.db
export OPENCLAW_MEMORY_VAULT=~/.openclaw/workspace/wiki
```

---

## 6. Работа с агентом в Telegram

| Команда | Действие |
|---------|----------|
| `/new` | Новая сессия (сброс контекста) |
| `@codex ...` | Делегировать задачу sub-agent GPT-5.5 |
| Обычный текст | MiniMax-M2.7 обрабатывает сам |

**Типичный flow:**
1. Gateway запущен, бот отвечает на `/start`
2. Агент при старте сессии читает память через `openclaw-memory recall`
3. Простые задачи — MiniMax
4. Сложный код / OpenSCAD / рефакторинг — `@codex создай robot_arm.scad ...`

---

## 7. Экспорт SFT-датасета

```bash
openclaw-memory export-sft
# → ~/.openclaw/datasets/agent-sft-YYYY-MM-DD/
```

Файлы:
- `train_conversations.jsonl` — multi-turn chat
- `train_instructions.jsonl` — instruction → output
- `train_agent.jsonl` — делегирование, memory, gateway
- `train_cad_stl.jsonl` — OpenSCAD / STL / robot arm
- `train_knowledge_qa.jsonl` — Q&A из summaries
- `train_tool_use.jsonl` — tool-calling examples

---

## 8. Troubleshooting

### ⚠️ Something went wrong while processing your request

Generic fallback — агент упал до ответа. Смотри лог:

```bash
grep "Embedded agent failed" ~/.openclaw/logs/gateway.log | tail -5
openclaw logs --follow
```

| Причина | Решение |
|---------|---------|
| MiniMax timeout / ECONNRESET | Проверь сеть; используй `@codex` |
| DNS сломан | `sudo networksetup -setdnsservers Wi-Fi 8.8.8.8 1.1.1.1` |
| Session takeover | `/new` — новая сессия |
| Длинный диалог | `/new` или увеличь compaction buffer |

Включить детальные ошибки в чате:

```json
"agents": { "defaults": { "verbose": "on" } }
```

### Gateway не отвечает

```bash
lsof -i :18789
openclaw gateway --port 18789
```

### Memory пустая

```bash
openclaw-memory init
openclaw-memory ingest
openclaw-memory status
```

### Codex недоступен

```bash
openclaw auth login openai-codex
openclaw doctor
```

---

## 9. Архитектура репозитория

```
agent2.0/
├── src/
│   ├── cli.js           # CLI: init, ingest, search, recall, export-sft
│   ├── ingest.js        # Pipeline: sessions → chunks → Obsidian
│   ├── summarize.js     # Topic/global summaries
│   ├── export-dataset.js # SFT export
│   ├── db.js            # SQLite schema + FTS5
│   └── config.js        # Paths and defaults
├── datasets/            # Exported SFT datasets (generated)
├── com.openclaw.memory-ingest.plist
└── README.md
```

---

## 10. Быстрый старт (cheatsheet)

```bash
# 1. OpenClaw
npm i -g openclaw && openclaw onboard

# 2. Memory Tree
git clone https://github.com/RockInMyHead/agent2.0.git && cd agent2.0
npm i && npm link && openclaw-memory init && openclaw-memory ingest

# 3. Auth
openclaw auth login openai-codex
# + добавь MiniMax key в auth-profiles.json

# 4. Telegram token в openclaw.json → pairing approve

# 5. Запуск
openclaw gateway --port 18789

# 6. Пиши боту в Telegram 🎉
```

---

## Лицензия

MIT — используй свободно, ключи и сессии храни локально, не коммить в git.
