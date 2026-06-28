# MOA Gateway

Talk to MOA from Telegram. The gateway runs an `opencode serve` instance on
localhost and bridges your Telegram messages to it, with pairing + allowlist
security so only you can use it.

## How it works

```
Telegram  <--outbound polling-->  gateway (this)  <--HTTP 127.0.0.1-->  opencode serve
```

- The gateway **starts its own `opencode serve`** and sets the server password
  itself (so it never depends on an ambient `OPENCODE_SERVER_PASSWORD`, which
  can vary between shells).
- The server binds to `127.0.0.1` only. Telegram is reached via **outbound**
  long-polling, so **no inbound ports are opened** on your machine.
- Each Telegram chat maps to an opencode session. You pick the agent per chat.

## Security model

- **Allowlist**: only authorized Telegram user IDs can interact at all.
- **Pairing**: on first run the gateway prints a one-time code to its console
  (visible only to whoever controls the host). Send `/pair <code>` in Telegram
  to become the admin. The code is then consumed.
- **Default agent is `chat`** (no shell). Switching to `dev` — which can edit
  files and run commands on the host — is explicit, per-chat, and **admin-only**.
- The bot token and server password are never committed (`.env`, gitignored).

> Your PC must be on for the bot to respond (the gateway runs locally).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Configure:
   ```sh
   cp .env.example .env
   # set TELEGRAM_BOT_TOKEN=... in .env
   ```
3. Install deps:
   ```sh
   npm install
   ```
4. Run (manual mode):
   ```sh
   npm run dev      # tsx, no build step
   # or
   npm run build && npm start
   ```
5. The console prints a pairing code. In Telegram, send `/pair <code>` to your
   bot. You're now the admin.

## Commands

| Command | What it does |
|---------|--------------|
| `/start` | Greeting + auth status |
| `/pair <code>` | Pair with the one-time code (first user becomes admin) |
| `/chat` | Switch this chat to conversational mode (no shell) |
| `/dev` | Switch to coding mode (edits + commands) — **admin only** |
| `/plan` | Switch to read-only analysis mode |
| `/new` | Start a fresh session |
| `/status` | Show current mode + session state |
| any text | Sent to MOA as a prompt in the current mode |

## Config (.env)

| Var | Default | Notes |
|-----|---------|-------|
| `TELEGRAM_BOT_TOKEN` | — | required |
| `MOA_GATEWAY_PORT` | `4099` | local opencode server port |
| `MOA_GATEWAY_DEFAULT_AGENT` | `chat` | `chat` \| `dev` \| `plan` |
| `MOA_GATEWAY_WORKDIR` | cwd | directory the agent operates in |
| `MOA_OPENCODE_BIN` | auto | explicit path to opencode if needed |

State (pairing/allowlist) persists to `~/.moa/gateway/allowlist.json`.

## Status

Phases 1-2 complete and verified (server bridge, pairing, allowlist, agent
commands). Phase 3 (auto-start daemon) is the next step — run the gateway
manually first to confirm your token/pairing, then we wrap it as a service.
