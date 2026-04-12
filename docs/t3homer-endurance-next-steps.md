# T3 Homer Endurance Next Steps

This document is the source of truth for the next Homer endurance slice.

## Current Judgment

Strong yes: T3 Homer can be fixed to handle cross-thread session changes with real endurance.

But the fix has to stay deterministic and server-side.

Do not solve this with prompt-only handovers, model memory hopes, or fuzzy AI improvisation.

## Current Known-Good Base

The current branch already has these deterministic behaviors shipped:

- restart-in-place remains supported
- successor-thread promotion remains supported
- old/new thread linkage is projected explicitly
- Homer-owned successor threads keep explicit managed authority state
- short status-check turns are intercepted server-side and can resume managed work deterministically

That closed the original "Are you still working?" successor-thread continuity failure.

## What Still Failed In Endurance Testing

The latest run exposed three real gaps:

1. Homer resumed only after the user nudged it with phrasing close to the current status-check matcher.
2. Successor-thread promotion is visually understandable, but still feels like a jump in the UI.
3. A required exact completion phrase was not preserved across handoffs, which means completion was not proven.

The first and third are real endurance defects.

The second is acceptable to defer.

## Root Cause

### Gap 1: managed-turn interception is still too narrow

The current deterministic interception mostly recognizes short status/progress checks.

That is not enough for endurance. Users will also say things like:

- look at your tasks
- continue
- keep going
- what remains
- finish the remaining tasks
- pick up where you left off

Those should still route through Homer when Homer owns the thread.

### Gap 2: completion requirements are not modeled explicitly

If the user says something like:

- when all tasks are complete, say exactly `X`

that cannot remain an incidental bit of prompt text.

It must be carried as structured authoritative state, or Homer will eventually lose it during thread/session transitions even if the implementation work itself continues correctly.

## Required Deterministic Fixes

### 1. Broaden managed-turn routing

Extend Homer's deterministic interception beyond narrow status checks.

Add an explicit server-side classifier for managed-follow-up user turns while Homer owns the thread.

Good first categories:

- `status_check`
- `resume_managed_work`
- `completion_check`
- `user_takes_back_control`

Examples that should stay managed:

- "look at your tasks"
- "continue"
- "keep going"
- "what remains?"
- "are you done?"
- "finish it"

Examples that should release managed authority:

- real new assignment text
- new scope change
- explicit user redirect to another task

Do not use a model for this classification.
Use deterministic rules over:

- message length
- message shape
- explicit phrase sets
- whether the thread is currently in Homer-managed authority state

### 2. Persist a completion contract

Add a small explicit completion contract to projected Homer state.

Good first shape:

- `requiredExactCompletionPhrase: string | null`
- `completionChecks: string[]`
- `updatedAt`

This can live either:

- as an extension of `T3HomerTaskAnchor`, or
- as a small sibling field such as `homerCompletionContract`

Prefer the smallest shape that keeps the contract explicit.

Do not bury this in freeform handoff text only.

### 3. Carry the completion contract through every authority transition

When Homer:

- restarts in place
- promotes to a successor thread
- resumes managed work after a later user ping

the completion contract must remain authoritative.

The deterministic continuation prompt should include it every time.

### 4. Preserve authority until one of three explicit outcomes

While Homer owns the work, keep authority stable until exactly one of these happens:

- Homer marks the work `completed`
- Homer marks the work `manual_attention`
- the user clearly takes back control with a real new instruction

Do not clear managed authority just because the user sent a short follow-up that failed a narrow regex.

That is the current endurance weakness.

## Non-Goals For This Slice

Do not drift into:

- checkpoint-reset automation
- rollback orchestration
- model-written handoffs
- autonomous replanning
- giant Homer UI or dashboard work
- provider-specific special casing

Checkpoint reset may be useful later, but it is not the endurance fix.

## Acceptance Criteria

The slice is done only if all of these are true:

1. Homer survives at least two handoffs in the same long-running assignment.
2. On a successor thread, follow-up prompts like "look at your tasks" or "what remains?" continue the managed assignment deterministically.
3. The required exact completion phrase is preserved across handoffs and appears when the task is genuinely complete.
4. Old and new threads never both look like the active authority at the same time.
5. Existing restart-in-place behavior still works.
6. Existing successor-thread behavior still works.
7. Manual Test Homer flow is not broken.

## Required Verification

Add or update tests for:

- managed follow-up routing after successor-thread promotion
- completion-contract persistence across restart-in-place
- completion-contract persistence across successor-thread promotion
- release of managed authority only on real user takeover

Run:

- `bun fmt`
- `bun lint`
- `bun typecheck`

Targeted tests should include at minimum:

- `apps/server/src/orchestration/Layers/T3HomerSupervisor.test.ts`
- `apps/server/src/server.test.ts`
- relevant web tests if the UI/manual trigger path changes

## Kickoff Prompt

Use this verbatim or very close to it for the next agent:

```md
You are working inside the T3 Homer fork of T3 Code on the current branch head.

Your task is to implement the next deterministic endurance fix for Homer.

Use these docs as source of truth:

- docs/t3homer-successor-thread-beta-plan.md
- docs/t3homer-endurance-next-steps.md

Current known-good behavior already exists:

- restart-in-place works
- successor-thread promotion works
- old/new thread linkage works
- short status-check turns on a Homer-managed successor thread are intercepted server-side

The remaining problem:

- Homer is still too brittle across long-running cross-thread endurance runs
- prompts like "look at your tasks" are not reliably treated as managed continuation
- exact completion-phrase requirements are not preserved explicitly across handoffs

Goals:

1. Broaden deterministic Homer-managed follow-up routing beyond narrow status checks.
2. Add the minimum explicit projected state needed to preserve a completion contract.
3. Preserve that completion contract across restart-in-place, successor-thread promotion, and later managed resumes.
4. Keep Homer deterministic and server-side.

Non-goals:

- no checkpoint-reset automation in this slice
- no model-written handoffs
- no autonomous replanning
- no provider-specific branching
- no giant Homer dashboard

Constraints:

- do not break the current restart-in-place path
- do not break the current successor-thread path
- do not break the manual Test Homer flow
- do not clear managed authority on short follow-up pings that still mean "continue the same task"

Required output while working:

- inspect current Homer-managed authority code first
- explain any schema/read-model additions clearly
- implement in small coherent steps
- call out compromises if architecture forces them

Required verification:

- add/update server tests for managed endurance continuation and completion-contract persistence
- add/update UI tests only where needed
- run:
  - bun fmt
  - bun lint
  - bun typecheck

Acceptance criteria:

- successor-thread endurance survives multiple handoffs
- "look at your tasks" and similar follow-ups continue the same managed assignment deterministically
- the exact completion phrase survives handoffs and is emitted only when the task is actually complete
- old/new authority remains unambiguous
```
