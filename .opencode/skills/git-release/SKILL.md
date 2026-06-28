---
name: git-release
description: Create consistent releases and changelogs. Use when preparing a tagged release - drafting release notes from merged work, proposing a version bump, and producing a copy-pasteable release command.
license: MIT
compatibility: opencode
metadata:
  audience: maintainers
  workflow: github
---

## What I do

- Draft release notes by summarizing changes since the last tag (grouping into
  Features / Fixes / Chores where possible).
- Propose a semantic version bump (major/minor/patch) based on the nature of the
  changes, and explain the reasoning.
- Produce a copy-pasteable `gh release create` command (or `git tag` + push if
  GitHub CLI is unavailable).

## How I work

1. Determine the last release tag:
   `git describe --tags --abbrev=0` (if none, summarize all history).
2. Collect changes since that tag:
   `git log <last-tag>..HEAD --oneline` (or full history on first release).
3. Group commits into Features, Fixes, and Chores. Keep notes concise and
   user-facing; drop noise like merge commits.
4. Propose the next version following semver:
   - breaking changes -> major
   - new features -> minor
   - fixes/chores only -> patch
5. Output:
   - the drafted changelog (Markdown)
   - the recommended version with a one-line justification
   - a ready-to-run command, e.g.
     `gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."`

## When to use me

Use this when preparing a tagged release. Ask clarifying questions if the
versioning scheme is unclear or if the user wants a different grouping. Do not
run the release command yourself - present it for the user to review and run.
