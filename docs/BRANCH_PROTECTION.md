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

A ruleset on `main` requiring a pull request and the `Lint, format & typecheck`
and `Unit tests` checks, blocking force pushes and deletions.

Required _approvals_ should stay at **0**. `Anodex/Anodex` has one maintainer, a
solo maintainer cannot approve their own pull request, and a non-zero requirement
would make `main` unmergeable.

Once a ruleset is in place, `.husky/pre-push` becomes redundant and the
`ANODEX_ALLOW_MAIN_PUSH` escape hatch becomes a lie — the server would refuse the
push the hook just waved through. Remove both in the same change.

## The local hook, until then

`.husky/pre-push` → `scripts/guard-main-push.mjs` is a speed bump against pushing
to `main` out of habit — the failure that actually happens — and not a security
control:

- it only applies to clones that have run `npm install` (which installs husky);
- `git push --no-verify` bypasses it;
- any collaborator can set the escape-hatch variable;
- it cannot run CI, so it cannot require a green build.

Treat it as a reminder that happens to be automated. It refuses both a direct
push to `main` and a delete of `main`.

## Pushing anyway

For a genuine direct push — a hotfix, a revert of a bad merge:

```bash
ANODEX_ALLOW_MAIN_PUSH=1 git push
```
