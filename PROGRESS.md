# MOA — Progress & Context

Working notes so any future session (or a restarted app) can resume with full
context. This is a living document; update it as the project evolves.

## What MOA is

A professional coding agent with a first-class conversational mode, built on
**opencode** (consumed as a dependency, not forked). The repo is the source of
truth; an install script syncs agents + plugins into the global opencode config
so MOA works in any directory. See `arquitectura-agente.md` (in Downloads) for
the full architecture and the reasoning behind building on opencode.

GitHub: https://github.com/asphyksia/MOA

## Current state (V1, working & verified)

- **Agents (modes)** — switch with `Tab`:
  - `dev` — coding soul, broad permissions, knows to use memory + RAG
  - `chat` — conversational soul, read-only-ish, knows to use memory + RAG
  - `plan` — opencode's built-in read-only analysis agent
  - `build` — **disabled** (dev is its MOA-tuned replacement)
  - default_agent = `dev`
- **Two-level memory plugin** (`.opencode/plugins/memory.ts` + `lib/memory-store.ts`)
  - working memory = opencode session context
  - long-term = SQLite + FTS5 at `~/.moa/memory/memory.db`, BM25 ranking
  - tools: `memory_remember`, `memory_search`
  - injects top facts on `experimental.session.compacting`
  - auto-migrated the old V1 JSONL store
- **Codebase RAG plugin** (`.opencode/plugins/codebase.ts` + `lib/codebase-store.ts`, `lib/indexer.ts`)
  - per-project SQLite + FTS5 index at `~/.moa/codebase/<project-hash>.db`
  - tools: `codebase_index`, `codebase_search`
  - lazy auto-index on first search; `file.edited` incremental re-index
  - project-root guard + MAX_FILES cap (fixes a hang in non-project dirs)
- **Token budget plugin** (`.opencode/plugins/budget.ts`) — daily tracking + warn
- **Install** — `scripts/install.ps1` syncs agents/plugins to `~/.config/opencode`
  and merges MOA defaults into the global `opencode.json` WITHOUT touching the
  user's provider/model. PowerShell 5.1 compatible (no `-AsHashtable`).

## Runtime facts

- opencode CLI version 1.17.11; plugins run under **Bun** (so `bun:sqlite` + FTS5
  are available with no native build step).
- Provider: `cavoti/claude-opus-4-8`, configured in global `~/.config/opencode/opencode.json`.
- Local data lives in `~/.moa/` (memory, budget, codebase) — outside the repo.

## Key decisions / honest limits

- Search (memory + RAG) is keyword/BM25, **no embeddings** — no synonym/semantic
  match. Embeddings are the future upgrade if needed.
- Memory injection rides on opencode's `experimental.session.compacting` hook.
- Desktop app runs its own opencode **sidecar**; it reads the same global config
  but must be **restarted** to pick up agent/config changes.

## Where we are right now

- Just disabled `build`, confirmed `dev`/`chat`/`plan` show in CLI from any dir.
- Diagnosed why the desktop app still showed old modes: it had been open since
  before the changes; the sidecar reads the same global config and just needs a
  restart. About to restart the desktop app.

## Next candidates (not started)

- Confirm desktop app shows dev/chat after restart.
- Real-use testing of chat/dev (tone, memory recall, RAG).
- Possible: embeddings (semantic search), Telegram/daemon gateway.

## Commit log (recent)

- `fd961b9` Disable redundant `build`; installer 5.1-compatible
- `fc1beb2` Global install script; fix codebase_search hang outside projects
- `fe245e3` Wire memory + RAG into souls; lazy auto-index
- `b134a97` Add codebase RAG plugin
- `eefa674` Migrate memory to SQLite + FTS5
