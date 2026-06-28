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
- **Hybrid semantic search** (`lib/embeddings.ts` + `lib/hybrid.ts`) — applied to
  BOTH memory and codebase. BM25 + vector cosine fused via Reciprocal Rank Fusion.
  Embeddings via any OpenAI-compatible `/v1/embeddings` endpoint (llama.cpp =
  recommended local, Ollama, or cloud). Config read from `~/.moa/embeddings.json`
  (so desktop app + daemon work, not just shell env) OR `MOA_EMBED_*` env vars.
  Per-item Float32 BLOB vectors keyed by content hash + model id (incremental
  re-embed only on change). FALLBACK: if no embeddings configured, transparently
  uses BM25 as before — nothing breaks. Default model: harrier-oss-v1-0.6b Q8_0
  (1024-dim, MTEB 69.0, MIT). VERIFIED end-to-end: a paraphrased query with no
  shared words ('que lenguaje le gusta') retrieved 'prefiere TypeScript', and a
  conceptual code query found the right file — both impossible with BM25 alone.
  Installers write `~/.moa/embeddings.json` via -Embeddings / --embeddings flag.
  Docker: optional `embeddings` service (ghcr.io/ggml-org/llama.cpp:server,
  `--profile embeddings`).
- **MCP servers** — configured under `mcp` in `opencode.json` (native opencode):
  `context7` (library docs) and `gh_grep` (GitHub code search), both remote/no-auth.
  Verified connected and usable by the agent.
- **Agent Skills** — `SKILL.md` files (agentskills.io format, native to opencode)
  in `.opencode/skills/<name>/`. Example: `git-release`. Loaded on-demand via the
  `skill` tool. IMPORTANT: this is the same format the V3 Hermes-style auto-
  creation will emit, so the format work is already done — V3 only needs the
  quality evaluator. Verified: agent discovers and loads the skill.
- **Install** — `scripts/install.ps1` (Windows) and `scripts/install.sh` (macOS/
  Linux) sync agents/plugins to `~/.config/opencode`, ensure the
  `@opencode-ai/plugin` dependency, and merge MOA defaults (default_agent,
  permissions, MCP servers) into the global `opencode.json` WITHOUT touching the
  user's provider/model. Non-intrusive: `build` is only disabled with the opt-in
  `-DisableBuild` / `--disable-build` flag. Idempotent. PowerShell 5.1 compatible.
- **Telegram gateway** (`gateway/`, separate Node package) — talk to MOA from
  Telegram. Spawns its OWN `opencode serve` and sets the server password itself
  (the ambient `OPENCODE_SERVER_PASSWORD` varies between shells -> 401s; this
  was a Phase 0 finding). Server binds 127.0.0.1; Telegram via outbound polling
  (no inbound ports). Security: allowlist + one-time pairing code (admin), default
  agent `chat` (no shell), `dev` is admin-only and explicit. Commands: /pair,
  /chat, /dev, /plan, /new, /status. Built on grammy + @opencode-ai/sdk.
  Phases 1-2 done and smoke-tested end-to-end (spawn -> session -> prompt).
  Phase 3 (auto-start daemon) done and verified. VERIFIED in real use: gateway
  pairs, responds in chat mode, RAG + memory work over Telegram. Command menu
  registered via setMyCommands.
  SESSION FINDING (resolves the earlier open question): Telegram and the desktop
  GUI do NOT share a live session - the gateway always creates a fresh
  `telegram:<chatId>` session on its own opencode serve. What they DO share:
  long-term memory (~/.moa/memory/memory.db is global) and codebase RAG (if same
  workdir). So: live conversation = separate; memory + code knowledge = shared.
- **Gateway daemon (local, Windows)** — `gateway/scripts/daemon.ps1` +
  `run-supervised.ps1`. Uses the per-user Startup folder (NO admin needed; Task
  Scheduler required elevation which we don't have) + a supervisor that restarts
  the gateway on crash (backoff, max 10/min). Commands: install/start/status/
  logs/stop/uninstall. Logs to ~/.moa/gateway/daemon.log. Runs the compiled
  dist/ build. VERIFIED end-to-end including crash auto-restart. Runs only while
  logged in + PC on; for 24/7 independent of the machine, use the Docker setup
  below (deploy where opencode lives: local PC = daemon, VPS = Docker).
- **Gateway Docker (server/VPS)** — `Dockerfile` + `docker-compose.yml` +
  `.dockerignore` + `.env.docker.example` + `gateway/docker/opencode.global.json`.
  Bun+Node base, installs opencode globally, builds the gateway, copies MOA
  config (agents/plugins/skills) into ~/.config/opencode, secrets via env at
  runtime. `restart: unless-stopped`, persistent `moa-state` volume, NO published
  ports (Telegram via outbound polling). compose config validated; image build
  not run here (no Docker daemon on this machine) - build/run on the target VPS.

## Runtime facts

- opencode CLI version 1.17.11; plugins run under **Bun** (so `bun:sqlite` + FTS5
  are available with no native build step).
- Provider and models: configured by the user in `~/.config/opencode/opencode.json`.
  MOA is model-agnostic.
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

- Real-use testing of chat/dev (tone, memory recall, RAG).
- Possible: more MCP servers, agentskills.io skills, embeddings (semantic
  search), image/voice tools.

## Commit log (recent)

- `fd961b9` Disable redundant `build`; installer 5.1-compatible
- `fc1beb2` Global install script; fix codebase_search hang outside projects
- `fe245e3` Wire memory + RAG into souls; lazy auto-index
- `b134a97` Add codebase RAG plugin
- `eefa674` Migrate memory to SQLite + FTS5
