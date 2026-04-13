# T3 Homer Checkpoint-Anchored Continuation Plan

## Why this exists

Homer currently carries checkpoint context into handoff prompts, but it still resumes from "current repo + thread state". That is robust, but it can cause repeated re-validation and partial rework after restarts/successor handoffs.

Goal: make continuation deterministic and cheaper by resuming from a concrete checkpoint anchor whenever possible.

## Problem statement

Symptoms we want to reduce:

- too many short-lived successor/restart sessions
- repeated work after handoff ("starts over" behavior)
- high token/time cost from rediscovery

Current gap:

- checkpoint refs are advisory context, not a strict resume anchor
- no explicit "already completed work ledger" that is enforced on resume

## Target behavior

When Homer owns managed authority and a verified checkpoint exists:

1. Pick one authoritative checkpoint anchor (`checkpointRef + turn + revision`).
2. Resume from that anchor with strict "delta-first" instructions.
3. Block repeated restarts when no new failure evidence exists.
4. Escalate only on concrete new failures, not soft churn.

## Proposed design

### 1) Authoritative continuation anchor

Add/derive a deterministic anchor at transition time:

- `anchorCheckpointRef`
- `anchorCheckpointTurnCount`
- `anchorAssignmentRevision`
- `anchorCreatedAt`

Rules:

- Prefer latest `ready` checkpoint.
- If no `ready` checkpoint exists, keep managed state but mark `anchorUnavailable`.
- If `anchorUnavailable` repeats across retries, escalate to manual attention instead of looping restarts.

### 2) Resume ledger (anti-redo)

Persist a small server-side resume ledger tied to anchor + revision:

- `completedWorkHints` (bounded list of done items/files from checkpoint + recent events)
- `resumeNonce` (idempotency key per intervention)
- `lastAppliedNonce` (to suppress duplicate continuation injections)

Rules:

- Managed continuation prompt must include "continue from anchor delta only".
- If the same nonce is already applied, skip injecting another managed resume message.

### 3) Strict continuation prompt contract

In managed continuation/successor handoff prompt:

- "Anchor checkpoint: X (turn Y)"
- "Treat work before this anchor as completed unless verification proves otherwise."
- "Prioritize unfinished items only."
- "Do not re-execute completed steps for confidence."

Keep this deterministic and short.

### 4) Restart throttling by evidence

Track evidence classes:

- hard: runtime error, checkpoint error/missing, pending-turn timeout
- soft: warning count, high token usage

Rule:

- soft signals cannot trigger repeated interventions while managed work is already active
- hard signals can intervene, but only once per turn/nonce

### 5) Session budget guard

Per assignment revision, enforce a small managed intervention budget (for example 2 restarts + 1 successor promotion). Once exhausted without new evidence, switch to manual attention and stop auto-thrashing.

## OpenClaw-inspired ideas worth adding

These are likely high-value for T3 Homer:

1. Explicit continuity state machine.
   Keep authority, anchor, and transition reason first-class in server state.
2. Delta-first continuation memory.
   Carry objective once, then carry only new authoritative deltas + unresolved items.
3. Idempotent continuation injection.
   Nonce-based suppression of duplicate managed resume prompts.
4. Evidence-gated escalation.
   Promote only when new, classified failure evidence appears.
5. Compact observability surface.
   Emit small, consistent activities: anchor_selected, anchor_missing, resume_skipped_duplicate, budget_exhausted.

## Non-goals

- No model-written summaries/memory.
- No provider-specific custom compaction API in this slice.
- No broad UI redesign.

## Rollout slices

1. Anchor + prompt contract only.
2. Nonce/idempotency + restart suppression.
3. Resume ledger + budget guard.
4. Optional UI polish (surface anchor status in Homer stats tooltip).

## Validation

Add/adjust tests for:

1. Resume uses latest ready checkpoint anchor in prompt.
2. Same intervention nonce does not inject duplicate continuation.
3. No repeated soft-trigger restarts while managed active.
4. No stale objective carry-over when latest authoritative input differs.
5. Budget exhaustion leads to manual_attention, not infinite restart/successor churn.

## Success criteria

- Fewer sessions per managed assignment under churn scenarios.
- Reduced repeated edits after handoff.
- Lower token usage for successor/restart recovery paths.
- No drift from latest authoritative user instruction.
