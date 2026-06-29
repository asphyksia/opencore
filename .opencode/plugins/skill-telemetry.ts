import { type Plugin, tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs"

/**
 * opencore skill telemetry plugin.
 *
 * Tracks per-skill usage in a sidecar JSON at ~/.opencore/skills/.usage.json,
 * independent of opencode's internal session/tool logs. The native opencode
 * `skill` tool (used to load SKILL.md files into context) fires a
 * `tool.execute.after` hook with the skill name in `output.title` or
 * `input.args.name`; we bump the counter and update last-used timestamp.
 *
 * Mirrors Hermes Agent's `tools/skill_usage.py` design (sidecar, not
 * frontmatter; best-effort, non-blocking; never breaks the underlying tool).
 *
 * Provides:
 *   - tool `skill_stats` : inspect usage (all skills, by name, or stale)
 *   - hook `tool.execute.after` : bump counter when the `skill` tool runs
 *
 * The sidecar is regenerated on demand; if it is missing or corrupt, it is
 * rebuilt as a fresh empty map. No state is required to bootstrap.
 */

const skillsDir = join(homedir(), ".opencore", "skills")
const usageFile = join(skillsDir, ".usage.json")
const lockFile = join(skillsDir, ".usage.json.lock")

type Usage = {
  use_count: number
  view_count: number
  last_used_at?: string
  last_viewed_at?: string
}

type UsageMap = Record<string, Usage>

function readUsage(): UsageMap {
  try {
    if (existsSync(usageFile)) {
      const parsed = JSON.parse(readFileSync(usageFile, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as UsageMap
      }
    }
  } catch {
    /* corrupt or unreadable — start fresh */
  }
  return {}
}

function writeUsageAtomic(usage: UsageMap): void {
  mkdirSync(skillsDir, { recursive: true })
  const tmp = usageFile + ".tmp"
  writeFileSync(tmp, JSON.stringify(usage, null, 2), "utf8")
  // Atomic on POSIX, replace on Windows
  try {
    renameSync(tmp, usageFile)
  } catch {
    /* fallback for Windows when target exists: overwrite */
    writeFileSync(usageFile, JSON.stringify(usage, null, 2), "utf8")
  }
}

/**
 * Cross-process best-effort lock. Uses a sentinel lock file; we busy-wait
 * briefly (max ~200ms) to serialize concurrent writes from sibling processes
 * (e.g. opencode run + Telegram gateway). Not a true OS lock — good enough
 * for telemetry where the worst case is a lost counter bump.
 */
function withLock<T>(fn: () => T): T {
  mkdirSync(skillsDir, { recursive: true })
  const start = Date.now()
  let lockFd: number | null = null
  while (Date.now() - start < 200) {
    try {
      lockFd = openSync(lockFile, "wx")
      break
    } catch {
      // Another process holds it; wait briefly
      const waitUntil = Date.now() + 10
      while (Date.now() < waitUntil) {
        /* spin briefly */
      }
    }
  }
  try {
    return fn()
  } finally {
    if (lockFd !== null) {
      try {
        closeSync(lockFd)
      } catch {
        /* ignore */
      }
      try {
        // We created it (lockFd !== null), so we must delete it.
        unlinkSync(lockFile)
      } catch {
        /* best-effort: if deletion fails, the next run will time out gracefully */
      }
    }
  }
}

function bumpUsage(skillName: string, field: "use_count" | "view_count", ts: string) {
  if (!skillName) return
  try {
    withLock(() => {
      const usage = readUsage()
      if (!usage[skillName]) {
        usage[skillName] = { use_count: 0, view_count: 0 }
      }
      const entry = usage[skillName]
      entry[field] = (entry[field] || 0) + 1
      if (field === "use_count") {
        entry.last_used_at = ts
      } else {
        entry.last_viewed_at = ts
      }
      writeUsageAtomic(usage)
    })
  } catch {
    /* best-effort: a failed bump never breaks the underlying tool call */
  }
}

/**
 * Best-effort extraction of the skill name from a native `skill` tool call.
 * Different opencode versions pass it in different places, so we try several.
 * Priority: args.name (clean) > metadata.name (clean) > title (may be "Loaded skill: X").
 */
function extractSkillName(input: any, output: any): string | null {
  // 1. args.name — cleanest, no parsing needed
  const args = input?.args
  if (args && typeof args === "object") {
    if (typeof args.name === "string" && args.name.trim()) return args.name.trim()
    if (typeof args.skill === "string" && args.skill.trim()) return args.skill.trim()
  }
  // 2. metadata.name — also clean
  const meta = output?.metadata
  if (meta && typeof meta === "object" && typeof meta.name === "string" && meta.name.trim()) {
    return meta.name.trim()
  }
  // 3. title — may be "Loaded skill: <name>", extract from the prefix if so
  if (typeof output?.title === "string" && output.title.trim()) {
    const m = output.title.match(/^Loaded skill:\s*(.+)$/i)
    if (m) return m[1].trim()
    // Otherwise assume the title IS the name
    return output.title.trim()
  }
  return null
}

function fmtIso(iso?: string): string {
  if (!iso) return "never"
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ")
  } catch {
    return "never"
  }
}

export const SkillTelemetryPlugin: Plugin = async ({ client }) => {
  async function log(message: string, level: "info" | "warn" = "info") {
    try {
      await client.app.log({ body: { service: "opencore-skill-telemetry", level, message } })
    } catch {
      /* best-effort */
    }
  }

  return {
    // Capture skill tool invocations. The native opencode `skill` tool loads
    // a SKILL.md into context; this is the natural place to count usage.
    "tool.execute.after": async (input: any, output: any) => {
      if (input?.tool !== "skill") return
      const skillName = extractSkillName(input, output)
      if (!skillName) {
        await log("skill tool invoked but no skill name could be extracted", "warn")
        return
      }
      bumpUsage(skillName, "use_count", new Date().toISOString())
    },

    tool: {
      skill_stats: tool({
        description:
          "Inspect skill usage telemetry. No args: summary of all skills. " +
          "With `skill`: detail for one. With `unused_days`: list skills idle >N days.",
        args: {
          skill: tool.schema.string().optional().describe("Show detail for one skill."),
          unused_days: tool.schema
            .number()
            .min(1)
            .optional()
            .describe("List skills not used in N days."),
        },
        async execute(args) {
          const usage = readUsage()
          const entries = Object.entries(usage).sort(
            ([, a], [, b]) => b.use_count + b.view_count - (a.use_count + a.view_count),
          )

          if (args.skill) {
            const entry = usage[args.skill]
            if (!entry) return `No telemetry yet for "${args.skill}".`
            return [
              `**${args.skill}**`,
              `- use_count: ${entry.use_count}`,
              `- view_count: ${entry.view_count}`,
              `- last_used: ${fmtIso(entry.last_used_at)}`,
              `- last_viewed: ${fmtIso(entry.last_viewed_at)}`,
            ].join("\n")
          }

          if (args.unused_days) {
            const cutoff = Date.now() - args.unused_days * 86_400_000
            const stale = entries.filter(([, u]) => {
              const last = u.last_used_at || u.last_viewed_at
              return !last || new Date(last).getTime() < cutoff
            })
            if (stale.length === 0) {
              return `All ${entries.length} tracked skill(s) used within ${args.unused_days} days.`
            }
            return (
              `Unused for >${args.unused_days} days:\n` +
              stale
                .map(([name, u]) => `- ${name} (last activity: ${fmtIso(u.last_used_at || u.last_viewed_at)})`)
                .join("\n")
            )
          }

          if (entries.length === 0) {
            return "No skill telemetry yet. Telemetry is recorded when the `skill` tool is used."
          }

          const lines = ["**Skill usage** (sorted by total activity):", ""]
          for (const [name, u] of entries) {
            const last = fmtIso(u.last_used_at || u.last_viewed_at)
            lines.push(
              `- **${name}**: ${u.use_count} use / ${u.view_count} view (last: ${last})`,
            )
          }
          return lines.join("\n")
        },
      }),
    },
  }
}
