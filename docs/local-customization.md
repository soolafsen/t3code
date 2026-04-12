# Local Customization And Upstream Sync

This repo is early and moving. If you want to use T3 Code as your own agent harness while still taking updates from the original project, the practical goal is simple:

- keep your local changes small, explicit, and easy to reapply
- pull upstream often
- avoid deep forks of fast-moving core code unless you want to own them long term

## Recommended Git Setup

Use two remotes:

- `upstream`: the original T3 Code repository
- `origin`: your fork or private mirror

Example:

```bash
git remote add upstream git@github.com:pingdotgg/t3code.git
git remote -v
```

## Recommended Branch Model

Keep `main` close to upstream.

- `main`: your integration branch, rebased or merged regularly from `upstream/main`
- short-lived feature branches: local features, experiments, fixes
- optional long-lived local branch only if you truly need a private product layer

Practical rule: do not let `main` become a dumping ground for unfinished local experiments.

## Where Local Changes Should Go

Prefer changes that are easy to understand and easy to carry:

- docs, scripts, and launch defaults
- additive UI features behind clear seams
- small server integration points
- config, env handling, and provider wiring

Be careful with:

- thread/session orchestration internals
- provider protocol plumbing
- large refactors across `apps/server`, `apps/web`, and shared contracts at once

Those areas are more likely to move upstream and produce expensive conflicts.

## Good Local Change Shape

Good local changes usually look like this:

- additive, not invasive
- behind a config flag, env flag, or small adapter
- isolated to one package when possible
- documented in `docs/`

Bad local changes usually look like this:

- rewriting core flow just to change default behavior
- copying upstream code into parallel files and drifting from both
- mixing local product ideas with cleanup refactors in the same commit

## Practical Workflow

### 1. Keep a clean integration point

Fetch upstream regularly:

```bash
git fetch upstream
```

Then update your `main`:

```bash
git checkout main
git merge upstream/main
```

If you prefer a linear history:

```bash
git checkout main
git rebase upstream/main
```

Either is fine. The important part is consistency.

### 2. Build local features on top of updated `main`

```bash
git checkout -b feat/my-local-change
```

Keep changes focused. One idea per branch is easier to review and easier to replay.

### 3. Merge local work back into `main`

After checks pass, merge or rebase the feature branch into your `main`.

### 4. Push your fork

```bash
git push origin main
git push origin feat/my-local-change
```

## Conflict Strategy

When upstream and local changes collide, prefer this order of thinking:

1. Keep upstream behavior if your local change was only a convenience tweak.
2. Re-apply the local behavior at a thinner seam.
3. Only carry a deep fork if the behavior is central to your product.

This matters because conflict cost compounds over time. One hard-to-carry customization turns every upstream sync into a manual repair job.

## Repo-Specific Advice

For this repo, local customizations are safest when they stay close to these boundaries:

- `apps/desktop`: desktop wrapper behavior, startup defaults, packaging behavior
- `apps/web`: local UX additions, custom panels, feature toggles
- `apps/server`: local commands, provider integration glue, startup policy
- `docs/` and `scripts/`: team workflow, local setup, automation helpers

Use extra care when touching:

- `apps/server/src/codexAppServerManager.ts`
- `apps/server/src/providerManager.ts`
- `apps/server/src/wsServer.ts`
- shared protocol/contracts that both server and web depend on

Those files sit on critical runtime paths.

## Keep Local Defaults Cheap To Carry

If you need the app to behave differently by default, prefer:

- one small script change
- one package script change
- one documented env or config switch

Avoid scattering the same behavior across server, web, and desktop unless it is genuinely a cross-cutting feature.

## Suggested Maintenance Rhythm

- sync upstream before starting substantial local work
- sync again before cutting a release or sharing the branch broadly
- fix conflicts immediately while context is fresh
- keep a short note in docs when you introduce a durable local divergence

## Local Divergence Log

When you intentionally keep behavior different from upstream, write it down.

A simple format is enough:

- what changed
- why it exists
- where it lives
- whether it should be upstreamed later

That makes future merges much less mysterious.

## Short Version

Treat upstream as the moving base layer and your local work as a thin product layer on top.

If a customization is expensive to reapply, it is probably in the wrong place or shaped too broadly.
