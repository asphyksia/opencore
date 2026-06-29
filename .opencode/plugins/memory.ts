import { type Plugin, tool } from "@opencode-ai/plugin"
import {
  addFact,
  searchFacts,
  topByImportance,
  backfillEmbeddings,
  updateFact,
  deleteFact,
  type Fact,
} from "./lib/memory-store"

/**
 * opencore two-level memory plugin.
 *
 * Working memory = opencode's native session context (not handled here).
 * Long-term memory = persistent facts in SQLite + FTS5 at
 * ~/.opencore/memory/memory.db, surviving across sessions and injected back into
 * context on compaction.
 *
 * V2: Automatic extraction on session.idle + conflict resolution (mem0-style).
 * Facts are extracted via a small LLM call over the recent conversation window,
 * and new facts are reconciled with similar existing ones (ADD/UPDATE/DELETE/SKIP).
 *
 * Provides:
 *   - tool `memory_remember`  : store a fact (with conflict resolution)
 *   - tool `memory_search`    : full-text retrieve relevant facts
 *   - hook `session.idle`     : automatic extraction of durable facts
 *   - hook `experimental.session.compacting` : inject top facts into context
 */

const REFLECTION_INTERVAL = 5 // Reflect every N turns
const REFLECTION_WINDOW = 6 // Use last N messages
const REFLECTION_MIN_TOKENS = 50 // Skip reflection if last message is tiny

export const MemoryPlugin: Plugin = async ({ client }) => {
  let turnsSinceReflection = 0
  let lastReflectionHash = ""
  let alwaysVisibleCache: { facts: Fact[]; expiresAt: number } | null = null
  const tempSessionPrefix = "memory-temp-" // Prefix for our temp sessions

  // Cache for always-visible facts (refreshed every 5 minutes)
  const CACHE_TTL = 5 * 60 * 1000

  async function getAlwaysVisibleFacts(): Promise<Fact[]> {
    const now = Date.now()
    if (alwaysVisibleCache && now < alwaysVisibleCache.expiresAt) {
      return alwaysVisibleCache.facts
    }
    const facts = await topByImportance(5)
    alwaysVisibleCache = { facts, expiresAt: now + CACHE_TTL }
    return facts
  }

  /**
   * OPTIONAL: returns `{providerID, modelID}` if the user has set `small_model`
   * in their opencode config, otherwise returns null. Reflection and conflict
   * resolution use this when available to save tokens, and fall back to the
   * main model automatically otherwise. Users who haven't configured it pay
   * nothing extra — the feature is entirely opt-in.
   */
  let smallModelCache: { providerID: string; modelID: string } | null | undefined = undefined
  async function getSmallModel(): Promise<{ providerID: string; modelID: string } | null> {
    if (smallModelCache !== undefined) return smallModelCache
    try {
      const cfg = await client.config.get()
      const sm = (cfg.data as any)?.small_model
      if (typeof sm === "string" && sm.includes("/")) {
        const [providerID, modelID] = sm.split("/", 2)
        if (providerID && modelID) {
          smallModelCache = { providerID, modelID }
          return smallModelCache
        }
      }
    } catch {
      /* fall through to null */
    }
    smallModelCache = null
    return null
  }

  async function log(message: string, level: "info" | "warn" = "info") {
    try {
      await client.app.log({ body: { service: "opencore-memory", level, message } })
    } catch {
      /* best-effort */
    }
  }

  /**
   * Execute an isolated LLM call in a temporary child session. Uses
   * `small_model` if the user has configured one in opencode.json, otherwise
   * falls back to the main model. Returns the text response or null on error.
   */
  async function llmCall(parentSessionId: string, promptText: string): Promise<string | null> {
    let tempSessionId: string | null = null
    try {
      // Create temporary child session with recognizable prefix
      const session = await client.session.create({
        body: { parentID: parentSessionId, title: `${tempSessionPrefix}${Date.now()}` },
      })
      if (!session.data?.id) return null
      tempSessionId = session.data.id

      // Use small_model if configured, otherwise the agent's main model.
      const model = await getSmallModel()

      const result = await client.session.prompt({
        path: { id: tempSessionId },
        body: {
          agent: "dev",
          noReply: true,
          tools: {}, // Disable all tools for the temp call
          ...(model && { model }),
          parts: [{ type: "text", text: promptText }],
        },
      })

      if (!result.data?.parts) return null
      return extractTextFromParts(result.data.parts)
    } catch (err) {
      await log(`LLM call failed: ${err?.message ?? "unknown"}`, "warn")
      return null
    } finally {
      // Clean up temp session
      if (tempSessionId) {
        try {
          await client.session.delete({ path: { id: tempSessionId } })
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  /**
   * Conflict resolution: given a new fact and similar existing ones, decide
   * ADD | UPDATE <id> | DELETE <id> | SKIP via a small LLM call.
   */
  async function resolveConflict(
    sessionId: string,
    newFact: { text: string; type: string; importance: number },
    similar: Fact[],
  ): Promise<{ action: "ADD" | "UPDATE" | "DELETE" | "SKIP"; targetId?: string }> {
    if (similar.length === 0) return { action: "ADD" }

    const prompt = `You are a memory reconciliation agent. A new fact is being stored. Compare it with existing similar facts and decide the best action.

NEW FACT:
- Type: ${newFact.type}
- Text: ${newFact.text}
- Importance: ${newFact.importance}

EXISTING SIMILAR FACTS:
${similar.map((f, i) => `${i + 1}. [${f.id}] (${f.type}, importance ${f.importance}): ${f.text}`).join("\n")}

Return ONLY a JSON object with this exact structure:
{
  "action": "ADD" | "UPDATE" | "DELETE" | "SKIP",
  "targetId": "<id>" (only if UPDATE or DELETE),
  "reason": "brief explanation"
}

Rules:
- ADD: the new fact is distinct and valuable
- UPDATE: the new fact replaces/improves an existing one (return its id)
- DELETE: an existing fact is now incorrect/obsolete (return its id)
- SKIP: the new fact is redundant or lower quality than existing ones`

    const text = await llmCall(sessionId, prompt)
    if (!text) return { action: "ADD" }

    const json = extractJSON(text)
    if (!json) return { action: "ADD" }

    const action = json.action?.toUpperCase()
    if (!["ADD", "UPDATE", "DELETE", "SKIP"].includes(action)) return { action: "ADD" }

    return {
      action: action as "ADD" | "UPDATE" | "DELETE" | "SKIP",
      targetId: json.targetId,
    }
  }

  /**
   * Automatic extraction: read recent conversation and extract 0-N durable facts.
   * Called on session.idle, but throttled to avoid excessive LLM calls.
   */
  async function autoExtractFacts(sessionId: string): Promise<void> {
    turnsSinceReflection++
    if (turnsSinceReflection < REFLECTION_INTERVAL) return

    try {
      // Fetch recent messages
      const msgs = await client.session.messages({ path: { id: sessionId } })
      if (!msgs.data?.messages) return

      const recent = msgs.data.messages.slice(-REFLECTION_WINDOW)
      if (recent.length === 0) return

      // Build a transcript hash to avoid re-processing the same window
      const transcriptText = recent.map((m) => m.role + ":" + extractTextFromParts(m.parts)).join("\n")
      const hash = simpleHash(transcriptText)
      if (hash === lastReflectionHash) return

      // Skip if last message is tiny (just "ok" or "thanks")
      const lastMsg = recent[recent.length - 1]
      const lastText = extractTextFromParts(lastMsg.parts)
      if (lastText.split(/\s+/).length < REFLECTION_MIN_TOKENS / 10) return

      lastReflectionHash = hash
      turnsSinceReflection = 0

      await log(`Reflecting on ${recent.length} recent messages...`)

      const prompt = `You are a memory extraction agent. Read the recent conversation and extract 0-5 durable facts worth remembering across sessions.

RECENT CONVERSATION:
${recent.map((m) => `${m.role}: ${extractTextFromParts(m.parts)}`).join("\n\n")}

Extract facts that are:
- Durable (preferences, goals, decisions, project conventions, identity)
- NOT transient details (what file was just edited, temporary todos)
- Standalone (no pronouns - "user prefers TypeScript", not "they prefer TypeScript")

Return ONLY a JSON array of facts:
[
  { "text": "fact text", "type": "preference|goal|project|decision|identity|note", "importance": 0.0-1.0 },
  ...
]

If nothing is worth remembering, return: []`

      const text = await llmCall(sessionId, prompt)
      if (!text) return

      const json = extractJSON(text)
      if (!Array.isArray(json) || json.length === 0) {
        await log("No facts extracted")
        return
      }

      // Store each extracted fact (with conflict resolution)
      for (const item of json) {
        if (!item.text || !item.type) continue
        const fact: Fact = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: String(item.text),
          type: String(item.type),
          importance: typeof item.importance === "number" ? item.importance : 0.5,
          createdAt: new Date().toISOString(),
          source: "auto-extract",
        }

        // Check for conflicts
        const similar = await searchFacts(fact.text, 5)
        const resolution = await resolveConflict(sessionId, fact, similar)

        if (resolution.action === "ADD") {
          await addFact(fact)
          await log(`Auto-stored: [${fact.type}] ${fact.text}`)
        } else if (resolution.action === "UPDATE" && resolution.targetId) {
          await updateFact(resolution.targetId, fact.text, fact.importance)
          await log(`Updated fact ${resolution.targetId}`)
        } else if (resolution.action === "DELETE" && resolution.targetId) {
          await deleteFact(resolution.targetId)
          await log(`Deleted obsolete fact ${resolution.targetId}`)
        } else if (resolution.action === "SKIP") {
          await log(`Skipped redundant fact: ${fact.text}`)
        }
      }
    } catch (err) {
      await log(`Auto-extraction failed: ${err?.message ?? "unknown"}`, "warn")
    }
  }

  // Backfill embeddings for any facts missing an up-to-date vector
  void backfillEmbeddings()
    .then((n) => {
      if (n > 0) void log(`backfilled embeddings for ${n} fact(s)`)
    })
    .catch(() => {})

  return {
    tool: {
      memory_remember: tool({
        description: "Store a durable fact in long-term memory (preferences, goals, decisions, project facts).",
        args: {
          text: tool.schema.string().describe("The fact, phrased standalone."),
          type: tool.schema.string().describe("identity|preference|goal|project|decision|note"),
          importance: tool.schema.number().min(0).max(1).optional().describe("0..1"),
        },
        async execute(args, context) {
          const fact: Fact = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: args.text,
            type: args.type || "note",
            importance: typeof args.importance === "number" ? args.importance : 0.5,
            createdAt: new Date().toISOString(),
            source: "manual",
          }

          // Check for conflicts before storing (if we have sessionId for LLM resolution)
          const sessionId = context?.sessionID
          if (sessionId) {
            const similar = await searchFacts(fact.text, 5)
            const resolution = await resolveConflict(sessionId, fact, similar)

            if (resolution.action === "ADD") {
              await addFact(fact)
              return `Remembered (${fact.type}): ${fact.text}`
            } else if (resolution.action === "UPDATE" && resolution.targetId) {
              await updateFact(resolution.targetId, fact.text, fact.importance)
              return `Updated existing fact: ${fact.text}`
            } else if (resolution.action === "DELETE" && resolution.targetId) {
              await deleteFact(resolution.targetId)
              await addFact(fact)
              return `Replaced obsolete fact with: ${fact.text}`
            } else {
              return `Skipped: fact is redundant with existing memory`
            }
          } else {
            // No session context — add directly (e.g. from Telegram or external call)
            await addFact(fact)
            return `Remembered (${fact.type}): ${fact.text}`
          }
        },
      }),

      memory_search: tool({
        description: "Search long-term memory for facts relevant to a query.",
        args: {
          query: tool.schema.string().describe("What to look for."),
          limit: tool.schema.number().min(1).max(20).optional(),
        },
        async execute(args) {
          const limit = args.limit ?? 5
          const facts = await searchFacts(args.query, limit)
          if (facts.length === 0) return "No relevant memories found."
          return facts.map((f) => `- [${f.type}] ${f.text}`).join("\n")
        },
      }),
    },

    event: async ({ event }: { event: any }) => {
      if (event?.type === "session.idle") {
        const sessionId = event?.properties?.sessionID ?? event?.properties?.sessionId
        if (sessionId) {
          // Fire-and-forget: don't block the idle event
          void autoExtractFacts(sessionId).catch(() => {})
        }
      }
    },

    // Inject the most important facts into every prompt (always-visible pattern A)
    "experimental.chat.system.transform": async (input: any, output: any) => {
      // Skip injection in our own temp sessions to avoid loops
      const sessionId = input?.sessionID
      if (sessionId && sessionId.startsWith(tempSessionPrefix)) return

      const facts = await getAlwaysVisibleFacts()
      if (facts.length === 0) return

      // Compact format: type abbrev + fact, one per line. ~30% smaller than
      // "## Long-term memory...\nKey facts...\n- [type] text" headers.
      const block =
        "[opencore mem] " +
        facts.map((f) => `${f.type}:${f.text}`).join(" | ")
      if (Array.isArray(output?.system)) {
        output.system.push(block)
      }
    },

    // Also inject into the compaction prompt so they survive context summarization.
    "experimental.session.compacting": async (_input: any, output: any) => {
      const facts = await getAlwaysVisibleFacts()
      if (facts.length === 0) return
      const block =
        "[opencore mem] " +
        facts.map((f) => `${f.type}:${f.text}`).join(" | ")
      if (Array.isArray(output?.context)) output.context.push(block)
    },
  }
}

// Helpers

function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
}

function extractJSON(text: string): any {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[1] || jsonMatch[0])
  } catch {
    return null
  }
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h.toString(36)
}
