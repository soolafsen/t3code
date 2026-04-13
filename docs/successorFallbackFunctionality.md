# Successor Fallback Functionality (Agent-Ready)

This document defines a minimal, implementation-ready policy where Homer keeps successor threads as a fallback, not the default recovery path.

## Goal

Keep in-thread restart as the primary recovery mechanism, while retaining successor-thread promotion for isolation when restart-in-place is repeatedly ineffective.

## Problem

Pure restart-in-place can fail under specific conditions:

- stale or poisoned thread runtime state
- repeated handoff/restart loops without real forward progress
- long/noisy history reducing instruction clarity

Removing successor threads now would remove the strongest isolation escape hatch.

## Decision

Use a hybrid policy:

1. First recovery: `restart_in_place`
2. Escalation recovery: `spawn_successor_thread` only on explicit failure signals

## Trigger Rules (Deterministic)

Promote to successor thread when any of these are true:

1. Two consecutive restart-in-place recoveries for the same authoritative assignment revision do not produce a completed turn.
2. Turn-start requested but not started within timeout threshold (stuck pending turn).
3. Repeated provider/runtime fatal warnings during managed continuation window.
4. Explicit manual trigger from Homer operator path (already supported for validation).

Do not promote when:

1. A managed status check is handled normally.
2. A restart-in-place succeeded and produced a completed turn.
3. User has taken back control (managed state released).

## Scope (Do This)

Implement only:

1. Promotion trigger policy and counters.
2. Clear activity logging for why promotion happened.
3. Minimal tests that prove fallback behavior.

## Out Of Scope (Do Not Do In This Slice)

- No broad redesign of Homer orchestration.
- No UI redesign/dashboard work.
- No provider-specific compact orchestration rewrite.
- No new model-driven planning/memory features.

## Implementation Tasks

### Task 1: Promotion Attempt Tracking

Add/derive deterministic tracking at thread level:

- last authoritative assignment revision
- restart-in-place recovery attempts for that revision
- last successful completed turn timestamp for that revision

Reset attempt counter when:

- revision changes
- completed turn occurs under managed authority

### Task 2: Escalation Gate

Before choosing execution policy in handoff prep:

1. Evaluate deterministic trigger rules.
2. If escalation condition met, select `spawn_successor_thread`.
3. Otherwise keep `restart_in_place`.

### Task 3: Activity Evidence

Record explicit activity payload fields on escalation:

- trigger kind (`repeated_restart_failure`, `pending_turn_timeout`, `runtime_fatal_repeat`, `manual`)
- attempt count
- assignment revision
- last known turn id / checkpoint ref

### Task 4: Timeout Guard for Stuck Pending Turn

Detect and classify stuck pending turn (requested but never started) and route to escalation gate.

Use bounded timeout, deterministic and testable.

## Target Files

- `apps/server/src/orchestration/Layers/T3HomerSupervisor.ts`
- `apps/server/src/orchestration/Layers/T3HomerSupervisor.test.ts`
- `packages/contracts/src/t3homer.ts` (only if additional typed payload fields are needed)

## Tests (Required)

Add/update focused tests:

1. First intervention uses restart-in-place.
2. Repeated failed restart-in-place promotes to successor thread.
3. Managed status checks do not increment escalation attempts.
4. Successful completed turn resets restart attempt counter.
5. Stuck pending turn timeout triggers escalation.
6. Escalation activity payload includes trigger evidence.

## Acceptance Criteria

1. Successor thread is no longer chosen as default second step without evidence.
2. Successor promotion happens deterministically for repeated in-place failures.
3. Restart-in-place remains the common/fast path.
4. Existing stop/interrupt behavior remains intact.
5. Existing continuity-state behavior (revision + delta snapshot) remains intact.

## Rollout Plan

1. Implement policy behind existing Homer flow (no UI dependency).
2. Run focused Homer supervisor tests.
3. Run repo checks:
   - `bun fmt`
   - `bun lint`
   - `bun typecheck`
4. Validate manually with one forced failure scenario and one clean restart scenario.

## Operator Prompt (For T3Homer)

Use this instruction to execute:

`Implement docs/successorFallbackFunctionality.md exactly. Keep scope minimal. Code changes only (no new planning docs). Run required tests/checks and report pass/fail with concrete evidence.`
