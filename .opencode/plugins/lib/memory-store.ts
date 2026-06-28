import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, readFileSync, existsSync, renameSync } from "node:fs"

/**
 * SQLite + FTS5 storage layer for MOA long-term memory.
 *
 * Runs under Bun (opencode's plugin runtime), using the built-in `bun:sqlite`
 * with FTS5 — no native build step, no external dependency.
 *
 * A `facts` table holds the canonical rows; an FTS5 virtual table `facts_fts`
 * mirrors the searchable text and is kept in sync via triggers. Search uses
 * BM25 ranking, blended with the fact's `importance`.
 */

export type Fact = {
  id: string
  text: string
  type: string
  importance: number
  createdAt: string
  source?: string
}

const dir = join(homedir(), ".moa", "memory")
const dbPath = join(dir, "memory.db")
const legacyJsonl = join(dir, "long-term.jsonl")

type DB = any

let dbPromise: Promise<DB> | null = null

async function openDb(): Promise<DB> {
  mkdirSync(dir, { recursive: true })
  const { Database } = (await import("bun:sqlite")) as any
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  db.run(`
    CREATE TABLE IF NOT EXISTS facts (
      id         TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      type       TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      createdAt  TEXT NOT NULL,
      source     TEXT
    )
  `)

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
    USING fts5(text, type, content='facts', content_rowid='rowid')
  `)

  // Keep the FTS index in sync with the facts table.
  db.run(`
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, type) VALUES (new.rowid, new.text, new.type);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, type) VALUES ('delete', old.rowid, old.text, old.type);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, type) VALUES ('delete', old.rowid, old.text, old.type);
      INSERT INTO facts_fts(rowid, text, type) VALUES (new.rowid, new.text, new.type);
    END
  `)

  migrateLegacyJsonl(db)
  return db
}

/** One-time import of facts from the V1 JSONL store, then archive the file. */
function migrateLegacyJsonl(db: DB) {
  if (!existsSync(legacyJsonl)) return
  try {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO facts (id, text, type, importance, createdAt, source) VALUES (?, ?, ?, ?, ?, ?)",
    )
    const tx = db.transaction((rows: Fact[]) => {
      for (const f of rows) {
        insert.run(f.id, f.text, f.type, f.importance, f.createdAt, f.source ?? null)
      }
    })
    const rows: Fact[] = []
    for (const line of readFileSync(legacyJsonl, "utf8").split("\n")) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t)
        if (o && o.id && o.text) {
          rows.push({
            id: String(o.id),
            text: String(o.text),
            type: String(o.type ?? "note"),
            importance: typeof o.importance === "number" ? o.importance : 0.5,
            createdAt: String(o.createdAt ?? new Date().toISOString()),
            source: o.source,
          })
        }
      } catch {
        /* skip corrupt line */
      }
    }
    if (rows.length) tx(rows)
    // archive so we don't re-import on next boot
    renameSync(legacyJsonl, legacyJsonl + ".migrated")
  } catch {
    /* best-effort migration; never block startup */
  }
}

function db(): Promise<DB> {
  if (!dbPromise) dbPromise = openDb()
  return dbPromise
}

/** Escape a user query into a safe FTS5 MATCH expression (prefix-OR of terms). */
function toMatchExpr(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
  return terms.join(" OR ")
}

export async function addFact(fact: Fact): Promise<void> {
  const d = await db()
  d.prepare(
    "INSERT OR REPLACE INTO facts (id, text, type, importance, createdAt, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(fact.id, fact.text, fact.type, fact.importance, fact.createdAt, fact.source ?? null)
}

export async function searchFacts(query: string, limit = 5): Promise<Fact[]> {
  const d = await db()
  const expr = toMatchExpr(query)
  if (!expr) return topByImportance(limit)
  // bm25() returns lower = better; blend with importance (higher = better).
  const rows = d
    .query(
      `
      SELECT f.id, f.text, f.type, f.importance, f.createdAt, f.source
      FROM facts_fts
      JOIN facts f ON f.rowid = facts_fts.rowid
      WHERE facts_fts MATCH ?
      ORDER BY (bm25(facts_fts) - f.importance) ASC
      LIMIT ?
      `,
    )
    .all(expr, limit)
  return rows as Fact[]
}

export async function topByImportance(limit = 5): Promise<Fact[]> {
  const d = await db()
  const rows = d
    .query(
      "SELECT id, text, type, importance, createdAt, source FROM facts ORDER BY importance DESC, createdAt DESC LIMIT ?",
    )
    .all(limit)
  return rows as Fact[]
}

export async function countFacts(): Promise<number> {
  const d = await db()
  const row = d.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }
  return row?.n ?? 0
}
