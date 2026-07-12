---
name: release-checklist
description: Prepare an Anodex desktop release with build, packaging, smoke checks, and documentation review.
keywords: [release, build, package, electron, distribution]
tools: [git_status, git_diff, run_project_check, read_file, search_files]
---

# Release checklist

Use this before packaging or publishing Anodex.

## Steps

1. Confirm `git_status` and note any uncommitted or unrelated work.
2. Run `run_project_check` for `test`, `typecheck`, `lint`, and `build`.
3. Review README and ROADMAP for features that landed but are undocumented or backlog items that should move.
4. If packaging is requested, run the package/dist command only after the build is green.
5. Smoke check the produced app/artifact path and report exact outputs.

## Release notes prompts

- What changed for users?
- What changed for assistant/tool behavior?
- Any migration or setup notes?
- What verification was run?
