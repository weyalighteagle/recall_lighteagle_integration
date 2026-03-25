# Contributing to recall_lighteagle_integration

Welcome to the team. This document is the single source of truth for how we
work together on this codebase. Read it once, keep it open when you're unsure.

---

## Table of contents

1. [Branch strategy](#branch-strategy)
2. [Starting a new task](#starting-a-new-task)
3. [Commit messages](#commit-messages)
4. [Opening a pull request](#opening-a-pull-request)
5. [Code review rules](#code-review-rules)
6. [Merging](#merging)
7. [Releasing to production](#releasing-to-production)
8. [Environment variables](#environment-variables)
9. [CI pipeline](#ci-pipeline)

---

## Branch strategy

We use a three-tier model. No one ever pushes directly to `main` or `develop`.

| Branch | Purpose | Who pushes |
|---|---|---|
| `main` | Production — always stable, always deployable | Nobody directly. Only via PR from `develop` |
| `develop` | Integration — reflects everything approved so far | Nobody directly. Only via PR from feature branches |
| `feature/*` | Your individual work | You, on your own branch |

---

## Starting a new task

Every task gets its own branch. Always branch off `develop`, never off `main`.

```bash
# 1. Make sure your local develop is up to date
git checkout develop
git pull origin develop

# 2. Create your branch — name it after the task
git checkout -b feature/calendar-oauth-refresh
```

### Branch naming convention

| Type | Pattern | Example |
|---|---|---|
| New feature | `feature/<short-description>` | `feature/calendar-oauth-refresh` |
| Bug fix | `fix/<short-description>` | `fix/webhook-duplicate-key` |
| Urgent production fix | `hotfix/<short-description>` | `hotfix/recall-api-timeout` |
| Documentation only | `docs/<short-description>` | `docs/update-readme-setup` |
| CI / tooling | `ci/<short-description>` | `ci/add-lint-step` |

Rules:
- Lowercase only, words separated by hyphens
- Keep it short — 3 to 5 words max
- No ticket numbers in the branch name (use the PR description for that)

---

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org). This
makes the git log readable and makes it easy to understand what changed and why.

```
<type>: <short summary in present tense, lowercase>

[optional body — explain the why, not the what]
```

### Types

| Type | When to use |
|---|---|
| `feat` | Adding a new feature |
| `fix` | Fixing a bug |
| `refactor` | Restructuring code — no behavior change |
| `docs` | Documentation only |
| `ci` | CI workflow changes |
| `chore` | Tooling, deps, config — nothing that affects runtime |
| `test` | Adding or updating tests |
| `revert` | Reverting a previous commit |

### Good examples

```
feat: add Google Calendar OAuth refresh token flow
fix: prevent duplicate bots when same meeting URL appears twice
refactor: extract deduplication key logic into shared util
docs: add webhook setup steps to README
ci: upgrade Node.js to 22 in GitHub Actions
chore: update @tanstack/react-query to v5.90
```

### Bad examples

```
fixed stuff          ← no type, too vague
WIP                  ← never commit WIP to a shared branch
update               ← what was updated?
FEAT: Add OAuth      ← no uppercase type
```

Commit often on your own branch — every logical unit of work deserves its own
commit. Don't squash everything into one giant commit at the end.

---

## Opening a pull request

When your feature is ready to be reviewed:

```bash
# 1. Sync with the latest develop before opening the PR
#    (resolve any conflicts locally — never on develop)
git pull origin develop

# 2. Push your branch
git push origin feature/your-branch-name

# 3. Open a PR on GitHub targeting develop (not main)
```

### PR checklist

Before requesting review, confirm:

- [ ] The branch is targeting `develop`, not `main`
- [ ] CI is passing (green checkmark on the PR)
- [ ] You've tested the feature on your Vercel preview URL
- [ ] The PR description explains **what** changed and **why**
- [ ] No `.env` values or secrets are committed

### PR description template

```
## What this does
[One or two sentences describing the change]

## Why
[Context — what problem does this solve, or what task does it close?]

## How to test
[Steps a reviewer can follow to verify the change works]

## Preview URL
[Your Vercel preview link — e.g. recall-lighteagle-git-feature-xyz.vercel.app]
```

---

## Code review rules

**For the author:**
- Assign at least one teammate as reviewer
- Don't merge your own PR — even if it's a tiny change
- Respond to every comment, even if just with a thumbs up or "done"
- Don't force-push a branch that has an open PR

**For the reviewer:**
- Review within 24 hours of being assigned
- Test the Vercel preview URL — don't just read the diff
- Be specific and constructive — "this could break X because Y" not just "I don't like this"
- Approve only when you're genuinely happy with the change

**Approval requirement:** 1 approval from a teammate is required before merging.
The CI check must also be green. GitHub will block the merge button otherwise.

---

## Merging

Once you have approval and CI is green:

- Use **"Squash and merge"** for small single-purpose PRs
- Use **"Merge commit"** for larger features where the individual commit history matters
- Delete the branch after merging — GitHub will offer this automatically

Never use "Rebase and merge" — it rewrites history and makes `git blame` confusing.

---

## Releasing to production

Production (`main`) only gets updated through a deliberate release PR.

```
develop  →  PR  →  main  →  Vercel auto-deploys  +  Railway auto-deploys
```

Steps:
1. Make sure `develop` is stable and all merged features have been tested on the develop preview URL
2. Open a PR from `develop` → `main` titled `release: vX.Y.Z — <short summary>`
3. The whole team reviews
4. One approval + green CI → merge
5. Vercel and Railway deploy automatically within ~1 minute

We don't do hotfixes directly to `main` unless it's a genuine production emergency.
For emergencies: branch off `main` as `hotfix/description`, fix, PR directly to `main`,
then immediately merge `main` back into `develop` so the fix is not lost.

---

## Environment variables

**Never commit `.env` to the repo.** It is in `.gitignore` and must stay there.

- Copy `.env.sample` to `.env` when setting up locally
- Fill in **staging** credentials for local development (never production keys locally)
- Production secrets live in Vercel's environment variable settings (scoped to Production)
- If you need to add a new env variable:
  1. Add it to `.env.sample` with a placeholder value and a comment explaining it
  2. Add it to Vercel's environment variables (ask Heval if you don't have access)
  3. Update the `src/api/config/env.ts` validation if the app validates env vars on startup

---

## CI pipeline

Every push to `develop` and every PR targeting `main` or `develop` triggers the CI workflow.

The workflow (`.github/workflows/ci.yml`) runs:
1. `npm ci` — clean install using the lockfile
2. `npx tsc --noEmit` — TypeScript type check (no JS emitted, just validation)
3. `npm run build` — Vite frontend production build

**If CI fails, the PR merge button is locked.** Fix the errors locally, push again,
CI re-runs automatically.

Common CI failures and fixes:

| Error | Fix |
|---|---|
| `Cannot find name 'X'` | Declare or import the missing variable/type |
| `Type 'X' is not assignable to type 'Y'` | Fix the type mismatch or add a proper type assertion |
| `Module not found` | Check the import path — TypeScript paths are case-sensitive |
| Build step fails | Run `npm run build` locally to reproduce and debug |

Always run `npx tsc --noEmit` locally before pushing if you've made significant
type-related changes. Catching it locally is faster than waiting for CI.

---

## Questions?

If something in this document is unclear or missing, open a PR to improve it.
The `CONTRIBUTING.md` is a living document — update it when the process changes.
