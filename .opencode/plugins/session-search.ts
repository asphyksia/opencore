import { type Plugin, tool } from "@opencode-ai/plugin"
import {
  upsertSession,
  indexMessages,
  indexedMessageIds,
  discover,
  messagesAround,
  recentSessions,
  type StoredMessage,
} from "./lib/session-store"

/**
 * opencore session search plugin — long-term cross-session recall.
 *
 * opencore maintains its own SQLite + FTS5 index of past conversations,
 * independent of opencode's internal session DB (so it doesn't depend on
 * opencode's private schema). Messages are indexed on `session.idle` by
 * pulling the full message list via the SDK and storing any new ones.
 *
 * Provides:
 *   - tool `session_search`   : recall past conversations (3 modes)
 *   - hook `session.idle`     : incrementally index the current session
 *
 * The session_search tool has three modes, inferred from arguments (no mode
 * parameter), mirroring Hermes Agent's design:
 *   1. DISCOVERY — pass `query`: FTS5 search across all past sessions
 *   2. SCROLL    — pass `session_id` + `around_message_id`: window of messages
 *   3. BROWSE    — no args: list recent sessions chronologically
 *
 * All modes are zero-LLM-cost: pure SQLite queries returning real messages.
 */

const MAX_TEXT_PER_MESSAGE = 4000 // cap stored text to keep the index lean

function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text)
    .join("\n")
    .slice(0, MAX_TEXT_PER_MESSAGE)
}

function fmtTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "unknown"
  try {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ")
  } catch {
    return "unknown"
  }
}

export const SessionSearchPlugin: Plugin = async ({ client }) => {
  // Avoid re-indexing the same session repeatedly in a tight idle loop.
  const lastIndexedCount = new Map<string, number>()

  async function log(message: string, level: "info" | "warn" = "info") {
    try {
      await client.app.log({ body: { service: "opencore-session-search", level, message } })
    } catch {
      /* best-effort */
    }
  }

  /** Pull the current session's messages and index any new ones. */
  async function indexSession(sessionId: string): Promise<void> {
    if (!sessionId || sessionId.startsWith("memory-temp-")) return
    try {
      const msgs = await client.session.messages({ path: { id: sessionId } })
      const list = msgs.data?.messages
      if (!Array.isArray(list) || list.length === 0) return

      // Skip if message count hasn't grown since last index for this session.
      const prev = lastIndexedCount.get(sessionId) ?? -1
      if (list.length === prev) return
      lastIndexedCount.set(sessionId, list.length)

      // Fetch session metadata (title) — best-effort.
      let title = ""
      let createdAt = Date.now()
      try {
        const s = await client.session.get({ path: { id: sessionId } })
        title = (s.data as any)?.title ?? ""
        createdAt = (s.data as any)?.time?.created ?? createdAt
      } catch {
        /* metadata is optional */
      }

      const existing = await indexedMessageIds(sessionId)
      const toStore: StoredMessage[] = []

      for (const m of list as any[]) {
        // Messages from session.messages() have .id, .role, .parts at the top level
        // (same shape as used in memory.ts auto-extraction).
        const id = m.id
        const role = m.role
        const parts = Array.isArray(m.parts) ? m.parts : []
        if (!id || !role || existing.has(id)) continue
        const text = extractTextFromParts(parts)
        if (!text) continue
        toStore.push({
          id,
          sessionId,
          role,
          text,
          createdAt: m.time?.created ?? Date.now(),
        })
      }

      await upsertSession({ id: sessionId, title, createdAt, updatedAt: Date.now() })

      if (toStore.length > 0) {
        const n = await indexMessages(toStore)
        await log(`indexed ${n} new message(s) in session ${sessionId} (total: ${list.length})`)
      }
    } catch (err) {
      await log(`index failed for session ${sessionId}: ${(err as any)?.message ?? String(err)}`, "warn")
    }
  }

  return {
    tool: {
      session_search: tool({
        description:
          "Recall past conversations across sessions. Three modes:\n" +
          "- DISCOVERY: pass `query` to full-text search all past sessions.\n" +
          "- SCROLL: pass `session_id` + `around_message_id` to read a window " +
          "of messages around a specific point.\n" +
          "- BROWSE: pass nothing to list recent sessions.\n" +
          "Use this when the user references something from a previous " +
          "conversation, or to recall how a problem was solved before.",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe("Keywords to search past conversations (DISCOVERY mode)."),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Session to scroll within (SCROLL mode, with around_message_id)."),
          around_message_id: tool.schema
            .string()
            .optional()
            .describe("Anchor message id to read around (SCROLL mode)."),
          limit: tool.schema
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe("Max results (default 8 for discovery, 10 for browse)."),
        },
        async execute(args, context) {
          const currentSession = context?.sessionID

          // Lazy-index the current session first (if not already done), ensuring
          // it's available for search. This runs on every tool call but is fast
          // (DB check + insert-if-new only) and works in all modes (TUI, run,
          // gateway) since it doesn't depend on event hooks firing.
          if (currentSession) await indexSession(currentSession).catch(() => {})

          // SCROLL mode
          if (args.session_id && args.around_message_id) {
            const window = await messagesAround(args.session_id, args.around_message_id, 5)
            if (window.length === 0) return "No messages found around that anchor."
            return window
              .map((m) => `[${fmtTime(m.createdAt)}] ${m.role}: ${m.text.slice(0, 500)}`)
              .join("\n\n")
          }

          // DISCOVERY mode
          if (args.query) {
            const hits = await discover(args.query, args.limit ?? 8, currentSession)
            if (hits.length === 0) return "No past conversations matched that query."
            return hits
              .map(
                (h) =>
                  `Session "${h.sessionTitle || h.sessionId}" [${fmtTime(h.createdAt)}]\n` +
                  `  ${h.role} (msg ${h.messageId}): ${h.snippet}`,
              )
              .join("\n\n")
          }

          // BROWSE mode
          const sessions = await recentSessions(args.limit ?? 10)
          if (sessions.length === 0) return "No past sessions indexed yet."
          return sessions
            .map((s) => `- ${s.title || s.id} [${fmtTime(s.updatedAt)}] (id: ${s.id})`)
            .join("\n")
        },
      }),
    },
  }
}
