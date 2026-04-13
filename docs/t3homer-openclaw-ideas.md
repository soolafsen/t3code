# T3 Homer OpenClaw-Inspired Continuity Plan (Agent-Ready)

This document is an actionable implementation brief for borrowing specific OpenClaw continuity ideas in Homer.

## Goal

Fix the current continuity gap:

- Original assignment survives restarts/successors.
- Mid-session instruction updates (for example skill updates) can still be lost.

Success means both original objective and later authoritative deltas survive across:

- restart-in-place
- successor-thread promotion

## Scope (Do This)

Implement these items:

1. Revisioned authoritative assignment state.
2. Pre-transition deterministic instruction snapshot.
3. Continuity prompt block that includes latest deltas.
4. Minimal observability for revision/snapshot usage.
5. Regression tests that prove mid-session updates survive transitions.

## Out Of Scope (Do Not Do In This Slice)

- No new explicit `compact now` command.
- No provider-specific compaction orchestration logic.
- No model-generated memory summaries.
- No broad UI/dashboard work.
- No checkpoint-reset automation in this slice.

## OpenClaw Idea Mapping

1. OpenClaw-style explicit continuity state.
- Homer equivalent: revisioned authoritative task anchor.

2. OpenClaw-style pre-compaction/pre-transition memory handling.
- Homer equivalent: deterministic instruction delta snapshot before restart/successor.

3. OpenClaw-style summary + tail context.
- Homer equivalent: base objective + recent authoritative deltas in handoff/continuation prompts.

## Why Explicit Self-Compaction Is Deferred

Do not add it now.

Rationale:

- Homer already monitors `thread.token-usage.updated` and prepares handoff on threshold.
- Homer already reacts to provider compaction via `thread.state.changed` (`compacted`).
- Codex adapter already reports auto-compaction capability (`compactsAutomatically: true`).

Current issue is continuity of instruction deltas, not missing compaction triggers.

Revisit only when:

1. There is a stable cross-provider compact API.
2. Data shows explicit compaction beats current handoff behavior.
3. Determinism remains intact.

## Implementation Tasks

### Task 1: Revisioned Authoritative State

Add fields to Homer authoritative state:

- `revision: number`
- `updatedAt: string`
- `authoritativeUserMessageId` stays authoritative and must move forward on real instruction changes.

Behavior:

- Increment revision on real instruction change.
- Do not increment for status-only managed follow-ups.
- Persist in projected thread meta state.

### Task 2: Deterministic Instruction Snapshot

Before restart/successor transitions:

- Build structured snapshot from recent authoritative non-synthetic user messages.
- Bound size deterministically (for example latest 3 deltas).
- Persist snapshot in Homer metadata or handoff payload.

Suggested shape:

- `instructionDeltas: string[]`
- `snapshotRevision: number`
- `createdAt: string`

### Task 3: Continuity Prompt Block

In both managed continuation and successor handoff prompts include:

- objective
- constraints
- non-goals
- authority revision
- instruction delta snapshot

This block must be deterministic and always included when Homer owns authority.

### Task 4: Observability

Add explicit Homer activities/metrics:

- revision updated
- snapshot written
- snapshot/revision consumed in handoff/continuation prompt

## Target Files (Expected)

- `apps/server/src/orchestration/Layers/T3HomerSupervisor.ts`
- `packages/contracts/src/t3homer.ts` (if schema extensions needed)
- `packages/contracts/src/orchestration.ts` (if projected contract changes needed)
- `apps/server/src/orchestration/Layers/T3HomerSupervisor.test.ts`
- integration tests only if needed for transition-level coverage

## Test Plan (Required)

Add/adjust tests for:

1. Mid-session instruction update survives restart-in-place.
2. Mid-session instruction update survives successor-thread handoff.
3. Revision increments on real instruction updates, not managed status checks.
4. Continuity prompt carries latest revision + deltas.

## Acceptance Criteria

1. Authoritative revision is persisted and increases only on true instruction changes.
2. Restart-in-place carries latest deltas, not just original objective.
3. Successor handoff carries latest deltas, not just original objective.
4. Existing stop/interrupt behavior remains unchanged.
5. Existing deterministic managed-follow-up interception remains unchanged.

## Run Before Merge

- `bun fmt`
- `bun lint`
- `bun typecheck`
- targeted Homer tests

## Execution Order

1. Add schema/state fields.
2. Add deterministic snapshot builder.
3. Wire snapshot into both transition prompts.
4. Add tests.
5. Validate and ship.
