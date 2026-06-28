# MOA installer - makes MOA's agents (dev/chat) and plugins (memory, codebase,
# budget) available globally, so they show up in any directory (Tab in the TUI),
# not just inside this project.
#
# The repo stays the source of truth; this copies into ~/.config/opencode.
# Re-run after changing agents or plugins to sync.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DisableBuild
#
# Flags:
#   -DisableBuild   Also disable opencode's built-in `build` agent (off by
#                   default - MOA does not touch your existing agents unless
#                   you ask). `dev` is MOA's tuned replacement for `build`.

param(
  [switch]$DisableBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot ".opencode"
$dest = Join-Path $HOME ".config\opencode"

Write-Host "MOA installer"
Write-Host "  repo : $repoRoot"
Write-Host "  dest : $dest"
Write-Host ""

if (-not (Test-Path $src)) {
  throw "Source .opencode not found at $src. Run from the MOA repo."
}

# Ensure destination dirs exist.
New-Item -ItemType Directory -Force -Path $dest | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest "agents") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dest "plugins") | Out-Null

# 1) Sync agents (dev.md, chat.md) - warn before overwriting an existing agent
#    of the same name that we didn't install.
Write-Host "Syncing agents..."
$destAgents = Join-Path $dest "agents"
Get-ChildItem (Join-Path $src "agents") -Filter *.md | ForEach-Object {
  $target = Join-Path $destAgents $_.Name
  if (Test-Path $target) {
    Write-Host "  ! overwriting existing agents\$($_.Name)" -ForegroundColor Yellow
  }
  Copy-Item -Path $_.FullName -Destination $target -Force
  Write-Host "  + agents\$($_.Name)"
}

# 2) Sync plugins (including lib/).
Write-Host "Syncing plugins..."
$destPlugins = Join-Path $dest "plugins"
# Remove previously-synced MOA plugin files to avoid stale leftovers, but leave
# any unrelated user plugins untouched.
foreach ($name in @("memory.ts", "codebase.ts", "budget.ts")) {
  $p = Join-Path $destPlugins $name
  if (Test-Path $p) { Remove-Item $p -Force }
}
if (Test-Path (Join-Path $destPlugins "lib")) {
  Remove-Item (Join-Path $destPlugins "lib") -Recurse -Force
}
Copy-Item -Path (Join-Path $src "plugins\*") -Destination $destPlugins -Recurse -Force
Get-ChildItem $destPlugins -Recurse -Filter *.ts | ForEach-Object {
  $rel = $_.FullName.Substring($destPlugins.Length + 1)
  Write-Host "  + plugins\$rel"
}

# 3) Ensure the plugin dependency is present in the global config dir, so the
#    plugins can import `@opencode-ai/plugin` from anywhere.
Write-Host "Ensuring plugin dependency..."
$destPkg = Join-Path $dest "package.json"
if (-not (Test-Path $destPkg)) {
  '{ "dependencies": { "@opencode-ai/plugin": "^1.17.11" } }' | Set-Content $destPkg -Encoding utf8
  Write-Host "  + created package.json"
}
if (-not (Test-Path (Join-Path $dest "node_modules\@opencode-ai\plugin"))) {
  Write-Host "  installing @opencode-ai/plugin (npm)..."
  Push-Location $dest
  try {
    & npm install --silent 2>&1 | Out-Null
    if (Test-Path (Join-Path $dest "node_modules\@opencode-ai\plugin")) {
      Write-Host "  + dependency installed"
    } else {
      Write-Host "  ! could not confirm dependency install; run 'npm install' in $dest manually" -ForegroundColor Yellow
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "  + dependency already present"
}

# 4) Merge MOA defaults into the global opencode.json, preserving existing keys
#    (e.g. your provider config). Only fills in agent defaults / permissions if
#    absent, and NEVER overwrites your provider/model.
Write-Host "Merging global opencode.json..."
$globalCfgPath = Join-Path $dest "opencode.json"

# Recursively convert PSCustomObject (from ConvertFrom-Json) into ordered
# hashtables, so we can mutate reliably on Windows PowerShell 5.1 (which lacks
# ConvertFrom-Json -AsHashtable).
function ConvertTo-HashtableDeep($obj) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Management.Automation.PSCustomObject]) {
    $h = [ordered]@{}
    foreach ($p in $obj.PSObject.Properties) {
      $h[$p.Name] = ConvertTo-HashtableDeep $p.Value
    }
    return $h
  }
  if ($obj -is [System.Collections.IEnumerable] -and $obj -isnot [string]) {
    return @($obj | ForEach-Object { ConvertTo-HashtableDeep $_ })
  }
  return $obj
}

if (Test-Path $globalCfgPath) {
  $cfg = ConvertTo-HashtableDeep (Get-Content $globalCfgPath -Raw | ConvertFrom-Json)
} else {
  $cfg = [ordered]@{ '$schema' = "https://opencode.ai/config.json" }
}
if (-not $cfg) { $cfg = [ordered]@{} }

# Ensure default_agent is set to dev unless the user already chose one.
if (-not $cfg.Contains("default_agent")) {
  $cfg["default_agent"] = "dev"
  Write-Host "  + default_agent = dev"
} else {
  Write-Host "  - default_agent already set to '$($cfg["default_agent"])' - left as-is" -ForegroundColor Yellow
}

# Ensure hardened permissions exist (don't clobber if user already customized).
if (-not $cfg.Contains("permission")) {
  $cfg["permission"] = [ordered]@{
    edit = "ask"
    bash = [ordered]@{
      "*"           = "ask"
      "rm -rf *"    = "deny"
      "rm -rf /"    = "deny"
      "sudo *"      = "deny"
      "git status*" = "allow"
      "git diff*"   = "allow"
      "git log*"    = "allow"
      "ls *"        = "allow"
      "cat *"       = "allow"
    }
  }
  Write-Host "  + hardened permission defaults"
} else {
  Write-Host "  - permission block already present - left as-is (MOA's hardened defaults NOT applied)" -ForegroundColor Yellow
}

# Optionally disable the built-in `build` agent (opt-in). `dev` is MOA's tuned
# replacement, but we don't touch the user's agents unless asked.
if ($DisableBuild) {
  if (-not $cfg.Contains("agent")) { $cfg["agent"] = [ordered]@{} }
  if (-not $cfg["agent"].Contains("build")) { $cfg["agent"]["build"] = [ordered]@{} }
  $cfg["agent"]["build"]["disable"] = $true
  Write-Host "  + disabled built-in 'build' agent (requested)"
} else {
  Write-Host "  - left 'build' agent enabled (use -DisableBuild to disable it)"
}

# Add MOA's default MCP servers (only if a server of that name isn't already
# present). These are remote, no-auth, coding-focused servers.
$moaMcp = [ordered]@{
  context7 = [ordered]@{ type = "remote"; url = "https://mcp.context7.com/mcp"; enabled = $true }
  gh_grep  = [ordered]@{ type = "remote"; url = "https://mcp.grep.app";         enabled = $true }
}
if (-not $cfg.Contains("mcp")) { $cfg["mcp"] = [ordered]@{} }
foreach ($name in $moaMcp.Keys) {
  if (-not $cfg["mcp"].Contains($name)) {
    $cfg["mcp"][$name] = $moaMcp[$name]
    Write-Host "  + mcp server '$name'"
  } else {
    Write-Host "  - mcp server '$name' already present - left as-is"
  }
}

$cfg | ConvertTo-Json -Depth 20 | Set-Content $globalCfgPath -Encoding utf8
Write-Host "  wrote $globalCfgPath"

Write-Host ""
Write-Host "Done. MOA is installed globally."
Write-Host "Open 'opencode' from any directory and press Tab to switch between dev / chat."
if (-not $DisableBuild) {
  Write-Host "Tip: re-run with -DisableBuild to hide the built-in 'build' agent."
}
