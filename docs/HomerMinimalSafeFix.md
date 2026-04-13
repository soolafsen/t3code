# HomerMinimalSafeFix

This is the minimal safe fix for Homer continuity when sessions restart or promote to successor threads.

## Problem To Fix

Current Homer can preserve the original assignment but still lose mid-session instruction updates (for example, skill updates) across restart/successor transitions.

## Scope

Implement only these 3 changes:

1. Revisioned authoritative assignment state.
2. Pre-handoff deterministic instruction snapshot.
3. Continuity prompt block that carries recent instruction deltas.

Do not add broader architecture changes in this slice.

## 1) Revisioned Authoritative Assignment State

Add explicit revisioned authority metadata to Homer task state:

- `revision: number`
- `updatedAt: string`
- `authoritativeUserMessageId: MessageId | null` (already present, keep using it)

Behavior:

- On each real user instruction change (not short managed follow-ups), increment `revision`.
- Update objective/constraints/non-goals/source docs from the latest authoritative message set.
- Persist the revision in thread meta so restart/successor paths read the same source of truth.

## 2) Pre-Handoff Deterministic Instruction Snapshot

Before restart-in-place or successor-thread handoff:

- Build a deterministic `instructionDeltaSnapshot` from recent authoritative user turns.
- Keep it structured and bounded (for example latest 3-5 deltas).
- Persist snapshot in thread meta/activity payload used by handoff.

Suggested shape:

- `instructionDeltas: string[]`
- `snapshotRevision: number`
- `createdAt: string`

No model summarization; rule-based extraction only.

## 3) Continuity Prompt Block With Recent Deltas

In both:

- managed continuation prompt
- successor handoff prompt

Include:

- base objective
- active constraints/non-goals
- latest revision number
- recent instruction deltas from `instructionDeltaSnapshot`

This ensures the model sees the newest user directives even when the original objective stays the same.

## Explicit Non-Goals

- No explicit "self-compact now" command in this slice.
- No provider-specific compact orchestration changes.
- No new autonomous planning behavior.
- No broad UI/dashboard expansion.

## Acceptance Criteria

1. If user adds a mid-session skill/instruction update, Homer carries it across restart-in-place.
2. Same update is preserved when Homer promotes to successor thread.
3. Managed follow-up interception behavior remains intact.
4. Existing stop-button behavior remains intact.

## Required Tests

Add/update focused tests in:

- `apps/server/src/orchestration/Layers/T3HomerSupervisor.test.ts`

At minimum:

1. Mid-session instruction update survives restart-in-place.
2. Mid-session instruction update survives successor-thread handoff.
3. Revision increments only on real instruction changes, not status checks.

## Run Before Done

- `bun fmt`
- `bun lint`
- `bun typecheck`
- targeted Homer tests
