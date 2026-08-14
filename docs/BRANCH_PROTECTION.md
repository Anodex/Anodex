# Protecting `main`

Changes reach `main` through a pull request, so CI (`.github/workflows/ci.yml`)
runs lint, formatting, typecheck, unit tests, and a build on all three platforms
before the change lands.

## Why this is a local hook, not a GitHub rule

GitHub's branch protection and repository rulesets are not available for a
private repository on the free plan. Both REST endpoints answer:

```
403 Upgrade to GitHub Pro or make this repository public to enable this feature.
```

`Anodex/Anodex` is private by design, and the `Anodex` org is on the free plan,
so the server-side rule cannot be created today. `.husky/pre-push` →
`scripts/guard-main-push.mjs` is what can be enforced at no cost.

## What the hook actually buys

It is a speed bump against pushing to `main` out of habit — the failure that
actually happens — and not a security control:

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

## Getting real enforcement

Server-side rules need one of:

- **GitHub Team** on the `Anodex` org (paid) — keeps the repo private and
  enables rulesets; or
- **GitHub Pro** on a user-owned private repo (paid); or
- making the repository public, which is not appropriate here.

With any of those, create a ruleset on `main` requiring a pull request and the
`Lint, format & typecheck` and `Unit tests` checks, and blocking force pushes
and deletions. Note that `Anodex/Anodex` currently has one collaborator, so
required _approvals_ should stay at 0 — a solo maintainer cannot approve their
own pull request, and a non-zero requirement would make `main` unmergeable.
