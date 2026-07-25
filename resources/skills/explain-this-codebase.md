---
name: explain-this-codebase
description: Build an accurate map of an unfamiliar project before changing anything in it.
keywords: [explain, onboard, architecture, overview, unfamiliar, structure, understand, where]
tools: [list_directory, find_files, code_outline, search_code, read_file, git_commit_summary]
---

# Explain this codebase

## When to use

First contact with a repo — answering "what is this?", "where does X live?", or "how does Y work?" — and as the opening step before any non-trivial change to unfamiliar code.

## Steps

1. **Start at the edges.** `list_directory` the root, then read `README.md` and the package manifest to learn the stack, entry points, and available scripts.
2. **Find the entry point, then follow it.** Use `find_files` for `main`, `index`, or `app` files, and `code_outline` to see a file's shape before reading it end to end.
3. **Trace by symbol, not by guess.** `search_code` for a function or type name to find its definition _and_ every caller. The callers explain intent better than the definition does.
4. **Check the recent past.** `git_commit_summary` shows what the project has been working on lately, which is usually where the live complexity sits.
5. **Say it back.** Summarize the architecture in plain language, name the file each claim came from, and flag whatever is still unclear.

## Pitfalls

- Do not infer behavior from a file name. Open the file.
- Directory structure describes intent, not runtime flow — follow the imports for the real shape.
- When two files look like they do the same job, one is usually legacy. Check history before assuming which one is live.
- Read before writing. This skill is deliberately read-only.
