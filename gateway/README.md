# opencore Gateway

Talk to opencore from Telegram. The gateway runs an `opencode serve` instance on
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
| any text | Sent to opencore as a prompt in the current mode |

## Config (.env)

| Var | Default | Notes |
|-----|---------|-------|
| `TELEGRAM_BOT_TOKEN` | — | required |
| `opencore_GATEWAY_PORT` | `4099` | local opencode server port |
| `opencore_GATEWAY_DEFAULT_AGENT` | `chat` | `chat` \| `dev` \| `plan` |
| `opencore_GATEWAY_WORKDIR` | cwd | directory the agent operates in |
| `opencore_OPENCODE_BIN` | auto | explicit path to opencode if needed |

State (pairing/allowlist) persists to `~/.opencore/gateway/allowlist.json`.

## Reset pairing

If you need to pair again (lost access, want to change admin, etc.):

```powershell
cd gateway

# 1. Stop the gateway (if running as daemon)
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 stop

# 2. Reset pairing (clears all admins/members, generates new code)
npm run reset-pairing

# 3. Restart (the bot will load the new code)
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 start

# 4. Check logs to confirm the new code
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 logs
```

The new pairing code appears in the logs. Send `/pair <code>` in Telegram to become admin.

**Important:** The gateway must be stopped BEFORE running `reset-pairing`, otherwise it keeps the old code in memory and rejects the new one.

If running manually with `npm run dev`, stop it (Ctrl+C), run `npm run reset-pairing`, then `npm run dev` again.

## Daemon (run at logon, auto-restart)

Once you've confirmed manual mode works, run it as a background daemon. On
Windows this uses the per-user Startup folder (no admin required) plus a
supervisor that restarts the gateway on crash. Logs go to
`~/.opencore/gateway/daemon.log`.

```powershell
npm run build                                                         # compile to dist/
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install   # add to Startup
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 start     # start now
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status    # check
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 logs      # tail logs
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 stop      # stop
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 uninstall # remove from Startup
```

- `install` adds a Startup shortcut so the gateway launches at logon.
- The supervisor (`scripts\run-supervised.ps1`) restarts the gateway on crash
  with backoff, up to 10 times per minute.
- The gateway runs only while you are logged in and your PC is on. For 24/7
  availability independent of your machine, deploy on a server (planned Docker
  setup).

## Docker (24/7 on a server/VPS)

For availability independent of your PC, run opencore in a container. The image
(repo root `Dockerfile`) bundles opencode + opencore's config + this gateway.

```sh
# from the repo root
cp .env.docker.example .env     # set TELEGRAM_BOT_TOKEN, OPENCORE_MODEL, provider key
docker compose up -d --build
docker compose logs -f          # find the pairing code, then /pair in Telegram
```

- `restart: unless-stopped` keeps it alive across crashes/reboots.
- State (long-term memory, pairing) persists in the `opencore-state` volume.
- No inbound ports are published - Telegram is reached via outbound polling.
- Default agent is `chat` (no shell). Set `opencore_GATEWAY_DEFAULT_AGENT=dev` only
  if you accept remote code execution inside the container.
- To let the agent work on a project, mount it at `/work` (see the commented
  volume in `docker-compose.yml`).

## Status

Phases 1-3 complete and verified. The local daemon (Windows Startup + supervisor)
was tested end-to-end: install / start / status / logs / crash auto-restart /
stop / uninstall, all without admin rights. Docker setup (Dockerfile + compose)
for server/VPS 24/7 deployment: compose validated; build/run on the target host.
