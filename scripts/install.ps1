# MOA installer — makes MOA's agents (dev/chat) and plugins (memory, codebase,
# budget) available globally, so they show up in any directory (Tab in the TUI),
# not just inside this project.
#
# The repo stays the source of truth; this copies into ~/.config/opencode.
# Re-run after changing agents or plugins to sync.
#
# Usage:   powershell -ExecutionPolicy Bypass -File scripts\install.ps1

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

# 1) Sync agents (dev.md, chat.md).
Write-Host "Syncing agents..."
Copy-Item -Path (Join-Path $src "agents\*") -Destination (Join-Path $dest "agents") -Recurse -Force
Get-ChildItem (Join-Path $dest "agents") -Filter *.md | ForEach-Object { Write-Host "  + agents\$($_.Name)" }

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

# 3) Merge MOA defaults into the global opencode.json, preserving existing keys
#    (e.g. your provider config). Only fills in agent defaults / permissions if
#    absent, never overwrites your provider/model.
Write-Host "Merging global opencode.json..."
$globalCfgPath = Join-Path $dest "opencode.json"
if (Test-Path $globalCfgPath) {
  $cfg = Get-Content $globalCfgPath -Raw | ConvertFrom-Json
} else {
  $cfg = [PSCustomObject]@{ '$schema' = "https://opencode.ai/config.json" }
}

# Ensure default_agent is set to dev unless the user already chose one.
if (-not $cfg.PSObject.Properties.Name.Contains("default_agent")) {
  $cfg | Add-Member -NotePropertyName "default_agent" -NotePropertyValue "dev" -Force
}

# Ensure hardened permissions exist (don't clobber if user already customized).
if (-not $cfg.PSObject.Properties.Name.Contains("permission")) {
  $perm = [PSCustomObject]@{
    edit = "ask"
    bash = [PSCustomObject]@{
      "*"         = "ask"
      "rm -rf *"  = "deny"
      "rm -rf /"  = "deny"
      "sudo *"    = "deny"
      "git status*" = "allow"
      "git diff*"   = "allow"
      "git log*"    = "allow"
      "ls *"        = "allow"
      "cat *"       = "allow"
    }
  }
  $cfg | Add-Member -NotePropertyName "permission" -NotePropertyValue $perm -Force
}

$cfg | ConvertTo-Json -Depth 20 | Set-Content $globalCfgPath -Encoding utf8
Write-Host "  wrote $globalCfgPath"

Write-Host ""
Write-Host "Done. MOA is installed globally."
Write-Host "Open 'opencode' from any directory and press Tab to switch between dev / chat."
