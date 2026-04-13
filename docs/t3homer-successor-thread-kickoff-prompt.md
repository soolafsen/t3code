# T3 Homer Successor-Thread Kickoff Prompt

Use this as the copy/paste prompt to kick off the successor-thread beta work in T3 Homer.

## Prompt

```text
You are working inside the T3 Homer fork of T3 Code.

Your task is to implement the successor-thread beta for Homer.

Start by reading these repo docs and treat them as the source of truth:
- docs/t3homer-status.md
- docs/t3homer-mvp.md
- docs/t3homer-successor-thread-beta-plan.md

Goal:
- keep the current deterministic Homer supervisor
- keep the current restart-in-place path
- add a real successor-thread path so Homer can create a fresh thread when the current one should stop being the authority

Branching requirement:
- create and use a dedicated beta feature branch before making code changes
- branch from the current integration branch unless local repo state proves a different base is safer
- use a clear branch name such as `t3-homer-successor-thread-beta`
- do not implement this work directly on `dev` or `main`

Do not drift away from this scope.

Non-goals:
- no model-written handoffs
- no autonomous replanning
- no checkpoint rollback automation in this slice
- no giant Homer dashboard
- no provider-specific branching

What the implementation must do:
1. Add the minimum contract/read-model support needed to represent a Homer-created successor thread and old/new thread linkage.
2. Extend the supervisor with a deterministic `spawnSuccessorThread` flow.
3. Keep two execution policies:
   - `restart_in_place`
   - `spawn_successor_thread`
4. Use a small deterministic initial policy:
   - first Homer intervention on a thread: restart in place
   - second intervention on the same thread: spawn successor thread
5. When successor-thread mode is chosen:
   - build a compact handoff payload
   - create the successor thread in the same project/workspace context
   - attach source-thread linkage
   - stop the old session
   - start a fresh provider session on the new thread
   - append visible activity to both threads
6. Extend the manual Homer test path so successor-thread mode can be exercised deliberately from the app.
7. Make the successor thread discoverable in the sidebar and understandable in the thread UI.

Constraints:
- keep Homer deterministic and server-side
- prefer small explicit projected state over clever freeform text hacks
- never leave both old and new threads looking active at the same time
- preserve existing MVP behavior unless successor-thread policy explicitly applies
- do not break the current manual Test Homer flow

Required output shape while you work:
- first, give a short implementation plan mapped to the slices in docs/t3homer-successor-thread-beta-plan.md
- then implement the work in small coherent commits or checkpoints
- explain any schema/event/read-model changes clearly
- call out any tradeoffs where the current architecture forces a compromise

Required verification:
- add or update server tests for successor-thread creation and authority handoff
- add or update UI tests where appropriate for discoverability or manual-trigger behavior
- run:
  - bun fmt
  - bun lint
  - bun typecheck

Acceptance criteria:
- Homer can deterministically choose successor-thread mode
- the old and new threads are visibly linked
- the old session is no longer the active authority after promotion
- the new thread starts with enough handoff context that it knows exactly where to continue
- the feature can be demonstrated manually in the desktop app

When done:
- summarize exactly what shipped
- list what is still intentionally deferred
- update the relevant docs if implementation details changed from the current plan
```

## Recommended Use

Paste the prompt into a real T3 Homer thread in this repo after enabling Homer.

If you want a visible demo path instead of pure implementation work, tell Homer to validate with this scenario:

1. trigger Homer once and confirm restart-in-place
2. trigger Homer again on the same thread
3. confirm that Homer creates a successor thread
4. confirm the old thread is retired and the new thread has the handoff context
