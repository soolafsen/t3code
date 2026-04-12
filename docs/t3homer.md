# T3Homer

This note adapts the ideas from [Homer Deterministic Session Supervisor](https://github.com/soolafsen/CodexBrainstorms/blob/main/docs/homer-deterministic-session-supervisor.md) to T3 Code.

## TL;DR

T3Homer should be a deterministic server-side supervisor for long-running provider sessions.

It should:

- watch measurable session failure signals
- force handoff before a thread gets weird
- prefer fresh-session restart over compaction
- use existing checkpoints for rollback when repo state has actually drifted
- escalate only when the dumb deterministic loop cannot continue safely

It should not be another model.

## Why T3 Code Is A Good Fit

T3 Code already has most of the hard substrate Homer needs:

- provider runtime events are normalized before they hit the UI
- server orchestration is event-shaped and explicit
- thread/session state is already projected into a read model
- checkpointing already exists as a first-class concept
- the web app already consumes orchestration state rather than raw provider state

That means T3Homer does not need to invent a parallel harness. It can sit inside the existing server orchestration flow.

## What T3Homer Should Be In This Repo

In T3 Code, T3Homer should be:

- a deterministic service in `apps/server`
- fed by normalized provider runtime signals plus orchestration events
- scoped per thread session
- responsible for restart, handoff, escalation, and checkpoint reset decisions

In other words: a janitor with rules, not a planner with opinions.

## What It Should Not Be

T3Homer should not:

- call a model to decide state transitions
- generate long narrative summaries
- replace the existing orchestration engine
- act like a second agent competing with the provider
- silently compact and continue forever

If it becomes smart enough to improvise, it inherits the same drift problem it is meant to control.

## Current Repo Signals T3Homer Can Reuse

The repo already exposes several useful deterministic signals.

### Provider-side signals

- `thread.token-usage.updated` from `apps/server/src/provider/Layers/CodexAdapter.ts`
- `thread.state.changed` including provider compaction signals
- `runtime.warning`
- `runtime.error`

### Orchestration-side signals

- `thread.turn-start-requested`
- `thread.session-set`
- `thread.session-stop-requested`
- `thread.turn-diff-completed`
- `thread.reverted`
- checkpoint lifecycle handled by the checkpoint reactor

### Structural advantages already present

- `apps/server/src/codexAppServerManager.ts` already owns provider session lifecycle details
- `apps/server/src/orchestration/decider.ts` already centralizes command-to-event transitions
- `apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts` already gives a clean boundary for runtime ingestion
- `apps/server/src/orchestration/Services/CheckpointReactor.ts` already gives a place to react to checkpoint outcomes
- `apps/server/src/ws.ts` already projects server-side orchestration state outward to the client

This is enough for a useful v0.

## Proposed T3Homer State Machine

Keep the state machine blunt:

- `continue`
- `prepare_handover`
- `handover_now`
- `escalate`

Then keep restart policy separate:

- `restart_from_current_state`
- `reset_to_checkpoint`

That split matters. Session drift and repo drift are not the same failure.

## Recommended T3Homer Inputs

Only measurable inputs should drive transitions:

- token usage for the active thread
- count of runtime warnings and runtime errors during the active turn
- number of user re-steers or repeated follow-up corrections
- no-progress cycles
- checkpoint failure or missing-checkpoint outcomes
- explicit provider compaction events
- optional wall-clock duration per active session

## Recommended Outputs

Keep outputs simple:

- continue current turn
- restrict thread to closeout work
- request a clean stop for the current session
- write a compact handoff artifact
- create or prepare a fresh successor thread
- revert to the last known-good checkpoint
- escalate to a heavier orchestration path

## Mapping Homer To T3 Code

### `continue`

Normal operation.

Allowed:

- run turns normally
- accept provider runtime events
- keep checkpoint history current
- append evidence and activity events

### `prepare_handover`

Thread is closing, not exploring.

Allowed:

- finish one bounded step
- gather concrete repo references
- write a small structured handoff
- run one last verification pass

Not allowed:

- opening new broad work
- starting new speculative branches
- letting the current session keep stretching indefinitely

### `handover_now`

Stop the current session and move to a fresh one.

In T3 Code terms, this likely means:

- dispatch session stop
- persist a compact handoff artifact
- create a successor thread or mark the thread as ready for relaunch
- ensure the old session does not silently resume as the authority

### `escalate`

Use only when deterministic rules cannot safely classify the situation.

Examples:

- repeated restart without stabilizing
- repeated verifier disagreement
- ambiguous result that cannot be checked mechanically
- a task that now clearly needs heavier planning/orchestration

## Fresh Session Beats Compaction In T3 Code Too

T3 Code already sees provider compaction-related signals. That does not mean compaction should become the primary recovery plan.

The safer policy is:

- detect degradation early
- write a small handoff
- stop the session
- continue from a fresh session using live repo state plus compact state

Compaction can remain a provider fact. It should not become T3Homer's strategy.

## Checkpoint Policy

This repo already has checkpointing, which is the strongest practical fit with the Homer model.

Use checkpoints only for repo drift, not for ordinary session fatigue.

### `restart_from_current_state`

Use when:

- the session is bloated or confused
- runtime warnings are accumulating
- user re-steers keep repeating
- current repo state is still acceptable

Action:

- keep the worktree
- write handoff
- start fresh

### `reset_to_checkpoint`

Use when:

- a previously good thread state has regressed
- checkpoint diff or verification shows the current state is no longer trustworthy
- required checks passed at an earlier checkpoint and now fail

Action:

- revert to the last eligible checkpoint
- log the reset reason as a supervisor event
- restart from the restored state

## Recommended V0 Architecture

The cleanest first cut is a new server-side orchestration service, not a provider-specific patch.

### Suggested placement

- `apps/server/src/orchestration/Services/T3HomerSupervisor.ts`
- `apps/server/src/orchestration/Layers/T3HomerSupervisor.ts`

### Suggested responsibilities

- subscribe to normalized runtime receipts and orchestration events
- maintain per-thread supervisor counters and state
- trigger deterministic transitions
- dispatch existing orchestration commands where possible
- append structured supervisor activities for observability

### Suggested minimal persisted state

Start small. T3Homer does not need a giant memory subsystem in v0.

Per thread, persist only:

- supervisor state
- token budget snapshot
- warning/error counters
- re-steer/no-progress counters
- last eligible checkpoint ref
- compact handoff payload

## Handoff Shape For T3 Code

The handoff should stay structured and short.

A good T3Homer handoff for this repo likely needs:

- thread id
- goal
- verified done
- verified not done
- next action
- verification still required
- relevant file paths
- checkpoint ref if rollback is possible

That can live as:

- a persisted server-side JSON payload
- a projected thread activity for visibility
- optionally a dedicated thread field later if it becomes first-class UX

## UI Implications

The web app does not need a huge new mode to make this useful.

A good v0 UI would only need to show:

- thread is under supervision
- thread has entered handover mode
- restart happened from current state or checkpoint
- escalation required

That can likely ride on existing thread activity and session state projection before any bigger UX work.

## Practical V0 Rollout

1. Add supervisor state and events to contracts.
2. Implement `T3HomerSupervisor` as a deterministic orchestration service.
3. Feed it normalized runtime signals and checkpoint outcomes.
4. Emit visible supervisor activities into the thread timeline.
5. Start with stop-and-handoff only.
6. Add checkpoint reset once the handoff flow is trusted.
7. Add automatic successor-thread bootstrap only after the simpler loop is stable.

That order matters. The risky part is not counting tokens. The risky part is accidentally building an autonomous meta-agent instead of a strict control loop.

## What I Would Not Build First

I would not start with:

- long-form memory files
- model-written handoffs
- autonomous replanning
- provider-specific custom logic split across multiple adapters
- UI-heavy control panels before the state machine is proven

That is how a small deterministic idea turns into another mushy orchestrator.

## Bottom Line

T3Homer fits this repo well because T3 Code already has:

- normalized runtime events
- explicit orchestration commands and events
- checkpointing
- a projected thread/session model

The right move is to add a deterministic supervisor in the server orchestration layer and keep it narrow.

If T3Homer stays dumb, explicit, and checkpoint-aware, it could become one of the strongest differentiators in this codebase.
