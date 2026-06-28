# MOA

A professional coding agent with a first-class conversational mode, built on
[opencode](https://opencode.ai). MOA is **not a fork** of opencode — it consumes
opencode as a dependency and adds a conversational layer (souls / dual mode,
two-level memory, token budget) through opencode's documented extension points:
agents, plugins and the SDK.

See `arquitectura-agente.md` (in Downloads) for the full architecture and the
reasoning behind building on opencode instead of forking Mercury.

## Status: V1 skeleton (verified working)

What's wired up and tested:

- **Dual mode** via two custom primary agents (switch with `Tab`):
  - `dev` — professional coding soul, broad workspace permissions
  - `chat` — conversational soul, read-only by default (bash denied)
- **Two-level memory** plugin:
  - working memory = opencode's native session context
  - long-term memory = local SQLite + FTS5 store at `~/.moa/memory/memory.db`
    (full-text search via BM25, ranked and blended with fact importance)
  - tools `memory_remember` / `memory_search`
  - relevant facts injected back on context compaction
  - runs on Bun's built-in `bun:sqlite` (opencode's plugin runtime) — no native
    build step, no external dependency
  - facts from the old V1 JSONL store are migrated automatically on first run
- **Token budget** plugin: daily usage tracking + warn threshold, state at
  `~/.moa/budget/<date>.json`
- **Codebase RAG** plugin:
  - per-project SQLite + FTS5 index of the project's files at
    `~/.moa/codebase/<project-hash>.db`
  - tools `codebase_index` (build/rebuild, respects .gitignore) and
    `codebase_search` (keyword/BM25 search returning file path + line range)
  - incremental re-index on `file.edited`
  - keyword search, no embeddings (known limit: no synonym/semantic match)
- **MCP servers** (external tools via Model Context Protocol, native to opencode):
  - `context7` — up-to-date library/framework documentation search
  - `gh_grep` — real-world code examples from GitHub (Grep by Vercel)
  - both remote, no auth; tools auto-available to the agent (prefixed by server name)
- **Agent Skills** (`SKILL.md`, agentskills.io-compatible, native to opencode):
  - `git-release` — draft release notes, propose a semver bump, produce a
    ready-to-run release command
  - loaded on-demand via the `skill` tool (no context cost until used)
  - same format the future Hermes-style auto-creation (V3) will emit
- Hardened permissions: `rm -rf`, `sudo` hard-denied; most bash gated by `ask`.

## Layout

```
.
├── opencode.json            # base config: default agent, permissions, model env, MCP servers
├── .opencode/
│   ├── agents/
│   │   ├── dev.md           # DEV soul (coding)
│   │   └── chat.md          # CHAT soul (conversational)
│   ├── plugins/
│   │   ├── memory.ts        # two-level memory + tools + compaction hook
│   │   ├── codebase.ts      # codebase RAG: index + search tools
│   │   ├── lib/
│   │   │   ├── memory-store.ts   # SQLite + FTS5 storage layer (memory)
│   │   │   ├── codebase-store.ts # SQLite + FTS5 storage layer (per-project code)
│   │   │   └── indexer.ts        # file discovery + line-range chunking
│   │   └── budget.ts        # token budget tracking
│   ├── skills/
│   │   └── git-release/SKILL.md  # example skill (agentskills.io format)
│   └── package.json         # plugin dependency (@opencode-ai/plugin)
├── scripts/
│   ├── install.ps1          # sync into global opencode config (Windows)
│   └── install.sh           # sync into global opencode config (macOS/Linux)
├── package.json             # depends on opencode-ai
├── .env.example             # provider keys + model selection
└── arquitectura-agente.md   # architecture doc (kept in Downloads)
```

Local runtime data lives in `~/.moa/` (memory, budget) — outside the repo.

## Install (use MOA everywhere)

By default, opencode only loads a project's agents/plugins when launched from
that project's directory. To make MOA's `dev`/`chat` agents and plugins
available in **any** directory (so they show up when you press `Tab` in the
TUI), install them into your global opencode config:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

```sh
# macOS / Linux
./scripts/install.sh
```

The installer:
- copies `agents/` and `plugins/` into `~/.config/opencode/`
- ensures the `@opencode-ai/plugin` dependency is installed there (so plugins
  load from any directory)
- merges MOA's defaults (`default_agent`, hardened permissions) into the global
  `opencode.json` **only if absent** — it never overwrites your provider/model
  or existing settings, and warns when it skips something

It is **non-intrusive by default**: it does not touch opencode's built-in
`build` agent. If you want to hide `build` (since `dev` is its MOA-tuned
replacement), opt in:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DisableBuild   # Windows
```
```sh
./scripts/install.sh --disable-build                                          # macOS / Linux
```

Re-run the installer after changing any agent or plugin to sync. The repo stays
the source of truth; the global config is just an installation.

> If the desktop app is running, restart it to pick up changes — it reads the
> same global config but caches it at startup.

## Prerequisites

- Node.js 20+
- opencode installed (`npm i -g opencode-ai` or see opencode docs). Verified with
  opencode `1.17.11`.
- An LLM provider configured for opencode (run `opencode auth login`, or set a
  provider API key). MOA is model-agnostic — you choose the model.

## Usage

```sh
# default agent is `dev`
opencode

# start directly in a given mode
opencode --agent dev
opencode --agent chat

# switch modes inside a session with the Tab key

# list agents (confirms dev + chat load)
opencode agent list
```

Optional model selection via env (see `.env.example`):

```sh
# MOA_MODEL=anthropic/claude-sonnet-4-5
# MOA_SMALL_MODEL=anthropic/claude-haiku-4-5
```

If `MOA_MODEL` is unset, opencode uses its own model selector / global config.

## Memory tools

The agent can call these during a session:

- `memory_remember { text, type, importance? }` — store a durable fact
  (types: identity | preference | goal | project | decision | note)
- `memory_search { query, limit? }` — retrieve relevant stored facts

## Codebase tools

- `codebase_index { rebuild? }` — build/rebuild the project's full-text index
  (respects .gitignore). Run once per project or after large changes.
- `codebase_search { query, limit? }` — keyword/BM25 search over indexed code,
  returns matching chunks with file path and line range.

## MCP tools

External tools via Model Context Protocol, configured under `mcp` in
`opencode.json`. Tools are auto-available to the agent, prefixed by server name.

- `context7` — search up-to-date library docs. Add `use context7` to a prompt.
- `gh_grep` — search real code examples on GitHub. Add `use the gh_grep tool`.

Add more servers (local or remote) under `mcp` in the config; see
[opencode MCP docs](https://opencode.ai/docs/mcp-servers/). Note: each server
adds to context, so enable selectively.

## Skills

Reusable instructions in `SKILL.md` files (agentskills.io format), discovered
from `.opencode/skills/<name>/SKILL.md` and loaded on-demand via the `skill`
tool — no context cost until the agent actually loads one.

- `git-release` — release notes + semver bump + ready-to-run release command.

To add a skill: create `.opencode/skills/<name>/SKILL.md` with `name` and
`description` frontmatter, then re-run the installer to sync it globally. This
is the **same format** the planned V3 auto-creation (Hermes-inspired) will emit,
so hand-written and auto-generated skills are interchangeable — the V3 work is
the quality evaluator, not the format.

## Notes & roadmap

- **Long-term memory uses SQLite + FTS5** via Bun's built-in `bun:sqlite`
  (opencode's plugin runtime). No native build step, no external dependency.
  Search is full-text (BM25) blended with fact importance. The V1 JSONL store
  is migrated automatically on first run and archived as `*.migrated`.
- The memory-injection hook uses opencode's `experimental.session.compacting`,
  which is experimental — the injection path is kept swappable.
- V2: 24/7 daemon + Telegram gateway (external process via the opencode SDK),
  codebase RAG, optional own web UI.
- V3: learning loop (skill auto-generation) once a quality evaluator exists.
