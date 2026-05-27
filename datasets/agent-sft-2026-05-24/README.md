# OpenClaw Agent SFT Dataset

Generated from Obsidian Memory Tree + agent sessions.

## Files

| File | Format | Purpose |
|------|--------|---------|
| `train_conversations.jsonl` | OpenAI messages | Multi-turn chat fine-tuning |
| `train_instructions.jsonl` | Alpaca (instruction/input/output) | General SFT |
| `train_agent.jsonl` | instruction/output | OpenClaw delegation, memory, gateway |
| `train_cad_stl.jsonl` | instruction/output | OpenSCAD, STL, 3D printing, robot arm |
| `train_knowledge_qa.jsonl` | instruction/output | Memory recall from Obsidian summaries |
| `train_tool_use.jsonl` | instruction/tool/arguments | Tool-calling examples (write/exec) |

## Stats

```json
{
  "conversations": 100,
  "instructions": 246,
  "agent": 97,
  "cad_stl": 80,
  "knowledge_qa": 150,
  "tool_use": 111
}
```

## Usage

```bash
# OpenAI fine-tuning
openai api fine_tuning.jobs.create -t train_conversations.jsonl -m gpt-4o-mini-2024-07-18

# Unsloth / LLaMA-Factory Alpaca
llamafactory-cli train --dataset train_instructions.jsonl
```

Sensitive data redacted: API keys, OAuth secrets, passwords.
