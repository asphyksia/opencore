import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, readFileSync, existsSync, renameSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  embedDocuments,
  embedQuery,
  embeddingsConfigured,
  embeddingModelId,
} from "./embeddings"
import { rankBySimilarity, reciprocalRankFusion } from "./hybrid"

/**
 * SQLite + FTS5 storage layer for opencore long-term memory, with optional hybrid
 * (keyword + semantic) search.
 *
 * Runs under Bun (opencode's plugin runtime), using the built-in `bun:sqlite`
 * with FTS5 - no native build step, no external dependency.
 *
 * - `facts` table holds canonical rows; `facts_fts` mirrors searchable text
 *   (BM25). A `vectors` table holds per-fact embeddings (Float32 BLOB) plus the
 *   content hash and embedding model id, so we only re-embed when content or
 *   model changes.
 * - searchFacts fuses BM25 + cosine ranking via RRF. If embeddings are not
 *   configured (or unavailable), it transparently falls back to BM25 only.
 */

export type Fact = {
  id: string
  text: string
  type: string
  importance: number
  createdAt: string
  source?: string
}

const dir = join(homedir(), ".opencore", "memory")
const dbPath = join(dir, "memory.db")
const legacyJsonl = join(dir, "long-term.jsonl")

type DB = any

let dbPromise: Promise<DB> | null = null

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

function fromBlob(buf: Buffer | Uint8Array | null): number[] | null {
  if (!buf) return null
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const f = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))
  return Array.from(f)
}

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

  // Per-fact embeddings. `hash` = sha256(text), `model` = embedding model id.
  db.run(`
    CREATE TABLE IF NOT EXISTS vectors (
      fact_id TEXT PRIMARY KEY,
      hash    TEXT NOT NULL,
      model   TEXT NOT NULL,
      dim     INTEGER NOT NULL,
      vec     BLOB NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    )
  `)

  migrateLegacyJsonl(db)
  return db
}

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
    renameSync(legacyJsonl, legacyJsonl + ".migrated")
  } catch {
    /* best-effort */
  }
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

export async function addFact(fact: Fact): Promise<void> {
  const d = await db()
  d.prepare(
    "INSERT OR REPLACE INTO facts (id, text, type, importance, createdAt, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(fact.id, fact.text, fact.type, fact.importance, fact.createdAt, fact.source ?? null)
  // Embed in the background; never block or throw on embedding failure.
  void embedFact(fact.id, fact.text).catch(() => {})
  // Regenerate that day's export file so it stays in sync with the DB.
  void exportDayMarkdown(fact.createdAt).catch(() => {})
}

export async function updateFact(id: string, text: string, importance: number): Promise<void> {
  const d = await db()
  const before = d.query("SELECT createdAt FROM facts WHERE id = ?").get(id) as
    | { createdAt: string }
    | undefined
  d.prepare("UPDATE facts SET text = ?, importance = ? WHERE id = ?").run(text, importance, id)
  // Re-embed with new text
  void embedFact(id, text).catch(() => {})
  // Regenerate the day's export (use the fact's original createdAt, fallback to now).
  const stamp = before?.createdAt ?? new Date().toISOString()
  void exportDayMarkdown(stamp).catch(() => {})
}

export async function deleteFact(id: string): Promise<void> {
  const d = await db()
  const before = d.query("SELECT createdAt FROM facts WHERE id = ?").get(id) as
    | { createdAt: string }
    | undefined
  d.prepare("DELETE FROM facts WHERE id = ?").run(id)
  // Regenerate the day's export (in case that was the last fact for the day).
  const stamp = before?.createdAt ?? new Date().toISOString()
  void exportDayMarkdown(stamp).catch(() => {})
}

/** Embed one fact if embeddings are configured and content/model changed. */
async function embedFact(id: string, text: string): Promise<void> {
  if (!embeddingsConfigured()) return
  const d = await db()
  const hash = contentHash(text)
  const model = embeddingModelId()
  const existing = d.query("SELECT hash, model FROM vectors WHERE fact_id = ?").get(id) as
    | { hash: string; model: string }
    | undefined
  if (existing && existing.hash === hash && existing.model === model) return
  const vecs = await embedDocuments([text])
  const vec = vecs?.[0]
  if (!vec || vec.length === 0) return
  d.prepare(
    "INSERT OR REPLACE INTO vectors (fact_id, hash, model, dim, vec) VALUES (?, ?, ?, ?, ?)",
  ).run(id, hash, model, vec.length, toBlob(vec))
}

/** Embed any facts that don't yet have an up-to-date vector. Returns count. */
export async function backfillEmbeddings(limit = 500): Promise<number> {
  if (!embeddingsConfigured()) return 0
  const d = await db()
  const model = embeddingModelId()
  const rows = d
    .query(
      `SELECT f.id AS id, f.text AS text
       FROM facts f
       LEFT JOIN vectors v ON v.fact_id = f.id
       WHERE v.fact_id IS NULL OR v.model != ?
       LIMIT ?`,
    )
    .all(model, limit) as Array<{ id: string; text: string }>
  let n = 0
  for (const r of rows) {
    await embedFact(r.id, r.text)
    n++
  }
  return n
}

function bm25Search(d: DB, query: string, limit: number): Fact[] {
  const expr = toMatchExpr(query)
  if (!expr) return []
  return d
    .query(
      `SELECT f.id, f.text, f.type, f.importance, f.createdAt, f.source
       FROM facts_fts
       JOIN facts f ON f.rowid = facts_fts.rowid
       WHERE facts_fts MATCH ?
       ORDER BY (bm25(facts_fts) - f.importance) ASC
       LIMIT ?`,
    )
    .all(expr, limit) as Fact[]
}

/**
 * Hybrid search: fuse BM25 + semantic (cosine) rankings via RRF. Falls back to
 * BM25 alone when embeddings are unavailable.
 */
export async function searchFacts(query: string, limit = 5): Promise<Fact[]> {
  const d = await db()

  // Keyword candidates (a wider pool so fusion has room to rerank).
  const pool = Math.max(limit * 4, 20)
  const bm25 = bm25Search(d, query, pool)

  // Semantic ranking (only if embeddings configured + query embeds).
  let semanticIds: string[] = []
  if (embeddingsConfigured()) {
    const qvec = await embedQuery(query)
    if (qvec) {
      const rows = d
        .query("SELECT fact_id, vec FROM vectors")
        .all() as Array<{ fact_id: string; vec: Uint8Array }>
      if (rows.length > 0) {
        const ids = rows.map((r) => r.fact_id)
        const vecs = rows.map((r) => fromBlob(r.vec))
        const ranked = rankBySimilarity(qvec, vecs, pool)
        semanticIds = ranked.map((i) => ids[i])
      }
    }
  }

  // If no semantic signal, return BM25 as before.
  if (semanticIds.length === 0) {
    if (bm25.length > 0) return bm25.slice(0, limit)
    return topByImportance(limit)
  }

  // Fuse rankings (RRF) and resolve back to facts.
  const bm25Ids = bm25.map((f) => f.id)
  const fusedIds = reciprocalRankFusion([bm25Ids, semanticIds], 60, limit)
  return resolveFacts(d, fusedIds)
}

function resolveFacts(d: DB, ids: string[]): Fact[] {
  if (ids.length === 0) return []
  const out: Fact[] = []
  const stmt = d.prepare(
    "SELECT id, text, type, importance, createdAt, source FROM facts WHERE id = ?",
  )
  for (const id of ids) {
    const row = stmt.get(id) as Fact | undefined
    if (row) out.push(row)
  }
  return out
}

export async function topByImportance(limit = 5): Promise<Fact[]> {
  const d = await db()
  return d
    .query(
      "SELECT id, text, type, importance, createdAt, source FROM facts ORDER BY importance DESC, createdAt DESC LIMIT ?",
    )
    .all(limit) as Fact[]
}

export async function countFacts(): Promise<number> {
  const d = await db()
  const row = d.query("SELECT COUNT(*) AS n FROM facts").get() as { n: number }
  return row?.n ?? 0
}

// ─── Daily Markdown exports ───────────────────────────────────────────
//
// Each day's facts are also written to ~/.opencore/memory/exports/YYYY-MM-DD.md
// as a human-readable, grep-friendly file. The DB is the source of truth;
// the .md is regenerated on every add/update/delete of a fact for that day.
// One file per day, no accumulation of stale files.

import { join as _join } from "node:path"
import { mkdirSync as _mkdirSync, writeFileSync as _writeFileSync, unlinkSync as _unlinkSync } from "node:fs"

const exportsDir = _join(dir, "exports")

function dayKey(iso: string): string {
  // Accepts either a full ISO timestamp or a YYYY-MM-DD string. Returns YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  return iso.slice(0, 10)
}

function timeOnly(iso: string): string {
  // "2026-06-29T14:32:11.000Z" -> "14:32"
  const t = iso.slice(11, 16)
  return t || "??:??"
}

function factDay(f: Fact): string {
  return dayKey(f.createdAt)
}

function fmtFactLine(f: Fact): string {
  return `- ${f.text} *(${f.type}, importance ${f.importance.toFixed(2)}, ${timeOnly(f.createdAt)})*`
}

/** Regenerate the .md file for the day that contains `createdAt`. */
export async function exportDayMarkdown(createdAt: string): Promise<void> {
  const key = dayKey(createdAt)
  const d = await db()
  const facts = d
    .query(
      "SELECT id, text, type, importance, createdAt, source FROM facts " +
        "WHERE substr(createdAt, 1, 10) = ? " +
        "ORDER BY type ASC, importance DESC, createdAt ASC",
    )
    .all(key) as Fact[]

  _mkdirSync(exportsDir, { recursive: true })
  const path = _join(exportsDir, `${key}.md`)

  if (facts.length === 0) {
    // No facts for that day: remove the file if it exists, otherwise no-op.
    try {
      _unlinkSync(path)
    } catch {
      /* file may not exist */
    }
    return
  }

  // Group by type for readability
  const byType = new Map<string, Fact[]>()
  for (const f of facts) {
    if (!byType.has(f.type)) byType.set(f.type, [])
    byType.get(f.type)!.push(f)
  }

  // Stable type order (matching the canonical list), then any extras alphabetically
  const typeOrder = ["identity", "preference", "goal", "project", "decision", "note"]
  const orderedTypes = [
    ...typeOrder.filter((t) => byType.has(t)),
    ...[...byType.keys()].filter((t) => !typeOrder.includes(t)).sort(),
  ]

  const lines: string[] = []
  lines.push(`# Memory — ${key}`)
  lines.push("")
  lines.push(`*Auto-generated from memory.db. Do not edit; source of truth is the database.*`)
  lines.push("")
  lines.push(`Total: ${facts.length} fact(s)`)
  lines.push("")

  for (const t of orderedTypes) {
    const group = byType.get(t)!
    const cap = t.charAt(0).toUpperCase() + t.slice(1) + "s"
    lines.push(`## ${cap} (${group.length})`)
    lines.push("")
    for (const f of group) lines.push(fmtFactLine(f))
    lines.push("")
  }

  _writeFileSync(path, lines.join("\n"), "utf8")
}

/** Regenerate all day's exports. Useful for one-time backfill or after a schema change. */
export async function exportAllDays(): Promise<number> {
  const d = await db()
  const rows = d
    .query("SELECT DISTINCT substr(createdAt, 1, 10) AS day FROM facts ORDER BY day ASC")
    .all() as Array<{ day: string }>
  for (const { day } of rows) {
    await exportDayMarkdown(day)
  }
  return rows.length
}

/** Return the list of days that have export files on disk. */
export async function exportedDays(): Promise<string[]> {
  try {
    const { readdirSync } = await import("node:fs")
    return readdirSync(exportsDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ""))
      .sort()
  } catch {
    return []
  }
}
