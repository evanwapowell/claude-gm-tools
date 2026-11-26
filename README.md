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
  declared turn for walls, occupied cells, action budget (talent actions such as stances included; `free: true` when a
  talent makes one free), reach/range, line of effect, visibility, the one-Strike-per-hand rule (two-handed weapons,
  offhand focus) and Recover already used (GM-side output).
- **Sheets and party (`scripts/perception.js`):** `GM.sheetFor(actor)` renders a character's sheet as compact text, live
  from Foundry (level, attributes, resources, defenses, skills, expertises, talents with summaries, weapons, armor, gear,
  money, conditions, injuries), plus an **allies** block: what each other party member can openly do. `GM.setParty([...])`
  marks the party (actor flag). `GM.setHiddenFromParty(actor, item, true)` keeps an item (say, a power not yet revealed
  in play) out of other members' views. Summaries use the item's short description; `GM.setShort(actor, item, text)`
  overrides it. `perceptionFor` also lists each party ally's abilities and whether their Recover is spent.
- **Once per scene (Recover):** using the system's Recover action marks the actor (shown in `GM.turn()` and
  `perceptionFor`); `GM.endCombat()` and `GM.newScene()` reset it; `GM.markRecover(actor, used)` sets it by hand.
- **PC weapon attacks:** `GM.rollItem`/`GM.npcTurn` accept a PC weapon name ('Longbow' or 'Strike: Longbow') and attack
  through the weapon's strike action. `npcTurn` attacks take `graze: 'free'` for talents like Combat Training,
  `advantage`/`disadvantage: true` (they cancel), and `bonusDamage: n` (a charge, say), added to the hit, graze or crit
  amount and applied in the same damage call.
- **Damage and deflect:** `GM.damage(key, amount, type)` also takes a list, `GM.damage(key, [10, 4], 'keen')` or
  `[{amount, type}, ...]`, sent as one system `applyDamage` call: deflect is subtracted once from the total. Two separate
  `GM.damage` calls for one hit subtract it twice.
- **Without a token:** `GM.damage`, `heal`, `setResource` and `setCondition` fall back to the world actor (by id or name)
  when no token on the viewed scene matches; the result says `viaActor: true`. Only for linked actors (PCs and other
  linked actors): an unlinked NPC without a token is refused with an error.
- **Who pays costs (focus, Investiture, uses):** `GM.rollItem` and `GM.npcTurn` use items with `shouldConsume: false`, so
  they never deduct costs: deduct with `GM.setResource` (`npcTurn` deducts the 1 focus of a graze itself). A use from the
  sheet or the action HUD (a player, or the GM clicking) is a normal system use and **does** consume: don't deduct again.
- **Long text, page by page:** `sheetFor`, `perceptionFor` and `turn` keep their full text; `GM.page(i, size = 900)`
  returns `{from, page, of, text}` (1-based, split at line ends) without recomputing, for tools that cut results at about
  1,000 characters.
- **Stances:** the active stance is the system's actor flag `cosmere-rpg.mode.stance` (the stance talent's id). In
  system 3.1.2 with the handbook's stance talents, using a stance from the sheet only posts a chat card: the cost sits on
  a nested action without the modality, so the flag and the stance's effect never change. So `GM.rollItem(actor,
  'Stonestance')` uses the talent's nested action and then enters the stance with the system's `actor.setMode`, and
  `GM.setStance(actor, 'Stonestance' | null)` enters or ends one directly (e.g. after a player used it from the sheet);
  both switch the stance effects (Stonestance: deflect +1). The stance shows in `GM.turn()` (piece tag plus a `stances`
  list with the rule), `perceptionFor` (own stance with its rule; party allies' stance) and `sheetFor`;
  `GM.stance(actor)` returns it. `checkIntent` treats entering another stance while in Vigilant Stance as a free action
  and reports the change in `plan.stance`.
- **Talents with actions:** `GM.rollItem` on a talent (or other non-action item) uses its first nested action, as the
  sheet does.
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
