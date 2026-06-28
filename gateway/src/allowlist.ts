import { join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { stateDir } from "./config.js"

/**
 * Pairing + allowlist store.
 *
 * Security model (inspired by Mercury):
 * - On first run, the gateway prints a one-time pairing code to its console
 *   (visible only to whoever controls this machine).
 * - A Telegram user sends `/pair <code>`. If it matches, they are added to the
 *   allowlist as the admin.
 * - Everyone else is rejected unless an admin approves them (future: /approve).
 * - Only allowlisted users can interact with the agent at all.
 *
 * State persists to ~/.moa/gateway/allowlist.json so pairing survives restarts.
 */

interface StoreData {
  pairingCode: string | null
  admins: number[] // Telegram user IDs
  members: number[] // Telegram user IDs (approved, non-admin)
}

const file = join(stateDir, "allowlist.json")

function load(): StoreData {
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      return {
        pairingCode: parsed.pairingCode ?? null,
        admins: Array.isArray(parsed.admins) ? parsed.admins : [],
        members: Array.isArray(parsed.members) ? parsed.members : [],
      }
    }
  } catch {
    // fall through to fresh state
  }
  return { pairingCode: null, admins: [], members: [] }
}

function save(data: StoreData): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
}

export class Allowlist {
  private data: StoreData

  constructor() {
    this.data = load()
  }

  /** True if anyone has paired yet (i.e. there is at least one admin). */
  get hasAdmin(): boolean {
    return this.data.admins.length > 0
  }

  /** Generate (or reuse) a one-time pairing code shown on the server console. */
  ensurePairingCode(): string {
    if (!this.data.pairingCode) {
      this.data.pairingCode = randomBytes(4).toString("hex") // 8 hex chars
      save(this.data)
    }
    return this.data.pairingCode
  }

  isAuthorized(userId: number): boolean {
    return this.data.admins.includes(userId) || this.data.members.includes(userId)
  }

  isAdmin(userId: number): boolean {
    return this.data.admins.includes(userId)
  }

  /**
   * Attempt to pair a user with a code. Returns the outcome.
   * The first successful pairing makes the user an admin and consumes the code.
   */
  tryPair(userId: number, code: string): "ok" | "bad-code" | "already" {
    if (this.isAuthorized(userId)) return "already"
    if (!this.data.pairingCode || code !== this.data.pairingCode) return "bad-code"
    this.data.admins.push(userId)
    this.data.pairingCode = null // consume the code
    save(this.data)
    return "ok"
  }

  /** Admin approves a pending member. */
  addMember(userId: number): void {
    if (!this.data.members.includes(userId) && !this.data.admins.includes(userId)) {
      this.data.members.push(userId)
      save(this.data)
    }
  }

  /** Remove a user from all access. */
  revoke(userId: number): void {
    this.data.admins = this.data.admins.filter((id) => id !== userId)
    this.data.members = this.data.members.filter((id) => id !== userId)
    save(this.data)
  }

  list(): { admins: number[]; members: number[] } {
    return { admins: [...this.data.admins], members: [...this.data.members] }
  }
}
