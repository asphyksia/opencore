import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"

/**
 * Gateway configuration, loaded from environment (.env is read manually to
 * avoid an extra dependency).
 */

export type AgentName = "chat" | "dev" | "plan"

export interface GatewayConfig {
  telegramToken: string
  port: number
  defaultAgent: AgentName
  workdir: string
  opencodeBin?: string
}

function loadDotEnv(): void {
  const path = join(process.cwd(), ".env")
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

function parseAgent(v: string | undefined): AgentName {
  if (v === "dev" || v === "plan" || v === "chat") return v
  return "chat"
}

export function loadConfig(): GatewayConfig {
  loadDotEnv()

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? ""
  if (!telegramToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Copy gateway/.env.example to gateway/.env and fill it in.",
    )
  }

  return {
    telegramToken,
    port: Number(process.env.MOA_GATEWAY_PORT ?? 4099),
    defaultAgent: parseAgent(process.env.MOA_GATEWAY_DEFAULT_AGENT),
    workdir: process.env.MOA_GATEWAY_WORKDIR?.trim() || process.cwd(),
    opencodeBin: process.env.MOA_OPENCODE_BIN?.trim() || undefined,
  }
}

/** Where the gateway stores its state (pairing/allowlist). */
export const stateDir = join(homedir(), ".moa", "gateway")
