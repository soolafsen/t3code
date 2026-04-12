# T3 Homer Successor-Thread Beta Plan

This plan covers the next meaningful step after the current T3 Homer MVP:

- keep the current deterministic supervisor
- keep the current restart-from-current-state path
- add a real `successor thread` mode so Homer can move work forward into a fresh thread when the current one is becoming the wrong place to continue

This is the beta that gives Homer something bigger and more visibly useful to do than just restarting the same thread.

## Why This Beta Matters

The current MVP proves that Homer can:

- detect session drift
- prepare a handoff
- stop a bad session
- restart a fresh provider session on the same thread

That is good session hygiene, but it is still conservative.

The next useful step is to let Homer create a clean successor thread when the current thread should stop being the authority.

That matters because a successor thread can:

- preserve a clean boundary between "old unstable session" and "next healthy continuation"
- make Homer action more visible and easier to audit
- reduce the chance that the old thread silently keeps stretching forever
- give the user a concrete artifact to inspect, compare, and resume from

## Beta Goal

When deterministic Homer rules decide that a thread should not continue in-place, Homer should be able to:

1. stop the current session
2. prepare a compact structured handoff
3. create a successor thread in the same project and workspace context
4. seed that successor thread with the handoff payload
5. start a fresh provider session on the successor thread
6. clearly link the old and new threads in projected UI state

The old thread becomes the historical record. The successor thread becomes the active continuation.

## Non-Goals

This beta should still stay disciplined.

Do not add:

- model-written handoffs
- autonomous replanning
- checkpoint rollback automation in the same slice
- giant control panels
- provider-specific branching logic

Checkpoint-aware reset is still important, but it should stay a separate follow-up slice unless the implementation naturally shares enough plumbing to justify both together.

## Product Shape

### Primary behavior

Keep two Homer execution policies:

- `restart_in_place`
- `spawn_successor_thread`

The current MVP already implements the first one.

The beta adds the second one and lets the supervisor choose between them using deterministic rules.

### Initial policy

Start with a narrow, explicit rule set.

Good first rules for `spawn_successor_thread`:

- repeated handoff count on the same thread crossed a threshold
- runtime failure happened after a prior Homer intervention on the same thread
- provider compaction or repeated warnings indicate the thread should be retired, not refreshed in place
- manual `Test Homer` can optionally choose successor-thread mode for validation

Good first rules for staying on `restart_in_place`:

- first intervention on a thread
- simple runtime failure with otherwise healthy repo state
- checkpoint outcome missing but thread context still looks recoverable

This keeps the beta from changing every Homer event into thread proliferation.

## User Experience

### What the user should see

When Homer promotes to a successor thread:

- the old thread gets a visible activity saying Homer spawned a successor thread
- the new thread gets a visible activity saying it was created by Homer from a prior thread
- the handoff payload is visible and auditable
- the sidebar makes the new thread discoverable immediately

### Thread titles

Keep titling deterministic and boring.

Good first cut:

- preserve the original thread title
- append a small sequence marker only when necessary, for example `My task (Homer 2)`

Avoid clever title generation.

### Footer and visibility

Footer Homer stats should keep counting handoffs, but successor-thread interventions should be obvious in the thread timeline and easy to recognize in the sidebar.

Do not hide this behind hover-only state.

## Architecture Plan

### Contracts

Add explicit successor-thread Homer metadata in contracts.

Likely additions:

- a Homer activity payload for `successor thread created`
- optional thread linkage fields such as:
  - `homerSourceThreadId`
  - `homerSuccessorThreadId`
  - `homerTransitionKind`

If the current read model cannot express thread-to-thread Homer linkage cleanly, add a small projected field rather than encoding everything in activity text.

### Supervisor service

Extend `T3HomerSupervisor` with a `spawnSuccessorThread` flow.

That flow should:

1. resolve the current thread and project context
2. build the handoff payload
3. create the successor thread
4. attach the handoff payload and source-thread linkage
5. stop the old session
6. start the provider session on the new thread
7. append activities to both threads

Important: thread creation and session start must be treated as one orchestrated transition, not a loose pile of side effects.

### Orchestration events

Prefer using existing orchestration commands where possible.

Likely needed:

- `thread.create`
- `thread.activity.append`
- `thread.session.set`

If there is no clean existing command for thread-link metadata, add one explicitly rather than smuggling it through freeform payloads.

### Provider/session behavior

The old thread should not remain active after successor promotion.

Expected behavior:

- old thread session moves to stopped
- new thread session becomes the fresh running authority
- provider state never leaves both threads looking active at the same time

### UI/read model

The minimum useful projection for beta is:

- source/successor thread linkage
- visible activity on both sides
- enough sidebar information that the user can find the successor thread immediately

Good first cut:

- keep sidebar sorting as-is
- mark successor threads with small Homer provenance text in secondary metadata

Avoid building a full thread-family tree in beta.

## Implementation Slices

### Slice 1. Contract and read-model plumbing

Deliverables:

- thread linkage fields or explicit Homer successor activity payloads
- tests proving the projection can represent old/new thread linkage

Acceptance:

- a server test can create a Homer-linked successor relationship and read it back

### Slice 2. Supervisor successor-thread flow

Deliverables:

- `spawnSuccessorThread` implementation in `T3HomerSupervisor`
- deterministic policy for choosing in-place restart vs successor thread
- tests for session handoff across threads

Acceptance:

- supervisor can create a successor thread, stop the old session, and start the new one
- old/new thread activities are appended correctly

### Slice 3. Manual trigger and validation path

Deliverables:

- extend `Test Homer` to support successor-thread testing
- toast and activity feedback that clearly says a successor thread was created

Acceptance:

- one manual action can deterministically exercise the new flow in the desktop app

### Slice 4. Sidebar and thread UX

Deliverables:

- basic discoverability for successor threads in the sidebar
- visible linkage copy in thread header or activity timeline

Acceptance:

- user can tell which thread replaced which without reading raw JSON

## Suggested Rule Set For Beta

Start small and deterministic.

Proposed initial rule set:

- first Homer intervention on a thread: restart in place
- second intervention on the same thread within the thread lifetime: spawn successor thread
- escalation threshold still applies after repeated successor promotions

This gives Homer a clear new job without exploding complexity.

## Data To Carry Forward

The successor thread should inherit only what is operationally necessary:

- project id
- cwd / worktree path
- branch context
- model selection
- runtime mode
- compact handoff payload
- source-thread linkage

Do not blindly copy arbitrary thread UI state.

## Implementation Notes

### Deterministic successor kickoff

In the current architecture, a freshly started provider session does not reconstruct its working context from previously projected thread history alone.

That means successor-thread promotion needs two deterministic inputs on the new thread:

- a visible handoff record the user can inspect
- an immediate kickoff prompt that tells the new session to continue from the handoff and repo state without asking for the original assignment again

In this implementation, Homer also persists a compact task anchor on the thread itself. That anchor carries the authoritative objective, source-doc references, explicit constraints, non-goals, and branch expectation. Short status or progress questions are treated as status checks, not as authority changes, so the successor kickoff can keep the original assignment stable across long-running thread and session transitions.

This still stays inside the beta constraints:

- the handoff payload is server-built
- no model-written handoff is introduced
- no autonomous replanning is introduced
- the successor thread starts with enough explicit context to continue reliably

## Demo Scenario

The beta should be easy to show off with the current app.

Ideal demo:

1. enable Homer
2. open a real server-backed thread
3. trigger Homer once and observe normal in-place recovery
4. trigger again under the beta rule
5. Homer creates a successor thread
6. old thread shows it was retired by Homer
7. new thread opens with the handoff and fresh session

That is a much clearer "Homer is doing useful work" moment than the current invisible restart path.

## Risks

### Too many threads

If the policy is too eager, Homer becomes thread spam.

Mitigation:

- use a high threshold first
- keep successor promotion explicit and rare

### Broken authority boundaries

If both old and new sessions look active, trust drops immediately.

Mitigation:

- enforce a single active authority thread in tests

### Weak discoverability

If successor threads are created but hard to find, the feature will feel broken.

Mitigation:

- always append visible old/new linkage activities
- keep sidebar discoverability in the initial beta slice

## Acceptance Criteria

This beta is done when:

- Homer can deterministically choose successor-thread mode
- successor thread creation is fully covered by server tests
- old and new threads are visibly linked in the UI
- manual testing in the desktop app can trigger and demonstrate the flow
- the feature still passes `bun fmt`, `bun lint`, and `bun typecheck`

Kickoff prompt for this slice: [docs/t3homer-successor-thread-kickoff-prompt.md](./t3homer-successor-thread-kickoff-prompt.md)

## After This Beta

The next major follow-up should be checkpoint-aware reset.

That would give T3 Homer the full two-lane recovery model the original design wanted:

- session drift -> fresh continuation
- repo drift -> checkpoint reset
