# MOA (Mixture Of Agents)

**A professional coding agent with a first-class conversational mode.**

Built on [opencode](https://opencode.ai) as a dependency (not a fork), MOA adds dual-mode personalities, persistent memory, and intelligent codebase understanding through opencode's plugin system.

---

## What is MOA?

MOA gives you two agents in one:

- **`dev` mode** — Professional coding assistant with broad permissions for actual development work
- **`chat` mode** — Conversational helper, read-only by default, safe for exploration and questions

Switch between them anytime with `Tab`.

---

## Key Features

### 🧠 Two-Level Memory
- **Working memory**: Your current conversation (session context)
- **Long-term memory**: Persisted facts, preferences, and project knowledge in local SQLite
- The agent remembers what you tell it across sessions and auto-injects relevant context

### 🔍 Codebase Understanding
- **Semantic search** over your project files (hybrid BM25 + optional embeddings)
- Automatic indexing that respects `.gitignore`
- Incremental updates as you edit files
- Find functions, patterns, or concepts with natural queries

### 🎯 Smart Context
- **Token budget tracking** — know your daily usage
- **MCP integration** — `context7` for up-to-date library docs, `gh_grep` for real-world code examples
- **Agent Skills** — reusable instruction templates (like `git-release` for generating changelogs)

### 🔒 Safe by Default
- Hardened permissions: `rm -rf` and `sudo` blocked
- Destructive operations require confirmation
- Model-agnostic: use any LLM you want (OpenAI, Anthropic, local models via Ollama)

### 🌐 Optional: Telegram Gateway
- Talk to MOA from anywhere via Telegram
- Runs as a local daemon or Docker container for 24/7 availability
- Secure pairing system with admin controls

---

## Requirements

- Node.js 20+
- opencode installed: `npm i -g opencode-ai`
- An LLM provider configured in opencode (`opencode auth login` or set an API key)

## Install

The installer syncs MOA's agents and plugins into your global opencode config so they're available in any directory.

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\install.ps1

# macOS / Linux
./scripts/install.sh
```

Non-intrusive: only adds missing settings, never overwrites your provider/model config. Re-run after any change to sync.

> Restart the opencode desktop app after installing to pick up changes.

## Usage

```sh
opencode              # starts in dev mode (default)
opencode --agent chat # start in chat mode
# press Tab to switch modes mid-session
```

Optional: set your preferred model via env (see `.env.example`).

---

## Tools reference

**Memory**
- `memory_remember { text, type, importance? }` — store a fact (`preference` | `goal` | `project` | `decision` | `note`)
- `memory_search { query }` — retrieve relevant stored facts

**Codebase**
- `codebase_index { rebuild? }` — index the current project (run once, then auto-updates)
- `codebase_search { query }` — search indexed code by keyword or concept

**MCP (external)**
- `context7` — up-to-date library/framework docs
- `gh_grep` — real code examples from GitHub

**Skills** (loaded on demand, no context cost until used)
- `git-release` — draft release notes, propose a semver bump, produce a release command

Add more MCP servers under `mcp` in `opencode.json`. Add more skills by creating `.opencode/skills/<name>/SKILL.md`.

---

## Layout

```
.opencode/
├── agents/
│   ├── dev.md          # dev soul + permissions
│   └── chat.md         # chat soul + permissions
├── plugins/
│   ├── memory.ts       # long-term memory (SQLite)
│   ├── codebase.ts     # codebase RAG (SQLite)
│   └── budget.ts       # token usage tracking
└── skills/
    └── git-release/SKILL.md
scripts/
├── install.ps1         # Windows installer
└── install.sh          # macOS/Linux installer
```

Runtime data (`~/.moa/`) lives outside the repo — memory, budget, codebase indexes.
