---
name: code-review
description: Review Anodex code changes for correctness, safety, UI fit, tests, and documentation.
keywords: [review, pr, diff, quality, security]
tools: [git_status, git_diff, code_outline, read_file, search_files, run_project_check]
---

# Code review

Use this when the user asks for a review, PR pass, or quality check before committing.

## Steps

1. Check `git_status` and identify the exact changed files. Stop if unrelated work is mixed in and call it out.
2. Use `git_diff` for the changed files, then `code_outline`/`read_file` only where context is needed.
3. Review by risk area: main/renderer boundary, workspace path confinement, approval/risk behavior, local-first expectations, and UI clutter.
4. Verify tests changed with behavior. Prefer focused tests first, then `run_project_check` for the relevant command.
5. Report findings in priority order: bugs/security first, then test gaps, then polish. If clean, say what was checked and which commands passed.

## Anodex-specific checks

- IPC changes must stay typed through `src/shared/ipc.ts` and return `Result<T>` from main handlers.
- File-system tool changes must use `resolveInWorkspace` or an equivalent workspace boundary.
- New tools must be registered, cataloged in `TOOL_CATALOG`, documented, and covered by registry parity tests.
- UI additions should keep the composer and transcript low-clutter; default detail-heavy panels collapsed.
