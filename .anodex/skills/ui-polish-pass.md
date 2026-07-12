---
name: ui-polish-pass
description: Improve Anodex UI while preserving the clean, compact composer and low-clutter transcript style.
keywords: [ui, polish, design, chat, composer, transcript]
tools: [read_file, search_files, code_outline, patch_file, run_project_check]
---

# UI polish pass

Use this for visual or interaction improvements in Anodex.

## Product principles

- Keep the chat composer clean and minimal; discovery UI should be transient/subtle, not persistent clutter.
- User messages can remain bubble-like. Assistant output should read more like an open work log with clear hierarchy.
- Detail-heavy panels default collapsed unless there is an active warning, error, running state, or user request.
- Tool-call groups should use phase headers as the disclosure control; inner successful tool rows should stay flat and quiet.

## Steps

1. Inspect the component and neighboring CSS module before editing.
2. Extract pure display/formatting helpers when possible and test them first.
3. Make the smallest visual change that solves the problem; avoid broad redesigns.
4. Verify with targeted unit tests if helpers changed, then typecheck/lint/build.
5. Report the UX change in product terms, not just files touched.
