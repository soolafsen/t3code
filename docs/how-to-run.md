# How To Run

This repo now defaults to the full desktop app.

## TL;DR

```bash
bun install
bun run start
```

That launches the standalone Electron wrapper.

## Requirements

- Install and authenticate at least one provider CLI first.
- Codex: `codex login`
- Claude: `claude auth login`

## Common Commands

- Full app, default path: `bun run start`
- Full app in dev mode: `bun run dev:desktop`
- Server-only path: `bun run start:server`
- Web/server dev path: `bun run dev`

## Notes

- `bun run start` is the intended local default and should open the desktop app directly.
- The server-only path is still available, but it is no longer the default startup mode.
