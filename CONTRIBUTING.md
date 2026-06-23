# Contributing to recall_lighteagle_integration

Welcome to the team. This document is the single source of truth for how we
work together on this codebase. Read it once, keep it open when you're unsure.

---

## Table of contents

1. [Issue tracking](#issue-tracking)
2. [Branch strategy](#branch-strategy)
3. [Starting a new task](#starting-a-new-task)
4. [Commit messages](#commit-messages)
5. [Opening a pull request](#opening-a-pull-request)
6. [Code review rules](#code-review-rules)
7. [Merging](#merging)
8. [Releasing to production](#releasing-to-production)
9. [Environment variables](#environment-variables)
10. [CI pipeline](#ci-pipeline)
11. [Knowledge graph (graphify)](#knowledge-graph-graphify)

---

## Issue tracking

We track all work in **[Linear](https://linear.app)** (the Light Eagle workspace).
Every change starts from a Linear issue with an ID like `LIG-123` — that ID ties the
branch, the PR, and the commit history back to the task and its context.

If something needs doing and there's no issue for it yet, create one in Linear first.

---

## Branch strategy

We use a three-tier model. No one ever pushes directly to `main` or `develop`.

| Branch | Purpose | Who pushes |
|---|---|---|
| `main` | Production — always stable, always deployable | Nobody directly. Only via PR from `develop` |
| `develop` | Integration — reflects everything approved so far | Nobody directly. Only via PR from feature branches |
| feature branches | Your individual work, one per Linear issue | You, on your own branch |

---

## Starting a new task

Every task gets its own branch, and every branch maps to a Linear issue. Always
branch off `develop`, never off `main`.

Linear generates the branch name for you — open the issue and use **"Copy git branch
name"** (or copy it from the issue's right-hand sidebar). It looks like
`heval/lig-123-short-description`.

```bash
# 1. Make sure your local develop is up to date
git checkout develop
git pull origin develop

# 2. Create your branch using the name Linear gave you
git checkout -b heval/lig-123-calendar-oauth-refresh
```

Moving the Linear issue to **In Progress** when you start (and letting the PR close it
on merge) keeps the board accurate — Linear links the branch and PR automatically once
the names match.

### Branch naming convention

Use the name Linear provides. The shape is:

```
<your-name>/lig-<issue-number>-<short-description>
```

| Example | From |
|---|---|
| `heval/lig-75-project-admin-role-ui` | LIG-75 |
| `gulfem/lig-79-kb-project-detail-scroll-fix` | LIG-79 |

Rules:
- Lowercase only, words separated by hyphens
- Always include the Linear issue ID (`lig-<number>`) — this is what links the branch to the issue
- Keep the description short — 3 to 5 words

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
- [ ] The PR is linked to its Linear issue (use `LIG-123` in the title or description, or the auto-magic Linear link)
- [ ] You've tested the change on the Railway staging deploy
- [ ] The PR description explains **what** changed and **why**
- [ ] No secrets are committed (config lives in Railway, never in the repo)

### PR description template

```
## What this does
[One or two sentences describing the change]

## Why
[Context — what problem does this solve? Reference the Linear issue, e.g. LIG-123]

## How to test
[Steps a reviewer can follow to verify the change works]

## Staging
[How to verify on Railway staging once develop deploys]
```

Including the `LIG-123` ID lets Linear link the PR to the issue and move it through
the workflow automatically as the PR opens and merges.

---

## Code review rules

**For the author:**
- Assign at least one teammate as reviewer
- Don't merge your own PR — even if it's a tiny change
- Respond to every comment, even if just with a thumbs up or "done"
- Don't force-push a branch that has an open PR

**For the reviewer:**
- Review within 24 hours of being assigned
- Pull the branch (or check the Railway staging deploy once merged to develop) — don't just read the diff
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
develop  →  Railway staging      (auto-deploys on every merge to develop)
   │
   └─ PR  →  main  →  Railway production   (auto-deploys on merge to main)
```

Steps:
1. Make sure `develop` is stable and all merged features have been tested on Railway staging
2. Open a PR from `develop` → `main` titled `release: vX.Y.Z — <short summary>`
3. The whole team reviews
4. One approval + green CI → merge
5. Railway deploys `production` automatically within ~1 minute

We don't do hotfixes directly to `main` unless it's a genuine production emergency.
For emergencies: branch off `main` as `hotfix/description`, fix, PR directly to `main`,
then immediately merge `main` back into `develop` so the fix is not lost.

---

## Environment variables

**We don't use `.env` files anymore.** All configuration and secrets live in
**Railway**, scoped per environment (`staging` and `production`). Nothing sensitive
ever goes in the repo.

- For local development, pull the staging values from Railway instead of keeping a
  local `.env`:
  ```bash
  railway login
  railway link                  # select the project, then the `staging` environment
  railway run npm run dev       # runs with Railway-injected staging variables
  ```
- **Never** put production keys on your machine — `railway run` against `staging`
  gives you everything you need locally.
- If you need to add a new env variable:
  1. Add it in the Railway dashboard to **both** the `staging` and `production` services (ask Heval if you don't have access)
  2. Add it to the Zod schema in `src/schemas/EnvSchema.ts` so startup validation stays in sync (`src/api/config/env.ts` parses against it on boot)
  3. Document it in the README's environment-variables table

See the README's [Deployment & Configuration](README.md#deployment--configuration)
section for the full variable list.

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

## Knowledge graph (graphify)

**Optional, opt-in tooling.** [graphify](https://pypi.org/project/graphify/) builds a
queryable knowledge graph of the codebase (call graph, modules, "god nodes") that an AI
assistant can traverse instead of blindly grepping. It is **not** part of the app, the
build, or CI — nothing in `src/` imports it, so it cannot affect runtime behaviour. The
generated graph lives in `graphify-out/`, which is **gitignored** — everyone builds it
locally (no API key required).

If you want to use it:

```bash
# 1. Install the CLI (once, machine-wide)
pipx install graphify          # or: uv tool install graphify

# 2. Build the graph for this repo (instant, no API cost)
graphify update .

# 3. (Optional) Wire it into your AI assistant — graph-first code exploration
graphify claude install        # Claude Code; also: codex / cursor / gemini install

# 4. (Optional) Keep the graph fresh automatically on commit/checkout
graphify hook install
```

Day-to-day usage:

```bash
graphify query "how does transcript ingestion work"   # scoped subgraph for a question
graphify explain "ingestTranscriptToKB"               # a node and its neighbours
graphify path "recall_webhook()" "ingestTranscriptToKB()"  # trace a call path
```

The git hooks (step 4) run in the background, are non-blocking, and only exist on your
machine if you install them — they are not shared by `git clone`, so opting in never
affects other contributors.

---

## Questions?

If something in this document is unclear or missing, open a PR to improve it.
The `CONTRIBUTING.md` is a living document — update it when the process changes.
