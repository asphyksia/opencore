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
- Hardened permissions: `rm -rf`, `sudo` hard-denied; most bash gated by `ask`.

## Layout

```
.
├── opencode.json            # base config: default agent, permissions, model env
├── .opencode/
│   ├── agents/
│   │   ├── dev.md           # DEV soul (coding)
│   │   └── chat.md          # CHAT soul (conversational)
│   ├── plugins/
│   │   ├── memory.ts        # two-level memory + tools + compaction hook
│   │   ├── lib/
│   │   │   └── memory-store.ts  # SQLite + FTS5 storage layer
│   │   └── budget.ts        # token budget tracking
│   └── package.json         # plugin dependency (@opencode-ai/plugin)
├── package.json             # depends on opencode-ai
├── .env.example             # provider keys + model selection
└── arquitectura-agente.md   # architecture doc (kept in Downloads)
```

Local runtime data lives in `~/.moa/` (memory, budget) — outside the repo.

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
