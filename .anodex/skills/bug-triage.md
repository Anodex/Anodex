---
name: bug-triage
description: Diagnose and fix Anodex bugs by reproducing first, tracing the root cause, and adding a regression test.
keywords: [bug, debug, regression, root-cause, failing-test]
tools: [search_files, read_file, code_outline, git_diff, run_project_check, patch_file]
---

# Bug triage

Use this when Anodex behavior is wrong, tests fail, or the user reports a regression.

## Steps

1. Reproduce the bug with the smallest command or test. If it is UI-only, identify the closest pure helper/store boundary.
2. Trace the failing path from caller to implementation; do not patch the first symptom blindly.
3. Add or adjust a regression test that fails for the right reason.
4. Fix the root cause and check sibling paths for the same flaw.
5. Re-run the regression test and the relevant broader check.
6. Summarize cause, fix, and verification.

## Common pitfalls

- Treating a failed model/tool transcript as proof without checking the source file or live state.
- Fixing one call site while the same helper is used elsewhere.
- Forgetting that Electron main, preload, renderer, and shared types each have separate tsconfig coverage.
