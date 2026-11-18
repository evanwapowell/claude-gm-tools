# Claude GM Tools

A small Foundry VTT v13 module for a Cosmere RPG (system `cosmere-rpg` 3.x) table where an AI assistant runs the game
by scripting the world through the browser. It contains only code; no game content.

## What it adds

- **`window.GM` (GM clients only):** a JSON-returning helper API: board state, token movement with wall checks and
  grid labels, line of sight, skill and item rolls, chat as a speaker, Cosmere fast/slow combat (with
  *Cosmere Advanced Encounters*), damage/conditions, scenes, playlists, endeavors, event feed. See `scripts/gm-api.js`.
- **Endeavor tracker:** "N successes before M failures" panels shared with players live (world setting; GM-only edits).
  `GM.endeavor('Title', 3, 2)`, `GM.endeavorMark('Title', 'success')`, `GM.endeavorEnd('Title')`.
- **Per-token perception (`scripts/perception.js`):** `GM.perceptionFor(token)` evaluates Foundry's own vision, lighting
  and detection-mode checks for one token alone (a detached vision source; nobody's view changes) and returns what that
  token can perceive: its own state and actions, the creatures it can see (hidden tokens never included; names only if
  players could see them), allies, visible walls/doors (secret doors shown as wall) and a small ASCII map, plus `text`, a
  compact rendering for a player agent. `GM.checkIntent(token, {speed, move, actions:[{name, with, target}]})` checks a
  declared turn for walls, occupied cells, action budget, reach/range, line of effect and visibility (GM-side output).
- **Actor handoff:** `GM.setControl(actor, 'player' | 'gm' | userName)` gives players ownership of an actor, or returns it to
  the GM with players as observers.
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
