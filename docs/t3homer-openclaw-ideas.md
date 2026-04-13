# T3 Homer: OpenClaw Ideas to Steal

This note captures practical ideas from OpenClaw that are worth adopting in Homer, with emphasis on continuity across compaction/session rotation.

## Why This Exists

We observed a real gap:

- Homer can preserve the original assignment across session changes.
- But a mid-session instruction update (for example, a skill update) can be lost across restart/successor transitions.

So we need better continuity for *instruction deltas*, not just base objective continuity.

## High-Value Ideas to Borrow Now

1. Revisioned authoritative assignment state.
- Keep a `revision` counter and `updatedAt` on Homer task authority.
- Every real user instruction update increments revision.
- Restarts/successor handoffs always carry the latest revision, not just initial objective.

2. Pre-handoff memory flush.
- Before restart/successor transition, persist a deterministic "instruction delta snapshot" from recent authoritative user turns.
- Keep it structured (not freeform model summary).

3. Tail-context continuity block.
- In continuation/handoff prompts, include:
  - base objective
  - latest instruction updates (recent N deltas)
  - active constraints/non-goals
- This mirrors OpenClaw's "summary + recent tail" continuity model.

4. Strong lifecycle observability.
- Add explicit activities/metrics for:
  - authority revision changed
  - pre-handoff snapshot written
  - handoff prompt revision used

## Should Homer Proactively Call Compact Itself?

Short answer: not needed right now.

Reasoning:

- Homer already pre-empts context pressure by monitoring `thread.token-usage.updated` and preparing handoff at threshold (`HOMER_PREPARE_USAGE_RATIO`).
- Homer already reacts to provider compaction via `thread.state.changed` (`compacted`) and rotates authority.
- Codex adapter capability is already modeled as auto-compacting (`compactsAutomatically: true`).

Given that, an explicit "compact now" command is optional and not the best fix for the current bug.

Current bug is about instruction continuity, not missing compaction triggers.

## When to Revisit Explicit Self-Compaction

Consider adding an explicit compact command only if all are true:

1. Provider exposes a stable cross-provider compact API.
2. We can prove lower failure rate vs current preemptive handoff path.
3. We can keep deterministic behavior and avoid provider-specific drift.

If added, it should be:

- capability-gated per provider
- best-effort
- followed by the same authoritative continuity snapshot flow

## Proposed Homer Implementation Order

1. Authority revision + latest-authoritative-message tracking.
2. Pre-handoff deterministic instruction delta snapshot.
3. Include delta snapshot in restart and successor prompts.
4. Add regression tests for "mid-session instruction update survives restart/successor."
5. Only then evaluate optional explicit self-compaction.

## Bottom Line

Steal OpenClaw's continuity ideas around state revision and pre-transition memory handling.

Do not prioritize explicit self-compaction yet; it is not the primary fix for the observed "skill update forgotten" issue.
