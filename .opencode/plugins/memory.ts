import { type Plugin, tool } from "@opencode-ai/plugin"
import { addFact, searchFacts, topByImportance, type Fact } from "./lib/memory-store"

/**
 * MOA two-level memory plugin.
 *
 * Working memory = opencode's native session context (not handled here).
 * Long-term memory = persistent facts in SQLite + FTS5 at
 * ~/.moa/memory/memory.db, surviving across sessions and injected back into
 * context on compaction.
 *
 * V1 used JSONL; this version uses SQLite+FTS5 (full-text search via BM25)
 * running on Bun's built-in `bun:sqlite`. Existing JSONL facts are migrated
 * automatically on first run (see lib/memory-store.ts). The tool surface
 * (memory_remember / memory_search) is unchanged.
 *
 * Provides:
 *   - tool `memory_remember`  : store a fact
 *   - tool `memory_search`    : full-text retrieve relevant facts
 *   - hook `session.idle`     : reminder to capture durable facts
 *   - hook `experimental.session.compacting` : inject top facts into context
 */

export const MemoryPlugin: Plugin = async ({ client }) => {
  async function log(message: string) {
    try {
      await client.app.log({ body: { service: "moa-memory", level: "info", message } })
    } catch {
      /* best-effort */
    }
  }

  return {
    tool: {
      memory_remember: tool({
        description:
          "Store a durable fact about the user or project in long-term memory " +
          "(preferences, goals, decisions, identity, project facts). Use for " +
          "information that should persist across sessions.",
        args: {
          text: tool.schema.string().describe("The fact to remember, phrased standalone."),
          type: tool.schema
            .string()
            .describe("Category: identity | preference | goal | project | decision | note"),
          importance: tool.schema
            .number()
            .min(0)
            .max(1)
            .describe("How important this fact is, 0..1.")
            .optional(),
        },
        async execute(args) {
          const fact: Fact = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: args.text,
            type: args.type || "note",
            importance: typeof args.importance === "number" ? args.importance : 0.5,
            createdAt: new Date().toISOString(),
          }
          await addFact(fact)
          return `Remembered (${fact.type}): ${fact.text}`
        },
      }),

      memory_search: tool({
        description:
          "Search long-term memory for facts relevant to a query. Returns the " +
          "most relevant stored facts about the user or project.",
        args: {
          query: tool.schema.string().describe("What to look for."),
          limit: tool.schema.number().min(1).max(20).optional().describe("Max results (default 5)."),
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
        await log("session idle — consider capturing durable facts via memory_remember")
      }
    },

    // Inject the most important long-term facts into the compaction prompt so
    // they survive context summarization.
    "experimental.session.compacting": async (_input: any, output: any) => {
      const facts = await topByImportance(5)
      if (facts.length === 0) return
      const block =
        "## Long-term memory (MOA)\n" +
        "Persisted facts about the user/project to keep in mind:\n" +
        facts.map((f) => `- [${f.type}] ${f.text}`).join("\n")
      if (Array.isArray(output?.context)) output.context.push(block)
    },
  }
}
