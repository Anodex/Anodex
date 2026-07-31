---
name: verify-before-done
description: Prove a code change actually works before calling it finished, instead of assuming it does.
keywords: [verify, test, check, done, finished, complete, regression, quality, build, lint]
tools: [run_project_check, run_command, git_diff, git_status, read_file]
---

# Verify before done

## When to use

Any time a change is about to be described as working, fixed, or complete — before a commit, a handoff, or a "done" message.

## Steps

1. **Re-read the change.** Run `git_status` to see what moved, then `git_diff` and read the actual diff rather than your memory of it. Confirm every edited file was meant to change.
2. **Run the project's own checks.** Use `run_project_check` — it picks up the repo's configured typecheck, lint, and test scripts. If it finds nothing to run, fall back to `run_command` with the script named in `package.json` or the README.
3. **Read the output.** A non-zero exit or a failing test means not done. Quote the failure instead of re-running and hoping.
4. **Cover the edge you touched.** For a bug fix, confirm the specific failing case now passes. For new code, confirm at least one test or manual path actually exercises it.
5. **Report honestly.** State what was run and what it returned. If a check was skipped or could not run, say that plainly.

## Pitfalls

- "It should work" is not verification. Only command output counts.
- Checks passing on unrelated code prove nothing — make sure the check reaches the file you changed.
- A green run that collected zero tests is a warning sign, not a success.
- Never edit a test to make it pass unless the test itself was the thing that was wrong.
