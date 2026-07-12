---
name: dependency-upgrade
description: Upgrade Anodex dependencies safely with lockfile review, targeted compatibility checks, and rollback notes.
keywords: [dependencies, upgrade, npm, package, lockfile]
tools: [read_file, search_files, git_diff, run_project_check, run_command]
---

# Dependency upgrade

Use this when changing `package.json` or `package-lock.json`.

## Steps

1. Read the package scripts and identify which app surfaces the dependency touches.
2. Upgrade the smallest dependency set possible; avoid mixing feature changes with dependency churn.
3. Inspect lockfile/package diff for unexpected major-version jumps.
4. Run targeted tests for the touched area plus `typecheck`, `lint`, and `build`.
5. Note any migration changes, native module rebuild implications, or Electron packaging risks.

## Pitfalls

- Treating a successful install as verification.
- Upgrading `node-llama-cpp`, Electron, Vite, or TypeScript without broader smoke checks.
- Committing unrelated lockfile churn from a previous session.
