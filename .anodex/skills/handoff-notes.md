---
name: handoff-notes
description: Capture durable Anodex implementation context for the next human or AI session.
keywords: [handoff, notes, context, roadmap, documentation]
tools: [read_file, search_files, patch_file, update_project_notes]
---

# Handoff notes

Use this when a task spans sessions or when a decision should survive the chat transcript.

## Steps

1. Separate durable decisions from temporary progress. Do not write stale TODO state into permanent docs.
2. Update `ROADMAP.md` for planned/in-progress/deferred product work.
3. Update `README.md` for shipped user-facing behavior.
4. Update `AGENTS.md` only for agent-facing conventions, architecture notes, or gotchas.
5. Use `update_project_notes` for project-local operating notes that should not be public docs.
6. Keep notes compact, dated only when the date matters, and link to files rather than pasting long diffs.

## Completion criteria

- A future session can tell what exists, what remains, and why without rereading the whole transcript.
- No secrets, temporary logs, or one-off command output are preserved unnecessarily.
