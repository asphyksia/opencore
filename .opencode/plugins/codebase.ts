import { type Plugin, tool } from "@opencode-ai/plugin"
import { join, relative, sep } from "node:path"
import {
  indexFile,
  removeFile,
  clearIndex,
  search,
  stats,
  setMeta,
  getMeta,
} from "./lib/codebase-store"
import { discoverFiles, chunkFile, shouldIndex, isProjectRoot } from "./lib/indexer"

/**
 * MOA codebase RAG plugin.
 *
 * Indexes the active project's files into a per-project SQLite + FTS5 store and
 * exposes full-text search so the agent can answer "where is X handled?"
 * without the files being pasted in manually. Reuses the same FTS5 approach as
 * long-term memory.
 *
 * Provides:
 *   - tool `codebase_index`   : (re)build the index for the current project
 *   - tool `codebase_search`  : full-text search over indexed code chunks
 *   - hook `file.edited`      : incremental re-index of a changed file
 *
 * The index is scoped per project (keyed by the project directory). Search
 * is keyword/BM25 based — no embeddings (a known limitation: no synonym match).
 */

export const CodebasePlugin: Plugin = async ({ directory, worktree, $, client }) => {
  const projectDir = worktree || directory || process.cwd()

  async function log(message: string, level: "info" | "warn" = "info") {
    try {
      await client.app.log({ body: { service: "moa-codebase", level, message } })
    } catch {
      /* best-effort */
    }
  }

  // Normalize an absolute path to a project-relative POSIX path.
  function toRel(p: string): string {
    const rel = relative(projectDir, p)
    if (rel.startsWith("..")) return "" // outside project
    return rel.split(sep).join("/")
  }

  async function reindexOne(relPath: string): Promise<boolean> {
    if (!relPath || !shouldIndex(relPath)) return false
    const chunks = chunkFile(projectDir, relPath)
    if (chunks.length === 0) {
      await removeFile(projectDir, relPath)
      return false
    }
    await indexFile(projectDir, relPath, chunks)
    return true
  }

  async function buildIndex(rebuild: boolean): Promise<{ files: number; chunks: number }> {
    if (rebuild) await clearIndex(projectDir)
    const files = await discoverFiles(projectDir, $)
    let indexed = 0
    for (const f of files) {
      if (await reindexOne(f)) indexed++
    }
    await setMeta(projectDir, "lastIndexed", new Date().toISOString())
    const s = await stats(projectDir)
    await log(`indexed ${indexed} files (${s.chunks} chunks) in ${projectDir}`)
    return s
  }

  return {
    tool: {
      codebase_index: tool({
        description:
          "Build or rebuild the full-text index of the current project's code " +
          "so it can be searched with codebase_search. Run this once per " +
          "project (or after large changes). Respects .gitignore.",
        args: {
          rebuild: tool.schema
            .boolean()
            .optional()
            .describe("If true, clear the existing index before reindexing."),
        },
        async execute(args) {
          if (!isProjectRoot(projectDir)) {
            return (
              "Current directory does not look like a project root (no .git, " +
              "package.json, etc.), so it was not indexed. Open MOA from inside " +
              "a project to use codebase search."
            )
          }
          const s = await buildIndex(!!args.rebuild)
          return `Indexed ${s.files} files into ${s.chunks} chunks for this project.`
        },
      }),

      codebase_search: tool({
        description:
          "Search the current project's code for relevant snippets by keyword. " +
          "Returns matching chunks with file path and line range. Use this to " +
          "locate where something is implemented before reading whole files.",
        args: {
          query: tool.schema.string().describe("Keywords to search for in the code."),
          limit: tool.schema
            .number()
            .min(1)
            .max(20)
            .optional()
            .describe("Max results (default 8)."),
        },
        async execute(args) {
          const limit = args.limit ?? 8

          // Lazy auto-index: build the index on first use so the user/agent
          // doesn't have to call codebase_index manually. Only for real
          // project roots — never walk an arbitrary directory.
          const last = await getMeta(projectDir, "lastIndexed")
          if (!last) {
            if (!isProjectRoot(projectDir)) {
              return (
                "Current directory does not look like a project root, so there " +
                "is no code index. Open MOA from inside a project to search code."
              )
            }
            await log("no index yet — building lazily on first search")
            await buildIndex(false)
          }

          const hits = await search(projectDir, args.query, limit)
          if (hits.length === 0) {
            return "No matching code found."
          }
          return hits
            .map(
              (h) =>
                `### ${h.path}:${h.startLine}-${h.endLine}\n` +
                "```\n" +
                (h.content.length > 1200 ? h.content.slice(0, 1200) + "\n…" : h.content) +
                "\n```",
            )
            .join("\n\n")
        },
      }),
    },

    event: async ({ event }: { event: any }) => {
      // Incremental re-index when a file changes.
      if (event?.type === "file.edited") {
        const p = event.properties?.path ?? event.properties?.file ?? event.properties?.filePath
        if (typeof p === "string") {
          const rel = p.includes(sep) || p.includes("/") ? toRel(p) : p
          if (rel) {
            try {
              await reindexOne(rel)
            } catch {
              /* best-effort incremental update */
            }
          }
        }
      }
    },
  }
}
