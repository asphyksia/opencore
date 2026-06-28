import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { AgentName, GatewayConfig } from "./config.js"

/**
 * Owns the opencode server lifecycle and talks to it via the SDK.
 *
 * Phase 0 finding: the ambient OPENCODE_SERVER_PASSWORD can vary between
 * shells, causing intermittent 401s. So the gateway SETS its own password when
 * spawning `opencode serve`, and uses exactly that to authenticate. It controls
 * both sides — no dependency on the surrounding environment.
 *
 * The server binds to 127.0.0.1 only (never exposed to the network); Telegram
 * reaches us via outbound long-polling, so no inbound ports are opened.
 */

function findOpencodeBin(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit
  const candidates = [
    join(
      homedir(),
      "AppData",
      "Local",
      "pi-node",
      "current",
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    ),
    "/usr/local/bin/opencode",
    join(homedir(), ".opencode", "bin", "opencode"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Last resort: rely on PATH resolution.
  return process.platform === "win32" ? "opencode.exe" : "opencode"
}

export class OpencodeService {
  private proc: ChildProcess | null = null
  private client: ReturnType<typeof createOpencodeClient> | null = null
  private readonly password = randomBytes(24).toString("hex")
  private readonly baseUrl: string

  constructor(private cfg: GatewayConfig) {
    this.baseUrl = `http://127.0.0.1:${cfg.port}`
  }

  /** Spawn the server (with our own password) and wait until healthy. */
  async start(): Promise<void> {
    const bin = findOpencodeBin(this.cfg.opencodeBin)
    this.proc = spawn(bin, ["serve", "--port", String(this.cfg.port), "--hostname", "127.0.0.1"], {
      cwd: this.cfg.workdir,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_SERVER_USERNAME: "opencode" },
      stdio: "ignore",
      windowsHide: true,
    })
    this.proc.on("exit", (code) => {
      console.error(`[opencode serve] exited with code ${code}`)
      this.proc = null
    })

    const auth = "Basic " + Buffer.from(`opencode:${this.password}`).toString("base64")
    this.client = createOpencodeClient({
      baseUrl: this.baseUrl,
      // Custom fetch that injects basic auth. The SDK passes a single Request.
      fetch: (request: Request) => {
        const headers = new Headers(request.headers)
        headers.set("Authorization", auth)
        return globalThis.fetch(new Request(request, { headers }))
      },
    })

    await this.waitHealthy(auth)
  }

  private async waitHealthy(auth: string, timeoutMs = 20000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await globalThis.fetch(`${this.baseUrl}/global/health`, {
          headers: { Authorization: auth },
        })
        if (res.ok) return
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error("opencode server did not become healthy in time")
  }

  /** Create a new session and return its id. */
  async createSession(title: string): Promise<string> {
    if (!this.client) throw new Error("service not started")
    const res = await this.client.session.create({ body: { title } })
    // SDK returns { data } by default (responseStyle "fields")
    const session = (res as any).data ?? res
    return session.id
  }

  /**
   * Send a prompt to a session with a chosen agent, return the assistant's
   * text reply.
   */
  async prompt(sessionId: string, agent: AgentName, text: string): Promise<string> {
    if (!this.client) throw new Error("service not started")
    const res = await this.client.session.prompt({
      path: { id: sessionId },
      body: { agent, parts: [{ type: "text", text }] },
    })
    const data = (res as any).data ?? res
    const parts = data?.parts ?? []
    const texts = parts
      .filter((p: any) => p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
    return texts.join("\n").trim() || "(no text response)"
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}
