import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"

/**
 * opencore token budget plugin.
 *
 * Tracks token usage per day and warns as a configurable daily budget is
 * approached. State is persisted to ~/.opencore/budget/<YYYY-MM-DD>.json so it
 * survives restarts.
 *
 * Configure via env vars:
 *   opencore_TOKEN_BUDGET   daily token budget (default: 1_000_000)
 *   opencore_BUDGET_WARN    warn threshold as a fraction 0..1 (default: 0.7)
 *
 * NOTE (V1): this is observational + warning only. It does not hard-stop the
 * session. Hard enforcement is a later step once we settle on UX.
 */

const BUDGET = Number(process.env.opencore_TOKEN_BUDGET ?? 1_000_000)
const WARN_AT = Number(process.env.opencore_BUDGET_WARN ?? 0.7)

const dir = join(homedir(), ".opencore", "budget")

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function file(): string {
  return join(dir, `${today()}.json`)
}

type DayState = { date: string; total: number; warned: boolean }

function load(): DayState {
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), "utf8"))
      if (parsed && parsed.date === today()) return parsed
    }
  } catch {
    // corrupt/missing file — start fresh
  }
  return { date: today(), total: 0, warned: false }
}

function save(state: DayState): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file(), JSON.stringify(state), "utf8")
  } catch {
    // best-effort; never crash the agent over budget bookkeeping
  }
}

/** Best-effort extraction of a total token count from a message-like object. */
function extractTokens(obj: any): number {
  const t = obj?.tokens ?? obj?.usage ?? obj?.info?.tokens
  if (!t) return 0
  if (typeof t === "number") return t
  const input = t.input ?? t.prompt ?? 0
  const output = t.output ?? t.completion ?? 0
  const reasoning = t.reasoning ?? 0
  const cacheRead = t.cache?.read ?? 0
  const cacheWrite = t.cache?.write ?? 0
  return input + output + reasoning + cacheRead + cacheWrite
}

export const BudgetPlugin: Plugin = async ({ client }) => {
  let state = load()

  async function log(message: string, level: "info" | "warn" = "info") {
    try {
      await client.app.log({ body: { service: "opencore-budget", level, message } })
    } catch {
      // logging is best-effort
    }
  }

  return {
    event: async ({ event }: { event: any }) => {
      // Reset across day boundaries.
      if (state.date !== today()) state = { date: today(), total: 0, warned: false }

      if (event?.type === "message.updated" || event?.type === "session.idle") {
        const msg = event.properties?.info ?? event.properties?.message ?? event.properties
        const tokens = extractTokens(msg)
        if (tokens > 0) {
          state.total += tokens

          if (!state.warned && state.total >= BUDGET * WARN_AT) {
            state.warned = true
            const pct = Math.round((state.total / BUDGET) * 100)
            await log(
              `Token budget at ${pct}% (${state.total}/${BUDGET} today).`,
              "warn",
            )
          }

          save(state)
        }
      }
    },
  }
}
