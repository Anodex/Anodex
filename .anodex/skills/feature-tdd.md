---
name: feature-tdd
description: Build an Anodex feature in thin tested slices using RED-GREEN-REFACTOR.
keywords: [feature, tdd, tests, implementation, slice]
tools: [code_outline, read_file, search_files, patch_file, write_file, run_project_check]
---

# Feature TDD

Use this for new product or tool behavior in Anodex.

## Steps

1. Read `README.md`, `ROADMAP.md`, and the relevant source files before editing.
2. Find the smallest behavior boundary. Prefer a pure helper or store/service function before touching React UI.
3. Add a focused test and run it to see the expected failure.
4. Implement the minimum code to pass, preserving existing style and no drive-by refactors.
5. Wire UI/IPC only after the helper/service behavior is green.
6. Run targeted tests, then typecheck/lint/build as appropriate.
7. Update README/ROADMAP/AGENTS when the feature changes documented behavior or agent conventions.

## Completion criteria

- The new behavior has a regression test.
- Tool/runtime catalog/docs are in sync when tools changed.
- Verification output is real and reported back with commands.
