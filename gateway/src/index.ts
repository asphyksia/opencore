import { Bot } from "grammy"
import { loadConfig, type AgentName } from "./config.js"
import { Allowlist } from "./allowlist.js"
import { OpencodeService } from "./opencode-service.js"

/**
 * MOA Telegram gateway entry point.
 *
 * Security:
 * - Only allowlisted Telegram users can interact at all.
 * - First user pairs with a one-time code printed to this console.
 * - Default agent is `chat` (no bash). Switching to `dev` (which can run
 *   commands on this machine) is explicit, per-chat, and admin-only.
 * - The opencode server binds to 127.0.0.1 with a gateway-controlled password.
 */

const VALID_AGENTS: AgentName[] = ["chat", "dev", "plan"]

async function main() {
  const cfg = loadConfig()
  const allow = new Allowlist()
  const oc = new OpencodeService(cfg)

  console.log("[moa-gateway] starting opencode server...")
  await oc.start()
  console.log(`[moa-gateway] opencode server healthy on 127.0.0.1:${cfg.port}`)

  // Per-chat state: session id + current agent.
  const chats = new Map<number, { sessionId: string; agent: AgentName }>()

  async function ensureChat(chatId: number): Promise<{ sessionId: string; agent: AgentName }> {
    let st = chats.get(chatId)
    if (!st) {
      const sessionId = await oc.createSession(`telegram:${chatId}`)
      st = { sessionId, agent: cfg.defaultAgent }
      chats.set(chatId, st)
    }
    return st
  }

  // Pairing code shown only on this console (whoever controls the machine).
  if (!allow.hasAdmin) {
    const code = allow.ensurePairingCode()
    console.log("\n========================================")
    console.log("  MOA Gateway pairing code:  " + code)
    console.log("  In Telegram, send:  /pair " + code)
    console.log("========================================\n")
  } else {
    console.log("[moa-gateway] admin already paired; ready.")
  }

  const bot = new Bot(cfg.telegramToken)

  // /start - greeting + auth status
  bot.command("start", async (ctx) => {
    const uid = ctx.from?.id
    if (uid && allow.isAuthorized(uid)) {
      await ctx.reply("MOA is ready. Send a message, or use /chat, /dev, /plan, /new, /status.")
    } else {
      await ctx.reply(
        "This is a private MOA gateway. If you control the host, send `/pair <code>` " +
          "using the code shown in the gateway console.",
      )
    }
  })

  // /pair <code>
  bot.command("pair", async (ctx) => {
    const uid = ctx.from?.id
    if (!uid) return
    const code = (ctx.match ?? "").toString().trim()
    if (!code) {
      await ctx.reply("Usage: /pair <code>")
      return
    }
    const result = allow.tryPair(uid, code)
    if (result === "ok") {
      await ctx.reply("Paired. You are now the admin. Default mode is chat. Send a message to begin.")
      console.log(`[moa-gateway] paired admin: ${uid}`)
    } else if (result === "already") {
      await ctx.reply("You are already authorized.")
    } else {
      await ctx.reply("Invalid pairing code.")
    }
  })

  // Gate: every other update requires authorization.
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id
    if (uid && allow.isAuthorized(uid)) {
      await next()
    } else if (ctx.message && !ctx.message.text?.startsWith("/pair") && !ctx.message.text?.startsWith("/start")) {
      await ctx.reply("Not authorized. Use /pair <code> with the code from the gateway console.")
    }
  })

  // Agent switch commands
  async function switchAgent(ctx: any, agent: AgentName) {
    const chatId = ctx.chat?.id
    const uid = ctx.from?.id
    if (chatId == null) return
    if (agent === "dev" && !allow.isAdmin(uid)) {
      await ctx.reply("dev mode (code execution) is admin-only.")
      return
    }
    const st = await ensureChat(chatId)
    st.agent = agent
    chats.set(chatId, st)
    const note =
      agent === "dev"
        ? "dev on - can edit files and run commands on the host. Be careful."
        : agent === "plan"
          ? "plan on - read-only analysis."
          : "chat on - conversational, no shell."
    await ctx.reply(note)
  }

  bot.command("chat", (ctx) => switchAgent(ctx, "chat"))
  bot.command("dev", (ctx) => switchAgent(ctx, "dev"))
  bot.command("plan", (ctx) => switchAgent(ctx, "plan"))

  // /new - fresh session
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id
    if (chatId == null) return
    const sessionId = await oc.createSession(`telegram:${chatId}`)
    const prev = chats.get(chatId)
    chats.set(chatId, { sessionId, agent: prev?.agent ?? cfg.defaultAgent })
    await ctx.reply("Started a new session.")
  })

  // /status
  bot.command("status", async (ctx) => {
    const chatId = ctx.chat?.id
    if (chatId == null) return
    const st = chats.get(chatId)
    await ctx.reply(`mode: ${st?.agent ?? cfg.defaultAgent}\nsession: ${st ? "active" : "none yet"}`)
  })

  // Plain text -> prompt the agent
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text
    if (text.startsWith("/")) return // commands handled above
    const chatId = ctx.chat.id
    const st = await ensureChat(chatId)
    await ctx.replyWithChatAction("typing")
    try {
      const reply = await oc.prompt(st.sessionId, st.agent, text)
      // Telegram hard limit is 4096 chars per message.
      await ctx.reply(reply.slice(0, 4000))
    } catch (err: any) {
      console.error("[moa-gateway] prompt error:", err?.message ?? err)
      await ctx.reply("Error talking to MOA: " + (err?.message ?? "unknown"))
    }
  })

  bot.catch((err) => {
    console.error("[moa-gateway] bot error:", err.message)
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[moa-gateway] shutting down...")
    oc.stop()
    process.exit(0)
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  console.log("[moa-gateway] starting Telegram bot (long-polling)...")
  await bot.start({
    onStart: () => console.log("[moa-gateway] bot online. Default agent: " + cfg.defaultAgent),
  })
}

main().catch((err) => {
  console.error("[moa-gateway] fatal:", err?.message ?? err)
  process.exit(1)
})
