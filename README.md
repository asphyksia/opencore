# Opencore

**A professional coding agent with a first-class conversational mode.**

Built on [opencode](https://opencode.ai) as a dependency (not a fork), opencore adds dual-mode personalities, persistent memory, and intelligent codebase understanding through opencode's plugin system.

---

## What is opencore?

Opencore gives you two agents in one:

- **`dev` mode** — Professional coding assistant with broad permissions for actual development work
- **`chat` mode** — Conversational helper, read-only by default, safe for exploration and questions

Switch between them anytime with `Tab`.

---

## Key Features

### 🧠 Two-Level Memory
- **Working memory**: Your current conversation (session context)
- **Long-term memory**: Persisted facts, preferences, and project knowledge in local SQLite
- **Automatic extraction**: every 5 turns, durable facts are extracted and stored in the background
- **Conflict resolution**: new facts are reconciled with similar existing ones (ADD / UPDATE / DELETE / SKIP), so memory stays coherent
- **Daily Markdown exports**: facts are also written to `~/.opencore/memory/exports/YYYY-MM-DD.md` for human reading and `grep` (DB remains source of truth)
- The agent remembers what you tell it across sessions and auto-injects relevant context

### 🔍 Codebase Understanding
- **Hybrid search** over your project files (BM25 + optional semantic embeddings)
- Automatic indexing that respects `.gitignore`
- Incremental updates as you edit files
- Find functions, patterns, or concepts with natural queries

### 🔁 Cross-Session Recall
- All past conversations are indexed in SQLite + FTS5
- Search past sessions by keyword (`session_search { query }`) to find "how did we solve X last time"
- Browse recent sessions or scroll a window around a specific message
- Lazy-indexed: no setup, works the first time you ask

### 🎯 Smart Context
- **Token budget tracking** — know your daily usage
- **MCP integration** — `context7` for up-to-date library docs, `gh_grep` for real-world code examples
- **Agent Skills** — reusable instruction templates (like `git-release` for generating changelogs)

### 🔒 Safe by Default
- Hardened permissions: `rm -rf` and `sudo` blocked
- Destructive operations require confirmation
- Model-agnostic: use any LLM you want (OpenAI, Anthropic, local models via Ollama)

### 🌐 Optional: Telegram Gateway
- Talk to opencore from anywhere via Telegram
- Runs as a local daemon or Docker container for 24/7 availability
- Secure pairing system with admin controls

---

## Requirements

- Node.js 20+
- opencode installed: `npm i -g opencode-ai`
- An LLM provider configured in opencode (`opencode auth login` or set an API key)

## Install

The installer syncs opencore's agents and plugins into your global opencode config so they're available in any directory.

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
- `memory_export { backfill? }` — list or regenerate daily Markdown exports at `~/.opencore/memory/exports/`

**Codebase**
- `codebase_index { rebuild? }` — index the current project (run once, then auto-updates)
- `codebase_search { query }` — search indexed code by keyword or concept

**Sessions**
- `session_search { query? }` — full-text search past sessions
- `session_search { session_id, around_message_id }` — scroll a window around a message
- `session_search` (no args) — list recent sessions

**MCP (external)**
- `context7` — up-to-date library/framework docs
- `gh_grep` — real code examples from GitHub

**Skills** (loaded on demand, no context cost until used)
- `git-release` — draft release notes, propose a semver bump, produce a release command

Add more MCP servers under `mcp` in `opencode.json`. Add more skills by creating `.opencode/skills/<name>/SKILL.md`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to create custom plugins, agents, or skills.

### Where data lives

```
~/.opencore/
├── memory/
│   ├── memory.db          # long-term memory store (FTS5 + embeddings)
│   └── exports/           # human-readable daily Markdown exports
│       └── YYYY-MM-DD.md
├── codebase/
│   └── <hash>.db          # per-project code index
├── sessions/
│   └── sessions.db        # cross-session FTS5 index
└── budget/
    └── YYYY-MM-DD.json    # daily token usage
```

Inspect daily memory with `cat ~/.opencore/memory/exports/2026-06-29.md`, or search with `grep`. The DB is the source of truth; the `.md` is regenerated on every change.

---

## Layout

```
.opencode/
├── agents/
│   ├── dev.md              # dev soul (professional coding)
│   └── chat.md             # chat soul (conversational, read-only)
├── plugins/
│   ├── memory.ts           # two-level memory + auto-extract + conflict resolution
│   ├── codebase.ts         # per-project codebase RAG
│   ├── session-search.ts   # cross-session conversation recall
│   ├── budget.ts           # daily token usage tracking
│   └── lib/                # SQLite + FTS5 storage layer (per plugin)
└── skills/
    └── git-release/SKILL.md
scripts/
├── install.ps1             # Windows installer
└── install.sh              # macOS/Linux installer
```

---

## Compatibility

opencore is built on **opencode `1.17.11`** with exact version pinning for stability.

### Upgrading opencode

Version upgrades are **manual and deliberate**. Before upgrading:

1. Check the [opencode changelog](https://github.com/opencode-ai/opencode/releases) for breaking changes in the plugin API
2. Test with `opencode --version` after upgrade
3. Verify memory injection still works (it uses `experimental.session.compacting`)

**Known experimental dependencies:**
- `experimental.session.compacting` — memory injection hook (may change or be removed in future opencode versions)

If a breaking change occurs, opencore's version pins ensure existing installs continue working. Upgrades will be tested and documented in releases.
