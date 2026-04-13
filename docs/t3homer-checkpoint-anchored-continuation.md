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

## Actionable task list

Implement in order. Keep each slice independently mergeable.

### Slice 0: baseline guardrails (no behavior change)

- [ ] Lock baseline coverage in `apps/server/src/orchestration/Layers/T3HomerSupervisor.test.ts` for current restart/successor behavior before adding anchor logic.
- [ ] Add a short "feature flag off" assertion path for any new anchor logic to prove no regression when anchor state is absent.
- [ ] Define max budget constants up front in `apps/server/src/orchestration/Layers/T3HomerSupervisor.ts` (`2` restart attempts + `1` successor promotion per assignment revision).

### Slice 1: add explicit anchor + resume-ledger schemas

- [ ] Add `T3HomerContinuationAnchor` schema to `packages/contracts/src/t3homer.ts` with:
      `anchorCheckpointRef`, `anchorCheckpointTurnCount`, `anchorAssignmentRevision`, `anchorCreatedAt`, `anchorUnavailable`.
- [ ] Add `T3HomerResumeLedger` schema to `packages/contracts/src/t3homer.ts` with:
      `completedWorkHints`, `resumeNonce`, `lastAppliedNonce`, `updatedAt`.
- [ ] Extend thread contracts in `packages/contracts/src/orchestration.ts`:
      add `homerContinuationAnchor` and `homerResumeLedger` on thread snapshots and `thread.meta.update` payloads.
- [ ] Update projector/decider plumbing for the new fields:
      `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`,
      `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`.

### Slice 2: persist new fields in projection storage

- [ ] Add a migration to `apps/server/src/persistence/Migrations` for `projection_threads`:
      `homer_continuation_anchor_json` and `homer_resume_ledger_json` nullable text columns.
- [ ] Wire new columns through repository code:
      `apps/server/src/persistence/Services/ProjectionThreads.ts` and
      `apps/server/src/persistence/Layers/ProjectionThreads.ts`.
- [ ] Wire snapshot query decoding/selects:
      `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`.
- [ ] Add/adjust persistence tests in:
      `apps/server/src/persistence/Layers/ProjectionRepositories.test.ts` and
      `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`.

### Slice 3: authoritative anchor selection and prompt contract

- [ ] Add anchor selection helper in `apps/server/src/orchestration/Layers/T3HomerSupervisor.ts`:
      choose latest `ready` checkpoint, else set `anchorUnavailable`.
- [ ] On restart/successor transitions, persist anchor via `thread.meta.update` before prompt injection.
- [ ] Update continuation/handoff prompt builders to include strict anchor contract lines:
      anchor ref + turn + revision, delta-only continuation, and no redo unless verification fails.
- [ ] Add activity emissions for anchor outcomes:
      `anchor_selected`, `anchor_missing`.

### Slice 4: nonce idempotency and duplicate-injection suppression

- [ ] Generate deterministic `resumeNonce` per intervention attempt in `T3HomerSupervisor`.
- [ ] Persist ledger updates (`resumeNonce`, `lastAppliedNonce`) before and after managed prompt injection.
- [ ] Skip duplicate continuation injection when nonce already applied; emit `resume_skipped_duplicate`.
- [ ] Add deterministic unit tests for duplicate suppression in
      `apps/server/src/orchestration/Layers/T3HomerSupervisor.test.ts`.

### Slice 5: evidence-gated restart throttling + budget exhaustion

- [ ] Classify intervention triggers as `hard` vs `soft` inside `T3HomerSupervisor` policy logic.
- [ ] Block repeated soft-trigger interventions while managed work is active and no new hard evidence exists.
- [ ] Enforce per-revision intervention budget; when exhausted, set `manual_attention` and stop auto-recovery churn.
- [ ] Emit `budget_exhausted` activity with reason, revision, and attempt counters.
- [ ] Add tests for:
      soft-signal suppression,
      hard-signal single-intervention per nonce/turn,
      budget exhaustion path to `manual_attention`.

### Slice 6: integration and rollout hardening

- [ ] Add/extend integration scenarios in `apps/server/integration/orchestrationEngine.integration.test.ts` for:
      anchor-based continuation after restart,
      duplicate nonce suppression across repeated supervisor triggers,
      budget exhaustion without infinite restart/successor loops.
- [ ] Add one focused UI assertion (if surfaced) for anchor/manual-attention visibility in
      `apps/web/src/components/Sidebar.logic.test.ts` or related Homer status tests.
- [ ] Update docs that describe Homer behavior:
      `docs/t3homer-status.md` and `docs/t3homer-endurance-next-steps.md` with anchor semantics once shipped.

### Definition of done checklist

- [ ] All new thread fields survive projection persistence round-trip.
- [ ] Managed continuation prompts are anchor-qualified and delta-first.
- [ ] Duplicate continuation injection is prevented by nonce checks.
- [ ] Soft churn no longer causes repeated restarts during active managed work.
- [ ] Budget exhaustion reliably lands in `manual_attention`.
- [ ] `bun fmt`, `bun lint`, and `bun typecheck` pass.

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
