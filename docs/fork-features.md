# T3Homer Fork Features

This document tracks the fork-specific changes that currently matter most compared with vanilla T3 Code.

## The Two Big Differences

### Desktop scaling

T3Homer adds a desktop-facing interface scale control under `Settings -> General -> Interface scale`.

Current behavior:

- applies immediately in the Electron app
- follows `Ctrl/Cmd +`, `Ctrl/Cmd -`, and `Ctrl/Cmd 0`
- rescales startup window sizing so the window and UI stay in sync
- is stored in desktop client settings for the local machine

This is the practical answer to "the app feels wrong at this scale" rather than relying on ad hoc zoom state.

### Homer supervision

T3Homer adds a deterministic background supervisor for server-backed threads.

Current behavior:

- watches measurable session drift and runtime failure signals
- prepares or forces a fresh-session handoff
- restarts from the current repo state instead of treating compaction as the strategy
- appends visible thread activity so intervention is auditable

## Additional Fork Changes

### App identity isolation

To avoid stepping on a standard T3 Code install, the fork now uses its own desktop identity where that matters.

Current behavior:

- app-facing labels now use `T3Homer`
- local app data defaults to `~/.t3-homer`
- desktop app identity and user-data naming are fork-specific

That separation is meant to keep this fork from silently sharing settings with a stock T3 Code install.

### Homer visibility and testing

The fork now exposes lightweight Homer visibility without turning it into another dashboard.

Current behavior:

- sidebar footer pill shows Homer on/off state
- primary footer metric shows cumulative `handoffs`
- hover detail keeps the lower-level started, ended, interrupted, and escalated counts
- server-backed threads show a `Test Homer` button whenever Homer is enabled

The test button uses the real supervisor restart path. It is not a fake UI-only simulation.

## Files and Docs To Read Next

- [docs/how-to-run.md](./how-to-run.md)
- [docs/t3homer.md](./t3homer.md)
- [docs/t3homer-mvp.md](./t3homer-mvp.md)
