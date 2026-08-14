#!/usr/bin/env node
/**
 * Refuse a direct push to the default branch, so changes reach `main` through a
 * pull request that CI has actually run against.
 *
 * Why this is a hook and not a GitHub branch-protection rule: branch protection
 * and rulesets are not available for a private repository on GitHub's free plan
 * (the REST endpoints answer 403 "Upgrade to GitHub Pro or make this repository
 * public"), and this repository is deliberately private. A local hook is what
 * can be enforced today at no cost.
 *
 * Be honest about what that buys. This is a speed bump against pushing to
 * `main` out of habit — the case that actually happens — not a security
 * control. It only protects clones that have run `npm install` (which installs
 * husky), any collaborator can set the escape-hatch variable, and `--no-verify`
 * bypasses it entirely. Real enforcement needs a paid plan; see
 * docs/BRANCH_PROTECTION.md.
 *
 * git passes each ref being pushed on stdin as:
 *   <local ref> <local sha> <remote ref> <remote sha>
 */
import { createInterface } from 'node:readline'

/** Branch this guard protects; matches the repository's default branch. */
const PROTECTED_BRANCH = 'main'
const PROTECTED_REF = `refs/heads/${PROTECTED_BRANCH}`
/** Deliberate opt-out for the rare intended direct push (a hotfix, a revert). */
const OVERRIDE = 'ANODEX_ALLOW_MAIN_PUSH'
/** git's all-zero sha, meaning "no object" — a branch delete on the remote side. */
const NO_OBJECT = /^0+$/

if (process.env[OVERRIDE] === '1') process.exit(0)

const updates = []
for await (const line of createInterface({ input: process.stdin })) {
  const [localRef, localSha, remoteRef] = line.trim().split(/\s+/)
  if (!remoteRef) continue
  if (remoteRef !== PROTECTED_REF) continue
  // A delete of `main` is refused for the same reason a push is, so don't skip
  // it here just because there is no incoming object.
  updates.push({ localRef, deleting: NO_OBJECT.test(localSha ?? '') })
}

if (updates.length === 0) process.exit(0)

const deleting = updates.every((update) => update.deleting)
process.stderr.write(
  `\n  Refusing to ${deleting ? 'delete' : 'push directly to'} ${PROTECTED_BRANCH}.\n\n` +
    `  Open a pull request instead, so CI runs before the change lands:\n\n` +
    `    git switch -c <branch>\n` +
    `    git push -u origin <branch>\n` +
    `    gh pr create --fill\n\n` +
    `  If this push is genuinely meant to go straight to ${PROTECTED_BRANCH}:\n\n` +
    `    ${OVERRIDE}=1 git push\n\n`
)
process.exit(1)
