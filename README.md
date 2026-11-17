# Claude GM Tools

A small Foundry VTT v13 module for a Cosmere RPG (system `cosmere-rpg` 3.x) table where an AI assistant runs the game
by scripting the world through the browser. It contains only code; no game content.

## What it adds

- **`window.GM` (GM clients only):** a JSON-returning helper API: board state, token movement with wall checks and
  grid labels, line of sight, skill and item rolls, chat as a speaker, Cosmere fast/slow combat (with
  *Cosmere Advanced Encounters*), damage/conditions, scenes, playlists, endeavors, event feed. See `scripts/gm-api.js`.
- **Endeavor tracker:** "N successes before M failures" panels shared with players live (world setting; GM-only edits).
  `GM.endeavor('Title', 3, 2)`, `GM.endeavorMark('Title', 'success')`, `GM.endeavorEnd('Title')`.
- **Event feed (GM clients, in memory):** rolls, chat, moves, resource changes, conditions, combat turns and targeting since a
  sequence number: `GM.events(lastSeq)`.

## Install

Foundry setup → Add-on Modules → Install Module → Manifest URL:

```
https://github.com/evanwapowell/claude-gm-tools/releases/latest/download/module.json
```

Recommended: *Cosmere Advanced Encounters* (action tracking) and *Map Coordinates* (grid labels).

## Release (maintainer)

`tools/release.sh <version>` bumps `module.json`, commits, tags, builds `module.zip` with `git archive`, and publishes a GitHub
release with `module.zip` and `module.json` attached. Requires an authenticated `gh` CLI. No credentials are stored in this repo.
