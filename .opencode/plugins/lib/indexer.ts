import { join, extname, relative, sep } from "node:path"
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs"
import type { Chunk } from "./codebase-store"

// Hard cap on files discovered in a single index run, so a non-project
// directory can never trigger a runaway filesystem walk.
const MAX_FILES = 5000

// Markers that indicate a directory is an actual project worth indexing.
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  ".opencode",
]

/**
 * Whether `dir` looks like a project root. Codebase RAG should only auto-index
 * real projects — never an arbitrary directory like HOME or a temp folder,
 * where a walk could be enormous and meaningless.
 */
export function isProjectRoot(dir: string): boolean {
  for (const m of PROJECT_MARKERS) {
    if (existsSync(join(dir, m))) return true
  }
  return false
}

/**
 * File discovery + chunking for codebase indexing.
 *
 * Discovery prefers `git ls-files` (respects .gitignore, fast) and falls back
 * to a filtered directory walk when git isn't available. Binary, huge, and
 * dependency/build files are skipped.
 *
 * Chunking is line-window based (default ~60 lines, 10-line overlap) so search
 * hits map back to concrete line ranges the agent can open.
 */

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".moa",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
])

// Extensions worth indexing as text/code. Kept broad but bounded.
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".php", ".scala", ".clj", ".ex", ".exs", ".dart", ".lua",
  ".sh", ".ps1", ".sql",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env.example",
  ".md", ".mdx", ".txt", ".html", ".css", ".scss", ".astro", ".vue", ".svelte",
])

const MAX_FILE_BYTES = 512 * 1024 // 512 KB per file cap

export function shouldIndex(path: string): boolean {
  const ext = extname(path).toLowerCase()
  if (TEXT_EXT.has(ext)) return true
  // a few extensionless config files worth indexing
  const base = path.split(/[\\/]/).pop() ?? ""
  return ["Dockerfile", "Makefile", ".gitignore"].includes(base)
}

/** Discover candidate files via git, falling back to a filtered walk. */
export async function discoverFiles(
  projectDir: string,
  $: any,
): Promise<string[]> {
  // Try git first (respects .gitignore).
  try {
    const res = await $`git -C ${projectDir} ls-files`.quiet()
    const text = typeof res === "string" ? res : res?.stdout?.toString?.() ?? ""
    const files = text
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(Boolean)
    if (files.length) {
      return files.filter(shouldIndex)
    }
  } catch {
    // git not available or not a repo — fall back to walk
  }
  return walk(projectDir, projectDir)
}

function walk(root: string, dir: string, acc: string[] = []): string[] {
  if (acc.length >= MAX_FILES) return acc
  let entries: any[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      walk(root, full, acc)
    } else if (e.isFile()) {
      const rel = relative(root, full).split(sep).join("/")
      if (shouldIndex(rel)) acc.push(rel)
    }
  }
  return acc
}

/** Read a file and split it into overlapping line-range chunks. */
export function chunkFile(
  projectDir: string,
  relPath: string,
  windowLines = 60,
  overlap = 10,
): Chunk[] {
  const abs = join(projectDir, relPath)
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return []
  } catch {
    return []
  }

  let raw: string
  try {
    raw = readFileSync(abs, "utf8")
  } catch {
    return []
  }
  // crude binary guard: NUL byte present
  if (raw.includes("\u0000")) return []

  const lines = raw.split(/\r?\n/)
  if (lines.length === 0) return []

  const chunks: Chunk[] = []
  const step = Math.max(1, windowLines - overlap)
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines)
    const content = lines.slice(start, end).join("\n").trim()
    if (content.length > 0) {
      chunks.push({
        path: relPath,
        startLine: start + 1,
        endLine: end,
        content,
      })
    }
    if (end >= lines.length) break
  }
  return chunks
}
