#!/usr/bin/env bash
# MOA installer (macOS/Linux) - makes MOA's agents (dev/chat) and plugins
# (memory, codebase, budget) available globally, so they show up in any
# directory (Tab in the TUI), not just inside this project.
#
# The repo stays the source of truth; this copies into ~/.config/opencode.
# Re-run after changing agents or plugins to sync.
#
# Usage:
#   ./scripts/install.sh
#   ./scripts/install.sh --disable-build
#
# Flags:
#   --disable-build   Also disable opencode's built-in `build` agent (off by
#                     default - MOA does not touch your existing agents unless
#                     you ask). `dev` is MOA's tuned replacement for `build`.

set -euo pipefail

DISABLE_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --disable-build) DISABLE_BUILD=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SRC="$REPO_ROOT/.opencode"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

echo "MOA installer"
echo "  repo : $REPO_ROOT"
echo "  dest : $DEST"
echo

if [ ! -d "$SRC" ]; then
  echo "Source .opencode not found at $SRC. Run from the MOA repo." >&2
  exit 1
fi

mkdir -p "$DEST/agents" "$DEST/plugins"

# 1) Sync agents - warn before overwriting an existing same-named agent.
echo "Syncing agents..."
for f in "$SRC"/agents/*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ -e "$DEST/agents/$name" ]; then
    echo "  ! overwriting existing agents/$name"
  fi
  cp -f "$f" "$DEST/agents/$name"
  echo "  + agents/$name"
done

# 2) Sync plugins (including lib/), clearing stale MOA files first.
echo "Syncing plugins..."
for name in memory.ts codebase.ts budget.ts; do
  rm -f "$DEST/plugins/$name"
done
rm -rf "$DEST/plugins/lib"
cp -R "$SRC"/plugins/* "$DEST/plugins/"
find "$DEST/plugins" -name '*.ts' | while read -r p; do
  echo "  + plugins/${p#"$DEST/plugins/"}"
done

# 2b) Sync skills (one folder per skill). Warn before overwriting a same-named
#     skill; leave unrelated user skills untouched.
if [ -d "$SRC/skills" ]; then
  echo "Syncing skills..."
  mkdir -p "$DEST/skills"
  for d in "$SRC"/skills/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    if [ -e "$DEST/skills/$name" ]; then
      echo "  ! overwriting existing skills/$name"
      rm -rf "$DEST/skills/$name"
    fi
    cp -R "$d" "$DEST/skills/$name"
    echo "  + skills/$name"
  done
fi

# 3) Ensure the plugin dependency is present so plugins can import
#    @opencode-ai/plugin from anywhere.
echo "Ensuring plugin dependency..."
if [ ! -f "$DEST/package.json" ]; then
  printf '{ "dependencies": { "@opencode-ai/plugin": "^1.17.11" } }\n' > "$DEST/package.json"
  echo "  + created package.json"
fi
if [ ! -d "$DEST/node_modules/@opencode-ai/plugin" ]; then
  echo "  installing @opencode-ai/plugin (npm)..."
  ( cd "$DEST" && npm install --silent >/dev/null 2>&1 ) || true
  if [ -d "$DEST/node_modules/@opencode-ai/plugin" ]; then
    echo "  + dependency installed"
  else
    echo "  ! could not confirm dependency install; run 'npm install' in $DEST manually"
  fi
else
  echo "  + dependency already present"
fi

# 4) Merge MOA defaults into the global opencode.json using node (cross-platform,
#    no jq dependency). Preserves existing keys; never overwrites provider/model.
echo "Merging global opencode.json..."
DISABLE_BUILD="$DISABLE_BUILD" CFG="$DEST/opencode.json" node - <<'NODE'
const fs = require("fs");
const path = process.env.CFG;
const disableBuild = process.env.DISABLE_BUILD === "1";

let cfg = {};
if (fs.existsSync(path)) {
  try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch { cfg = {}; }
}
if (!cfg["$schema"]) cfg["$schema"] = "https://opencode.ai/config.json";

if (!("default_agent" in cfg)) {
  cfg.default_agent = "dev";
  console.log("  + default_agent = dev");
} else {
  console.log(`  - default_agent already set to '${cfg.default_agent}' - left as-is`);
}

if (!("permission" in cfg)) {
  cfg.permission = {
    edit: "ask",
    bash: {
      "*": "ask",
      "rm -rf *": "deny",
      "rm -rf /": "deny",
      "sudo *": "deny",
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "ls *": "allow",
      "cat *": "allow",
    },
  };
  console.log("  + hardened permission defaults");
} else {
  console.log("  - permission block already present - left as-is (MOA's hardened defaults NOT applied)");
}

if (disableBuild) {
  cfg.agent = cfg.agent || {};
  cfg.agent.build = cfg.agent.build || {};
  cfg.agent.build.disable = true;
  console.log("  + disabled built-in 'build' agent (requested)");
} else {
  console.log("  - left 'build' agent enabled (use --disable-build to disable it)");
}

// Add MOA's default MCP servers (only if not already present).
const moaMcp = {
  context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
  gh_grep:  { type: "remote", url: "https://mcp.grep.app",         enabled: true },
};
cfg.mcp = cfg.mcp || {};
for (const name of Object.keys(moaMcp)) {
  if (!(name in cfg.mcp)) {
    cfg.mcp[name] = moaMcp[name];
    console.log(`  + mcp server '${name}'`);
  } else {
    console.log(`  - mcp server '${name}' already present - left as-is`);
  }
}

fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log("  wrote " + path);
NODE

echo
echo "Done. MOA is installed globally."
echo "Open 'opencode' from any directory and press Tab to switch between dev / chat."
if [ "$DISABLE_BUILD" != "1" ]; then
  echo "Tip: re-run with --disable-build to hide the built-in 'build' agent."
fi
