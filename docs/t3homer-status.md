# T3 Homer Status

This is the single overview document for T3 Homer.

Use it to answer two questions quickly:

1. what is already implemented
2. what is still left to do

If the other Homer docs get more detailed over time, this file should stay short and current.

## Current State

T3 Homer is past the concept stage and into an MVP-plus state:

- the MVP supervision loop exists and is working
- the fork-specific desktop scaling work exists and is working
- the app identity is separated from a stock T3 Code install
- a concrete beta plan exists for successor-thread mode

What does not exist yet is the full Homer recovery model. The current implementation is still intentionally narrow.

## Core Principles

These principles still define T3 Homer:

- keep Homer deterministic and server-side
- use measured signals and rules, not model judgment
- treat fresh-session continuation as the default answer to session drift
- reserve checkpoint reset for repo drift, not ordinary session fatigue
- prefer visible, auditable interventions over silent magic
- do not turn Homer into a second agent competing with the provider

## How Continuity Is Carried Today

When people say "session memory" in Homer, this is what it actually means: persisted orchestration state, not hidden model recall.

### A. Authoritative continuity artifacts

- `homerTaskAnchor` (thread metadata):
  - objective
  - source document paths
  - constraints and non-goals
  - branch expectation
  - revision and authoritative user message id
  - completion contract (`requiredExactCompletionPhrase`, completion checks)
- `instructionDeltaSnapshot`:
  - compact recent deltas from authoritative user instructions
  - explicit snapshot revision + timestamp
- `homerManagedWorkState`:
  - `active` or `manual_attention`
  - execution policy (`restart_in_place` or `spawn_successor_thread`)

### B. Handoff payload contents

On restart/successor transitions, Homer writes a deterministic handoff payload containing:

- source thread id + execution policy
- task anchor + instruction delta snapshot
- verified done / verified not-done evidence
- next action and verification still required
- relevant file paths and checkpoint ref

### C. Checkpoint model in practice

Checkpoint summaries are first-class control signals, not passive logs.

- each turn can produce `thread.turn-diff-completed` with status: `ready`, `missing`, or `error`
- summaries include checkpoint turn count, checkpoint ref, touched files, and completion timestamp
- Homer uses those statuses to decide:
  - continue normally (`ready`)
  - restart/escalate while keeping completion unverified (`missing` / `error`)
  - include explicit checkpoint state in continuation and handoff prompts

### D. Other auditable artifacts

- thread activity timeline entries for supervision, handoff preparation, session stop/start, and escalation
- successor linkage fields:
  - `homerSourceThreadId`
  - `homerSuccessorThreadId`
  - `homerTransitionKind`
- escalation evidence:
  - trigger kind
  - attempt count
  - assignment revision
  - last known turn id + checkpoint ref

## What Is Done

### 1. Desktop scaling

Implemented:

- Electron-only `Interface scale` setting under `Settings -> General`
- immediate zoom application
- standard zoom shortcut support
- startup window sizing that follows the configured scale

Why it matters:

- the app now behaves like a real desktop app instead of leaving zoom state half-detached from the window shell

### 2. Homer MVP supervision

Implemented:

- deterministic server-side supervisor service
- supervision based on real runtime and orchestration signals
- handoff preparation
- in-place fresh-session restart from current repo state
- runtime failure and compaction recovery
- checkpoint outcome monitoring as an input signal

Signals currently used:

- `thread.token-usage.updated`
- `runtime.warning`
- `runtime.error`
- `thread.state.changed`
- `thread.turn-diff-completed`

### 3. Homer visibility

Implemented:

- thread activity entries for Homer actions
- footer pill in the sidebar
- primary footer metric shows cumulative `handoffs`
- footer hover shows lower-level started, ended, interrupted, and escalated counts
- `Test Homer` button on server-backed threads whenever Homer is enabled

### 4. Fork identity separation

Implemented:

- desktop-facing app name is now `T3 Homer`
- local app data defaults to `~/.t3-homer`
- the fork uses its own desktop identity and user-data naming where that matters

Why it matters:

- this fork no longer silently collides with a standard T3 Code install in the obvious settings/profile paths

### 5. Docs and planning

Implemented:

- front page README now calls out the two main fork differentiators: scaling and Homer
- MVP doc reflects actual current behavior
- fork feature doc exists
- successor-thread beta plan exists

## What Is Left To Do

These are the meaningful unfinished pieces, in practical order.

### A. Successor-thread beta

Status:

- planned
- not implemented

Why it matters:

- this is the first feature that lets Homer do something visibly bigger and more useful than restarting the same thread in place

Plan:

- [docs/t3homer-successor-thread-beta-plan.md](./t3homer-successor-thread-beta-plan.md)

### B. Checkpoint-aware reset

Status:

- not implemented

What is missing:

- automatic `reset_to_checkpoint` when repo state is no longer trustworthy

Why it matters:

- this is the biggest missing recovery idea
- right now Homer can recover a bad session, but not a bad repo state

### C. Better behavioral heuristics

Status:

- not implemented

What is missing:

- repeated user re-steer detection
- no-progress cycle detection
- stronger deterministic "this thread is no longer a good place to continue" signals

Why it matters:

- current Homer mostly sees technical degradation, not behavioral degradation

### D. Stronger projected Homer state

Status:

- partially implemented through activity and lightweight counters
- not first-class yet

What is missing:

- clearer per-thread projected supervisor state such as:
  - `continuing`
  - `preparing handoff`
  - `restarting`
  - `successor spawned`
  - `escalated`

Why it matters:

- activity-only visibility works for MVP, but it will get thin as Homer behavior gets richer

### E. More meaningful escalation path

Status:

- basic escalation activity exists
- operational escalation path does not

What is missing:

- a more explicit answer to "what happens after repeated failed Homer interventions?"

Examples:

- require user confirmation
- pause Homer on that thread
- route to a heavier orchestration path

## Recommended Working Order

If the goal is to keep building on the current implementation without turning Homer into a mushy side-agent, the next order should be:

1. successor-thread beta
2. checkpoint-aware reset
3. better no-progress and re-steer heuristics
4. stronger projected Homer thread state
5. more explicit escalation behavior

That order keeps the next step visible and useful, then adds the more dangerous recovery mechanics after the transition model is proven.

## Related Docs

- [docs/t3homer-mvp.md](./t3homer-mvp.md)
- [docs/t3homer-successor-thread-beta-plan.md](./t3homer-successor-thread-beta-plan.md)
- [docs/t3homer-successor-thread-kickoff-prompt.md](./t3homer-successor-thread-kickoff-prompt.md)
- [docs/t3homer-checkpoint-reset-beta-plan.md](./t3homer-checkpoint-reset-beta-plan.md)
- [docs/t3homer-checkpoint-reset-kickoff-prompt.md](./t3homer-checkpoint-reset-kickoff-prompt.md)
- [docs/fork-features.md](./fork-features.md)
