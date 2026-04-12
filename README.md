# T3Homer

T3Homer is a T3 Code fork focused on two practical upgrades over vanilla T3 Code:

- desktop interface scaling that behaves like a first-class app setting
- T3Homer, a deterministic background supervisor that rotates unhealthy sessions before they get weird

## TL;DR

Install dependencies, make sure at least one provider CLI is installed and authenticated, then run the desktop app:

```bash
bun install
bun run start
```

That starts the standalone Electron wrapper, which is now the default local run mode.

Short run guide: [docs/how-to-run.md](./docs/how-to-run.md)

## What This Fork Adds

### 1. Desktop scaling that actually sticks

T3Homer exposes `Settings -> General -> Interface scale` in the Electron app. The scale applies immediately, follows the standard zoom shortcuts, and resizes the desktop window coherently instead of leaving the UI and window geometry out of sync.

### 2. Homer background supervision

T3Homer adds a deterministic background supervisor that watches session drift, prepares fresh-session handoffs, and restarts sessions when runtime failures or compaction make the current session unreliable.

Visible cues today:

- a Homer status pill at the bottom of the sidebar
- cumulative handoff tracking with detailed hover stats
- a `Test Homer` button on server-backed threads whenever Homer is enabled

Detailed fork notes: [docs/fork-features.md](./docs/fork-features.md)

## Upstream Compatibility

This repo is still structurally T3 Code, but the desktop-facing fork identity is now `T3Homer`.

- local app data defaults to `~/.t3-homer`
- the desktop app uses its own product name and user-data identity
- scaling and Homer are fork-specific additions on top of the upstream base

## Installation

> [!WARNING]
> T3Homer currently supports Codex and Claude.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
> - Claude: install Claude Code and run `claude auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the upstream desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some Notes

This fork is still early. Expect bugs.

Upstream project docs that are still directly relevant:

Observability guide: [docs/observability.md](./docs/observability.md)
Local fork/sync guide: [docs/local-customization.md](./docs/local-customization.md)
Fork feature notes: [docs/fork-features.md](./docs/fork-features.md)
T3Homer guide: [docs/t3homer.md](./docs/t3homer.md)
T3Homer MVP: [docs/t3homer-mvp.md](./docs/t3homer-mvp.md)

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
