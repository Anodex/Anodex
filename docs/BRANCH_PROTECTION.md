# Protecting `main`

Changes reach `main` through a pull request, so CI (`.github/workflows/ci.yml`)
runs lint, formatting, typecheck, unit tests, and a build on all three platforms
before the change lands.

## Server-side rules are now available

They were not when this was written. GitHub's branch protection and rulesets are
free on **public** repositories, and are refused on private ones on the free
plan:

```
403 Upgrade to GitHub Pro or make this repository public to enable this feature.
```

`Anodex/Anodex` became public on 2026-09-06, so the option this document used to
rule out is the one that is available — at no cost, and without moving the org to
a paid plan.

**This has not been turned on yet.** Enabling it changes how everyone with push
access works, so it is a decision rather than a cleanup. Until it is, the local
hook below is still the only thing enforcing anything.

### What to create

`docs/ruleset-main.json` next to this file is the definition, ready to apply:

```bash
gh api -X POST repos/Anodex/Anodex/rulesets --input docs/ruleset-main.json
```

It requires a pull request and the `Lint, format & typecheck` and three
`Unit tests` checks, and blocks force pushes and deletions on the default branch.

Two choices in it worth knowing about:

- Required _approvals_ is **0**. `Anodex/Anodex` has one maintainer, a solo
  maintainer cannot approve their own pull request, and a non-zero requirement
  would make `main` unmergeable.
- Repository **admins can bypass** (`actor_id: 5`). That keeps the rule as a
  guard against the failure that actually happens — pushing to `main` out of
  habit — without locking the maintainer out of a hotfix or a version bump. Drop
  the `bypass_actors` block for hard enforcement, and expect to route every
  change, including one-line chores, through a pull request afterwards.

The mobile repo takes the same shape with a single required check, `Assemble and
test`.

## The local hook is gone

`.husky/pre-push` → `scripts/guard-main-push.mjs` refused a direct push to `main`
until 2026-09-09, when it was removed for costing more than it caught.

It was never a control, and its own comment said so: it applied only to clones
that had run `npm install`, `git push --no-verify` walked past it, and any
collaborator could set `ANODEX_ALLOW_MAIN_PUSH=1`. What it could do was refuse
the push you meant to make, every time, until the override became something you
typed without reading — which is a reminder that has stopped reminding anyone of
anything.

**So nothing enforces this today.** A direct push to `main` succeeds, and lands
without CI having seen it. The convention in `AGENTS.md` — a pull request, so CI
runs before the change rather than after — is now upheld by choosing to, and the
ruleset above is what to create if that is not enough.
