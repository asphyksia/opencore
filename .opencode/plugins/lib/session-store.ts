import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

/**
 * SQLite + FTS5 store for cross-session search (long-term conversation recall).
 *
 * opencore maintains its OWN session index (not opencode's internal DB) so it
 * stays independent of opencode's private schema. Messages are indexed on
 * `session.idle` by pulling the full message list via the SDK.
 *
 * - `sessions` holds session metadata (id, title, timestamps).
 * - `messages` holds per-message rows (id, session, role, text, created).
 * - `messages_fts` mirrors message text for BM25 full-text search.
 *
 * Three query modes power the session_search tool:
 *   - discover(query)         : FTS5 search, returns hits with context windows
 *   - messagesAround(id, n)   : scroll a window around a message
 *   - recentSessions(limit)   : browse recent sessions chronologically
 *
 * Runs on Bun's built-in `bun:sqlite` (FTS5 available, no native build step).
 */

export type SessionMeta = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export type StoredMessage = {
  id: string
  sessionId: string
  role: string
  text: string
  createdAt: number
}

export type SearchHit = {
  sessionId: string
  sessionTitle: string
  messageId: string
  role: string
  snippet: string
  createdAt: number
}

const dir = join(homedir(), ".opencore", "sessions")
const dbPath = join(dir, "sessions.db")

type DB = any

let dbPromise: Promise<DB> | null = null

async function openDb(): Promise<DB> {
  mkdirSync(dir, { recursive: true })
  const { Database } = (await import("bun:sqlite")) as any
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id        TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      role      TEXT NOT NULL,
      text      TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, createdAt)`)

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(text, content='messages', content_rowid='rowid')
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END
  `)

  return db
}

function db(): Promise<DB> {
  if (!dbPromise) dbPromise = openDb()
  return dbPromise
}

function toMatchExpr(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
  return terms.join(" OR ")
}

/** Upsert a session's metadata. */
export async function upsertSession(meta: SessionMeta): Promise<void> {
  const d = await db()
  d.prepare(
    `INSERT INTO sessions (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updatedAt = excluded.updatedAt`,
  ).run(meta.id, meta.title, meta.createdAt, meta.updatedAt)
}

/** Insert a batch of messages, ignoring ones already stored (by id). */
export async function indexMessages(messages: StoredMessage[]): Promise<number> {
  if (messages.length === 0) return 0
  const d = await db()
  const insert = d.prepare(
    `INSERT OR IGNORE INTO messages (id, sessionId, role, text, createdAt)
     VALUES (?, ?, ?, ?, ?)`,
  )
  let inserted = 0
  const tx = d.transaction((rows: StoredMessage[]) => {
    for (const m of rows) {
      const res = insert.run(m.id, m.sessionId, m.role, m.text, m.createdAt)
      if (res?.changes) inserted += res.changes
    }
  })
  tx(messages)
  return inserted
}

/** Return the set of message ids already indexed for a session. */
export async function indexedMessageIds(sessionId: string): Promise<Set<string>> {
  const d = await db()
  const rows = d
    .query("SELECT id FROM messages WHERE sessionId = ?")
    .all(sessionId) as Array<{ id: string }>
  return new Set(rows.map((r) => r.id))
}

/**
 * DISCOVERY mode: full-text search across all sessions. Returns the top hits,
 * each with a short snippet. Excludes a given session (usually the current one)
 * so search surfaces *past* conversations.
 */
export async function discover(
  query: string,
  limit = 8,
  excludeSessionId?: string,
): Promise<SearchHit[]> {
  const d = await db()
  const expr = toMatchExpr(query)
  if (!expr) return []

  const rows = d
    .query(
      `SELECT m.id AS messageId, m.sessionId AS sessionId, m.role AS role,
              m.createdAt AS createdAt,
              snippet(messages_fts, 0, '[', ']', ' … ', 12) AS snippet,
              s.title AS sessionTitle
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       JOIN sessions s ON s.id = m.sessionId
       WHERE messages_fts MATCH ?
         AND (? IS NULL OR m.sessionId != ?)
       ORDER BY bm25(messages_fts) ASC
       LIMIT ?`,
    )
    .all(expr, excludeSessionId ?? null, excludeSessionId ?? null, limit) as SearchHit[]

  return rows
}

/**
 * SCROLL mode: return a window of messages around an anchor message in a
 * session, ordered chronologically.
 */
export async function messagesAround(
  sessionId: string,
  anchorMessageId: string,
  window = 5,
): Promise<StoredMessage[]> {
  const d = await db()
  const anchor = d
    .query("SELECT createdAt FROM messages WHERE id = ? AND sessionId = ?")
    .get(anchorMessageId, sessionId) as { createdAt: number } | undefined
  if (!anchor) return []

  const before = d
    .query(
      `SELECT id, sessionId, role, text, createdAt FROM messages
       WHERE sessionId = ? AND createdAt <= ?
       ORDER BY createdAt DESC LIMIT ?`,
    )
    .all(sessionId, anchor.createdAt, window + 1) as StoredMessage[]

  const after = d
    .query(
      `SELECT id, sessionId, role, text, createdAt FROM messages
       WHERE sessionId = ? AND createdAt > ?
       ORDER BY createdAt ASC LIMIT ?`,
    )
    .all(sessionId, anchor.createdAt, window) as StoredMessage[]

  return [...before.reverse(), ...after]
}

/** BROWSE mode: list recent sessions chronologically (newest first). */
export async function recentSessions(limit = 10): Promise<SessionMeta[]> {
  const d = await db()
  return d
    .query("SELECT id, title, createdAt, updatedAt FROM sessions ORDER BY updatedAt DESC LIMIT ?")
    .all(limit) as SessionMeta[]
}

/** Total indexed message count (for diagnostics). */
export async function countMessages(): Promise<number> {
  const d = await db()
  const row = d.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
  return row?.n ?? 0
}
