# T3 Homer MVP

T3 Homer is the first cut of a deterministic background supervisor for this T3 Code fork.

The goal of this MVP is narrow:

- watch for measurable session drift
- prepare or force a fresh-session handoff before the thread gets weird
- restart from current repo state instead of leaning on provider compaction
- stay invisible until it needs to leave an audit trail

This is intentionally not a second agent. Homer uses rules, not model judgment.

## What Ships In This MVP

### Background supervision

When enabled in Settings, Homer runs server-side in the background and watches:

- context-window pressure from `thread.token-usage.updated`
- repeated `runtime.warning` signals
- `runtime.error`
- explicit provider compaction from `thread.state.changed`
- missing or failed checkpoint outcomes from `thread.turn-diff-completed`

### Current behaviors

The MVP implements the safe part of the original plan first:

- prepare handoff when the context window is getting crowded
- stop and restart immediately when runtime failure or compaction makes the current session unreliable
- prepare a compact structured handoff payload and append it to thread activity
- start a fresh provider session on the same thread so the user does not need to manually recover the session

Checkpoint reset is not part of this MVP yet. Homer only uses restart-from-current-state right now.

## Settings

Homer is controlled by one server-side setting:

- `Settings -> General -> T3 Homer`

That switch enables or disables the background supervisor for the app.

## Visible UI

Homer stays quiet until it acts, but there are now three visible cues:

- thread activity entries such as `prepare handoff`, `session ended`, `session interrupted`, `handoff prepared`, and `session started`
- a footer status pill at the bottom of the sidebar that shows whether Homer is on plus cumulative `handoff` count
- a `Test Homer` button in server-backed thread headers whenever Homer is enabled

## What Homer Does Not Do Yet

This MVP deliberately does not try to solve everything:

- no model-written handoffs
- no autonomous replanning
- no checkpoint rollback automation
- no broad no-progress or user re-steer heuristics yet
- no heavyweight Homer control panel

That restraint is deliberate. The useful differentiator is reliable session hygiene, not another mushy orchestrator.

## Practical Notes

- Homer defaults to off.
- This fork now keeps its local app data under `~/.t3-homer` by default so it does not share settings with a standard T3 Code install.
- Footer handoff counts are derived from persisted Homer activity, so they survive reloads.
- Hovering the footer pill still shows the lower-level started, ended, interrupted, and escalated counts.
- The current restart path reuses the live thread and current repo state.
- When Homer is enabled, the active server-thread header includes a `Test Homer` button that forces a fresh-session handoff for manual verification.

## Recommended Next Steps

If this MVP proves stable, the next sensible additions are:

1. checkpoint-aware reset when the current repo state is no longer trustworthy
2. better no-progress and repeated re-steer detection
3. more explicit per-thread Homer state in the read model if the lightweight activity-based UI stops being enough

Successor-thread beta plan: [docs/t3homer-successor-thread-beta-plan.md](./t3homer-successor-thread-beta-plan.md)
Status overview: [docs/t3homer-status.md](./t3homer-status.md)
