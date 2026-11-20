// Claude GM Tools: GM helper API for Foundry VTT v13 + Cosmere RPG system 3.x (verified against 3.1.2).
// Loaded automatically by the claude-gm-tools module; installs window.GM on GM clients when the world is ready
// (players do not get it). Every function returns plain JSON-able data. Lookups take an id or a name
// (case-insensitive; exact match first, then substring). Cells are scene-relative {col, row} (0-based, padding excluded)
// plus a label like 'C7' (column letters, 1-based row) that matches the Map Coordinates module; moveToken accepts labels.
// Output keys avoid 'token'/'tokens'/'tokenId' (a browser-automation output filter redacts them): piece/pieces/tokId.
(() => {
  const V = '2.3.0';
  const SYS = 'cosmere-rpg';
  const err = msg => { throw new Error(`[GM] ${msg}`); };
  const lc = s => String(s ?? '').toLowerCase();
  const find = (coll, key, label) => {
    if (key == null) err(`${label}: no id/name given`);
    if (typeof key === 'object' && key.documentName) return key;
    const doc = coll.get?.(key) ?? coll.find(d => lc(d.name) === lc(key)) ?? coll.find(d => lc(d.name).includes(lc(key)));
    return doc ?? err(`${label} not found: ${key}`);
  };
  const scene = () => canvas?.scene ?? err('no scene is being viewed');
  const tokenDoc = key => find(scene().tokens, key, 'token');
  const origin = () => { const d = canvas.dimensions; const o = canvas.grid.getOffset({ x: d.sceneX + 1, y: d.sceneY + 1 }); return { i: o.i, j: o.j }; };
  const colName = c => { let s = '', n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const label = (col, row) => `${colName(col)}${row + 1}`;
  const parseCell = s => { const m = String(s).trim().toUpperCase().match(/^([A-Z]+)\s*(\d+)$/); if (!m) err(`bad cell label ${s}`); let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { col: c - 1, row: Number(m[2]) - 1 }; };
  const cellOf = (x, y) => { const o = canvas.grid.getOffset({ x: x + 1, y: y + 1 }), z = origin(); const col = o.j - z.j, row = o.i - z.i; return { col, row, cell: label(col, row) }; };
  // Cosmere "derived" values expose .value (override if useOverride, else derived + bonus).
  const res = (a, k) => { const r = a?.system?.resources?.[k]; return r ? { value: r.value, max: r.max?.value ?? null } : null; };
  const statuses = a => [...(a?.statuses ?? [])];
  const injuries = a => (a?.items ?? []).filter(i => i.type === 'injury').map(i => i.name);
  const DISP = { [-2]: 'secret', [-1]: 'hostile', 0: 'neutral', 1: 'friendly' };
  // Cosmere Advanced Encounters keeps per-combatant action state in flags (remaining/max per action group, movement left).
  const aeInfo = cb => {
    const f = cb.flags?.['cosmere-advanced-encounters']; if (!f) return {};
    const g = (f.actionsAvailableGroups ?? []).map(x => `${x.remaining}/${x.max}${x.name !== 'base' ? ' ' + x.name : ''}`).join(', ');
    let r; try { r = (cb.reactionsAvailable ?? []).map(x => `${x.remaining}/${x.max}`).join(', '); } catch { r = undefined; }
    return { actions: g || undefined, reactions: r || undefined, moveLeft: f.remainingMovementFromLastAction?.walk ?? undefined };
  };

  // ---------------------------------------------------------------- board state
  function board({ includeHidden = true } = {}) {
    const s = scene();
    const tokens = s.tokens.filter(t => includeHidden || !t.hidden).map(t => {
      const a = t.actor;
      return {
        id: t.id, name: t.name, actorId: a?.id ?? null, type: a?.type ?? null, role: a?.system?.role ?? undefined,
        disposition: DISP[t.disposition], ...cellOf(t.x, t.y), size: t.width, elevation: t.elevation || undefined, hidden: t.hidden || undefined,
        owners: a ? game.users.filter(u => !u.isGM && a.testUserPermission(u, 'OWNER')).map(u => u.name) : [],
        hp: res(a, 'hea'), focus: res(a, 'foc'), inv: res(a, 'inv')?.max ? res(a, 'inv') : undefined,
        deflect: a?.system?.deflect?.value || undefined,
        def: a ? { phy: a.system.defenses.phy.value, cog: a.system.defenses.cog.value, spi: a.system.defenses.spi.value } : undefined,
        conditions: statuses(a), injuries: injuries(a).length ? injuries(a) : undefined,
        recover: a?.type === 'character' ? (recoverUsed(a) ? 'used' : 'available') : undefined
      };
    });
    return { scene: sceneInfo(s), pieces: tokens, combat: combatState(), activeUsers: game.users.filter(u => u.active).map(u => `${u.name}${u.isGM ? ' (GM)' : ''}${u.viewedScene === s.id ? '' : ' [elsewhere]'}`) };
  }
  function sceneInfo(s = scene()) {
    return { id: s.id, name: s.name, navName: s.navName, active: s.active, grid: { type: s.grid.type, size: s.grid.size, distance: s.grid.distance, units: s.grid.units },
      cols: Math.ceil(s.dimensions.sceneWidth / s.grid.size), rows: Math.ceil(s.dimensions.sceneHeight / s.grid.size), walls: s.walls.size, lights: s.lights.size,
      coords: ({ 1: 'hidden', 2: 'edges', 3: 'every cell' })[s.getFlag('map-coords', 'coordinate-state')] ?? 'unset' };
  }

  // ---------------------------------------------------------------- combat (Cosmere fast/slow activations)
  // Turn order: fast PCs, fast NPCs, slow PCs, slow NPCs. Bosses appear twice (a fast clone + the slow original).
  // Per-combatant flags: cosmere-rpg.turnSpeed ('fast'|'slow', default slow), .activated, .bossFastActivated.
  function combatState() {
    const c = game.combat; if (!c) return null;
    return {
      id: c.id, started: c.started, round: c.round, turnIndex: c.turn,
      current: c.combatant ? { name: c.combatant.name, tokId: c.combatant.tokenId, speed: c.combatant.turnSpeed } : null,
      order: c.turns.map((cb, i) => ({ i, name: cb.name, tokId: cb.tokenId, pc: cb.actor?.type === 'character', speed: cb.turnSpeed, boss: cb.isBoss || undefined,
        activated: (cb.turnSpeed === 'fast' && cb.isBoss ? cb.getFlag(SYS, 'bossFastActivated') : cb.getFlag(SYS, 'activated')) || false, defeated: cb.defeated || undefined, ...aeInfo(cb) }))
    };
  }
  async function setTurnSpeed(key, speed) {
    const c = game.combat ?? err('no combat');
    const cb = c.combatants.find(x => x.tokenId === tokenDoc(key).id) ?? err('token not in combat');
    if (cb.turnSpeed !== speed) await cb.toggleTurnSpeed();
    return combatState();
  }
  async function markActivated(key, { bossFast = false } = {}) {
    const c = game.combat ?? err('no combat');
    const cb = c.combatants.find(x => x.tokenId === tokenDoc(key).id) ?? err('token not in combat');
    await cb.markActivated(bossFast); return combatState();
  }
  /** Start a combatant's turn. With Cosmere Advanced Encounters this sets the current turn and refreshes its actions (3 base, fewer if a condition says so).
   *  Untested for bosses' cloned fast turn. Without the module, falls back to the system's markActivated. */
  async function startTurn(key, { bossFast = false } = {}) {
    const c = game.combat ?? err('no combat');
    const id = tokenDoc(key).id;
    const cb = c.turns.find(x => x.tokenId === id && (!x.isBoss || (bossFast ? x.turnSpeed === 'fast' : x.turnSpeed !== 'fast'))) ?? c.combatants.find(x => x.tokenId === id) ?? err('token not in combat');
    if (typeof c.setCurrentTurnFromCombatant === 'function') {
      await c.setCurrentTurnFromCombatant(cb);
      // Advanced Encounters refreshes actions from an async hook that nobody awaits (and skips it when the turn index
      // doesn't change), so a turn could start with last round's spent actions. Let the hook settle, then refresh
      // explicitly: onTurnStart is idempotent (fresh actions/reactions, then conditions applied).
      const real = c.combatants.get(cb.id) ?? cb;
      if (typeof real.onTurnStart === 'function') { await new Promise(r => setTimeout(r, 250)); await real.onTurnStart(); }
    } else await cb.markActivated(bossFast);
    return combatState();
  }
  /** End the current turn. With Advanced Encounters: clears the current turn and marks that combatant as having acted. */
  async function endTurn() { const c = game.combat ?? err('no combat'); await c.nextTurn(); return combatState(); }
  async function nextTurn() { const c = game.combat ?? err('no combat'); await c.nextTurn(); return combatState(); }
  async function nextRound() { const c = game.combat ?? err('no combat'); await c.nextRound(); return combatState(); }
  /** Create a combat on the viewed scene from token keys (or all non-hidden tokens) and start it. */
  async function startCombat(keys) {
    const tds = keys ? keys.map(tokenDoc) : scene().tokens.filter(t => !t.hidden).contents;
    const c = game.combat?.scene?.id === scene().id ? game.combat : await Combat.create({ scene: scene().id, active: true });
    const have = new Set(c.combatants.map(x => x.tokenId));
    await c.createEmbeddedDocuments('Combatant', tds.filter(t => !have.has(t.id)).map(t => ({ tokenId: t.id, sceneId: scene().id, actorId: t.actorId, hidden: t.hidden })));
    if (!c.started) await c.startCombat();
    return combatState();
  }
  /** End the combat. The fight was the scene, so once-per-scene options (Recover) reset; pass {newScene:false} to keep them. */
  async function endCombat({ newScene: reset = true } = {}) {
    const c = game.combat ?? err('no combat'); await c.delete();
    return { ended: true, recoverReset: reset ? (await newScene()).reset : undefined };
  }

  // ---------------------------------------------------------------- movement
  /** Move a token to {col,row}. Refuses if a movement wall blocks the straight line, unless ignoreWalls. */
  async function moveToken(key, col, row, opts = {}) {
    if (typeof col === 'string') { opts = (row && typeof row === 'object') ? row : opts; ({ col, row } = parseCell(col)); }
    const { ignoreWalls = false, animate = true } = opts;
    const td = tokenDoc(key), T = td.object, z = origin();
    const dest = canvas.grid.getTopLeftPoint({ i: row + z.i, j: col + z.j });
    const half = { x: (td.width * canvas.grid.sizeX) / 2, y: (td.height * canvas.grid.sizeY) / 2 };
    const to = { x: dest.x + half.x, y: dest.y + half.y };
    const from = cellOf(td.x, td.y);
    if (!ignoreWalls && T.checkCollision(to, { origin: T.center, type: 'move', mode: 'any' })) return { moved: false, reason: 'a wall blocks the straight path; give waypoints or ignoreWalls', from, to: { col, row, cell: label(col, row) } };
    const dist = canvas.grid.measurePath([T.center, to]).distance;
    // v13 movement API: animates, records movement history, and lets Advanced Encounters spend a Move action.
    if (animate) await td.move([{ x: dest.x, y: dest.y }], { method: 'api' }); else await td.update({ x: dest.x, y: dest.y }, { animate: false });
    // move() resolves before the document reaches the destination (animation); wait so callers see the final position.
    for (let i = 0; i < 50 && (td.x !== dest.x || td.y !== dest.y); i++) await new Promise(r => setTimeout(r, 100));
    if (td.x !== dest.x || td.y !== dest.y) return { moved: false, reason: 'movement did not complete (blocked or constrained by Foundry)', from, to: { col, row, cell: label(col, row) }, now: cellOf(td.x, td.y).cell };
    return { moved: true, piece: td.name, from, to: { col, row, cell: label(col, row) }, distance: dist, units: scene().grid.units };
  }
  /** Move along waypoints ([[col,row],...] or ['C7','D8',...]), checking walls on each leg. */
  async function moveTokenPath(key, cells, opts = {}) {
    let last; for (const p of cells) { last = Array.isArray(p) ? await moveToken(key, p[0], p[1], opts) : await moveToken(key, p, opts); if (!last.moved) return last; }
    return last;
  }
  function distance(keyA, keyB) {
    const A = tokenDoc(keyA).object, B = tokenDoc(keyB).object;
    return { from: A.name, to: B.name, distance: canvas.grid.measurePath([A.center, B.center]).distance, units: scene().grid.units };
  }

  // ---------------------------------------------------------------- line of sight
  /** Foundry wall checks (sight walls) from A's center to B's center and B's four inner corners. */
  function los(keyA, keyB) {
    const A = tokenDoc(keyA).object, B = tokenDoc(keyB).object;
    const backend = CONFIG.Canvas.polygonBackends.sight;
    const blocked = d => backend.testCollision(A.center, d, { type: 'sight', mode: 'any' });
    const b = B.bounds, k = 2;
    const corners = [{ x: b.left + k, y: b.top + k }, { x: b.right - k, y: b.top + k }, { x: b.left + k, y: b.bottom - k }, { x: b.right - k, y: b.bottom - k }];
    const visibleCorners = corners.filter(c => !blocked(c)).length;
    const centerClear = !blocked(B.center);
    return { from: A.name, to: B.name, centerClear, visibleCorners, verdict: centerClear && visibleCorners === 4 ? 'clear' : (centerClear || visibleCorners) ? 'partial (consider cover)' : 'blocked',
      distance: canvas.grid.measurePath([A.center, B.center]).distance, units: scene().grid.units };
  }

  // ---------------------------------------------------------------- rolls
  const ADV = { advantage: 'advantage', disadvantage: 'disadvantage' };
  /** Skill test through the system (posts the normal Cosmere chat card). opts: {advantage|disadvantage: true, plotDie: true, dc, rollMode, attribute} */
  async function rollSkill(actorOrToken, skill, opts = {}) {
    const a = canvas?.scene?.tokens.find(t => t.id === actorOrToken || lc(t.name) === lc(actorOrToken))?.actor ?? find(game.actors, actorOrToken, 'actor');
    if (!a.system.skills?.[skill]) err(`unknown skill id ${skill}; ids: ${Object.keys(a.system.skills).join(',')}`);
    const before = game.messages.contents.at(-1)?.id;
    await a.rollSkill(skill, { configurable: false, advantageMode: opts.advantage ? ADV.advantage : opts.disadvantage ? ADV.disadvantage : undefined, plotDie: !!opts.plotDie, rollMode: opts.rollMode, attribute: opts.attribute });
    const msg = game.messages.contents.at(-1);
    return msg && msg.id !== before ? summarize(msg, opts.dc) : { note: 'no new chat message; check the chat log' };
  }
  /** Use an action/item (attack, ability) through the system's item.use(): posts its chat card with test + damage.
   *  Resource costs are NOT auto-consumed (shouldConsume:false avoids a dialog); deduct focus/inv with setResource. */
  /** Resolve what to use for an item name. PC weapons ('Longbow', or 'Strike: Longbow') attack through the weapon's
   *  ephemeral strike action (item.strikeAction); using the weapon item itself posts no attack. NPC actions resolve as-is. */
  function usableOf(a, itemName) {
    const n = lc(itemName).replace(/^strike:\s*/, '');
    const weapons = a.items.filter(i => i.type === 'weapon');
    const weapon = weapons.find(i => i.id === itemName || lc(i.name) === n) ?? null;
    let item = weapon;
    if (!item) { try { item = find(a.items, itemName, 'item'); } catch (e) { item = weapons.find(i => lc(i.name).includes(n)) ?? null; if (!item) throw e; } }
    let strike = null;
    if (item.type === 'weapon') { try { strike = item.strikeAction; } catch { strike = null; } }
    return { item, use: strike ?? item };
  }
  async function rollItem(actorOrToken, itemName, opts = {}) {
    const a = canvas?.scene?.tokens.find(t => t.id === actorOrToken || lc(t.name) === lc(actorOrToken))?.actor ?? find(game.actors, actorOrToken, 'actor');
    const { use: item } = usableOf(a, itemName);
    const before = game.messages.contents.at(-1)?.id;
    await item.use({ actor: a, configurable: false, advantageMode: opts.advantage ? ADV.advantage : opts.disadvantage ? ADV.disadvantage : undefined, plotDie: !!opts.plotDie, rollMode: opts.rollMode, shouldConsume: false });
    const after = game.messages.contents; const i = after.findIndex(m => m.id === before);
    return after.slice(i + 1).map(m => summarize(m, opts.dc));
  }
  /** Any formula (e.g. damage, plot die "1dp"). */
  async function roll(formula, { speaker, flavor, rollMode } = {}) {
    const r = await new Roll(formula).evaluate();
    const msg = await r.toMessage({ speaker: speakerFor(speaker), flavor }, { rollMode });
    return summarize(msg);
  }
  function summarize(m, dc) {
    const rolls = (m.rolls ?? []).map(r => ({
      formula: r.formula, total: r.total,
      dice: r.dice.map(d => ({ die: d.constructor.DENOMINATION === 'p' ? 'plot' : `d${d.faces}`,
        results: d.results.map(x => (x.discarded || x.active === false) ? `(${x.result})` : x.result),
        opportunity: d.rolledOpportunity || undefined, complication: d.rolledComplication || undefined }))
    }));
    const d20 = rolls[0]?.dice.find(d => d.die === 'd20')?.results.find(x => typeof x === 'number');
    const opp = rolls.some(r => r.dice.some(d => d.opportunity)) || d20 === 20;
    const comp = rolls.some(r => r.dice.some(d => d.complication)) || d20 === 1;
    return { id: m.id, by: m.author?.name, speaker: m.speaker?.alias, flavor: (m.flavor ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined,
      text: !m.rolls?.length ? (m.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : undefined,
      rolls: rolls.length ? rolls : undefined, opportunity: opp || undefined, complication: comp || undefined,
      vsDC: dc != null && rolls[0] ? (rolls[0].total >= dc ? `success (${rolls[0].total} vs ${dc})` : `failure (${rolls[0].total} vs ${dc})`) : undefined,
      whisper: m.whisper?.length ? true : undefined };
  }
  /** Recent chat with rolls (newest last). playersOnly filters out GM-authored messages. sinceId: only after that message. */
  function lastRolls(n = 5, { playersOnly = false, sinceId } = {}) {
    let ms = game.messages.contents;
    if (sinceId) ms = ms.slice(ms.findIndex(m => m.id === sinceId) + 1);
    return ms.filter(m => m.rolls?.length && (!playersOnly || !m.author?.isGM)).slice(-n).map(m => summarize(m));
  }
  function lastChat(n = 10, { sinceId } = {}) {
    let ms = game.messages.contents;
    if (sinceId) ms = ms.slice(ms.findIndex(m => m.id === sinceId) + 1);
    return ms.slice(-n).map(m => summarize(m));
  }

  // ---------------------------------------------------------------- chat
  function speakerFor(who) {
    if (!who) return ChatMessage.getSpeaker({ user: game.user });
    const t = canvas?.scene?.tokens.find(t => t.id === who || lc(t.name) === lc(who));
    if (t) return ChatMessage.getSpeaker({ token: t });
    const a = game.actors.get(who) ?? game.actors.find(a => lc(a.name) === lc(who));
    if (a) return ChatMessage.getSpeaker({ actor: a });
    return { alias: who };
  }
  /** Post as a speaker. mode: 'ic' | 'ooc' | 'emote' | 'whisper-gm'. whisperTo: user name(s). */
  async function say(who, html, { mode = 'ic', whisperTo } = {}) {
    const style = mode === 'ooc' ? CONST.CHAT_MESSAGE_STYLES.OOC : mode === 'emote' ? CONST.CHAT_MESSAGE_STYLES.EMOTE : CONST.CHAT_MESSAGE_STYLES.IC;
    const data = { speaker: speakerFor(who), content: html, style };
    if (mode === 'whisper-gm') data.whisper = ChatMessage.getWhisperRecipients('GM').map(u => u.id);
    if (whisperTo) data.whisper = [].concat(whisperTo).map(n => game.users.getName(n)?.id).filter(Boolean);
    const m = await ChatMessage.create(data);
    return { id: m.id, speaker: m.speaker.alias, whisper: !!data.whisper };
  }

  // ---------------------------------------------------------------- actor state
  async function damage(key, amount, type) {
    const a = tokenDoc(key).actor; const before = res(a, 'hea');
    await a.applyDamage([{ amount, type }], {});
    return { piece: a.name, type: type ?? 'untyped', hp: { before: before.value, after: res(a, 'hea').value, max: before.max } };
  }
  async function heal(key, amount) {
    const a = tokenDoc(key).actor; const before = res(a, 'hea');
    await a.applyHealing(amount); // system: applyDamage with type 'heal'
    return { piece: a.name, hp: { before: before.value, after: res(a, 'hea').value, max: before.max } };
  }
  async function setResource(key, res_, value) {
    const a = tokenDoc(key).actor; await a.update({ [`system.resources.${res_}.value`]: value }); return { piece: a.name, [res_]: res(a, res_) };
  }
  /** Toggle a condition by status id (see CONFIG.statusEffects ids, e.g. 'prone', 'surprised'). */
  async function setCondition(key, statusId, active = true) {
    if (!CONFIG.statusEffects.some(s => s.id === statusId)) err(`unknown status ${statusId}`);
    const td = tokenDoc(key); await td.actor.toggleStatusEffect(statusId, { active });
    return { piece: td.name, conditions: statuses(td.actor) };
  }
  /** Map Coordinates display for the viewed scene: 'hidden' | 'edges' | 'cells'. Shared with players (scene flag). */
  async function showCoords(mode = 'edges', s = scene()) { const v = { hidden: 1, edges: 2, cells: 3 }[mode] ?? err(`mode ${mode}`); await s.setFlag('map-coords', 'coordinate-state', v); if (canvas?.scene?.id === s.id) await canvas.draw(); return { coords: mode }; }
  async function setHidden(key, hidden = true) { const td = tokenDoc(key); await td.update({ hidden }); return { piece: td.name, hidden }; }
  // Hand an actor to the players or back to the GM. who: 'player' (all non-GM users become OWNER), 'gm' (non-GM users get
  // `othersLevel`, default OBSERVER: they can see the sheet but not act), or a user name/id (that user OWNER, other players
  // `othersLevel`). Linked tokens follow the actor. Returns who owns and who observes afterwards.
  async function setControl(key, who = 'player', { othersLevel = 'OBSERVER' } = {}) {
    const a = find(game.actors, key, 'actor');
    const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    if (!(othersLevel in L)) err(`othersLevel must be one of ${Object.keys(L).join(', ')}`);
    const players = game.users.filter(u => !u.isGM);
    const takers = who === 'gm' ? [] : who === 'player' ? players : [find(game.users, who, 'user')];
    const own = {};
    for (const u of players) own[u.id] = takers.includes(u) ? L.OWNER : L[othersLevel];
    await a.update({ ownership: own });
    const at = lvl => players.filter(u => a.ownership[u.id] === L[lvl]).map(u => u.name);
    return { actor: a.name, owners: at('OWNER'), observers: at('OBSERVER'), limited: at('LIMITED') };
  }

  // ---------------------------------------------------------------- once-per-scene options (Recover)
  // Recover (2 actions, once per scene) is tracked as an actor flag. It is marked automatically when the system's
  // 'recover' action is used (GM-side hook, or the chat card a player's use posts), cleared by GM.endCombat() and
  // GM.newScene(), and can be set by hand with GM.markRecover(). GM.turn() and perceptionFor show it.
  const MOD = 'claude-gm-tools';
  const recoverUsed = a => !!a?.getFlag?.(MOD, 'recoverUsed');
  async function markRecover(key, used = true) {
    const a = canvas?.scene?.tokens.find(t => t.id === key || lc(t.name) === lc(key))?.actor ?? find(game.actors, key, 'actor');
    if (used) await a.setFlag(MOD, 'recoverUsed', true); else await a.unsetFlag(MOD, 'recoverUsed');
    return { actor: a.name, recover: used ? 'used this scene' : 'available' };
  }
  /** A new scene starts: every character's once-per-scene options (Recover) are available again. */
  async function newScene() {
    const reset = [];
    for (const a of game.actors.filter(x => recoverUsed(x))) { await a.unsetFlag(MOD, 'recoverUsed'); reset.push(a.name); }
    return { reset };
  }

  // ---------------------------------------------------------------- endeavors (scripts/endeavors.js) and event feed (scripts/event-log.js)
  const EN = () => globalThis.ClaudeGMEndeavors ?? err('endeavor tracker not loaded');
  /** Start an endeavor: successes needed before failures allowed, e.g. (3/2). show: visible to players (default true). */
  const endeavor = (title, successes, failures, opts) => EN().create(title, successes, failures, opts);
  /** kind: 'success' | 'failure' (adds n), or {successes, failures} to set values. Returns {successes:'2/3', failures:'1/2', result}. */
  const endeavorMark = (title, kind, n) => EN().mark(title, kind, n);
  const endeavorState = title => EN().state(title);
  const endeavorShow = (title, show = true) => EN().show(title, show);
  const endeavorEnd = title => EN().end(title);
  /** Events since a sequence number (rolls, chat, moves, resources, conditions, combat, targets). Remember .seq of the last one. */
  const events = (since = 0) => globalThis.ClaudeGMEvents?.since(since) ?? err('event feed not loaded');
  const eventsLast = (n = 20) => globalThis.ClaudeGMEvents?.last(n) ?? err('event feed not loaded');
  // ---------------------------------------------------------------- scenes and audio
  async function viewScene(key) { const s = find(game.scenes, key, 'scene'); await s.view(); return sceneInfo(s); }
  /** Make a scene active for everyone. navName: label players see in the navigation bar (default stays neutral). */
  async function activateScene(key, { navName, coords } = {}) {
    const s = find(game.scenes, key, 'scene');
    if (navName !== undefined) await s.update({ navName });
    if (coords) await s.setFlag('map-coords', 'coordinate-state', { hidden: 1, edges: 2, cells: 3 }[coords]); // set before players load the scene
    await s.activate(); return { active: s.name, playersSee: s.navName || '(no label)' };
  }
  async function playPlaylist(key, { sound } = {}) {
    const p = find(game.playlists, key, 'playlist');
    if (sound) { const snd = find(p.sounds, sound, 'sound'); await p.playSound(snd); return { playing: `${p.name} / ${snd.name}` }; }
    await p.playAll(); return { playing: p.name };
  }
  async function stopPlaylist(key) {
    if (!key) { for (const p of game.playlists.playing) await p.stopAll(); return { stopped: 'all' }; }
    const p = find(game.playlists, key, 'playlist'); await p.stopAll(); return { stopped: p.name };
  }
  const nowPlaying = () => game.playlists.playing.map(p => ({ playlist: p.name, sounds: p.sounds.filter(s => s.playing).map(s => s.name) }));

  // ---------------------------------------------------------------- session checks
  const ver = s => String(s).split('.').map(Number); // arrays avoid an output filter that mangles dotted version strings
  function info() {
    return { gmApi: ver(V), module: ver(game.modules.get('claude-gm-tools')?.version ?? '0'), foundry: ver(game.version), system: { id: game.system.id, v: ver(game.system.version) }, world: game.world.id, user: game.user.name, isGM: game.user.isGM,
      counts: { scenes: game.scenes.size, actors: game.actors.size, journals: game.journal.size, playlists: game.playlists.size, items: game.items.size, macros: game.macros.size },
      activeScene: game.scenes.active ? { id: game.scenes.active.id, navName: game.scenes.active.navName } : null, viewing: canvas?.scene?.id ?? null,
      users: game.users.map(u => ({ name: u.name, role: u.role, active: u.active })),
      playerVisible: { journals: game.journal.filter(j => j.ownership.default > 0).length, actors: game.actors.filter(a => a.ownership.default > 0).length, scenes: game.scenes.filter(s => s.ownership.default > 0).length } };
  }
  const modules = () => [...game.modules].map(m => ({ id: m.id, v: ver(m.version), active: m.active }));

  const api = { V, info, modules, board, sceneInfo, combatState, startCombat, endCombat, setTurnSpeed, markActivated, startTurn, endTurn, nextTurn, nextRound,
    moveToken, moveTokenPath, distance, los, label, parseCell, showCoords, rollSkill, rollItem, roll, lastRolls, lastChat, say,
    damage, heal, setResource, setCondition, setHidden, setControl, markRecover, newScene, endeavor, endeavorMark, endeavorState, endeavorShow, endeavorEnd, viewScene, activateScene, playPlaylist, stopPlaylist, nowPlaying, events, eventsLast, _find: find, _cellAt: cellOf, _usableOf: usableOf, _recoverUsed: recoverUsed };
  Hooks.once('ready', () => {
    if (!game.user.isGM) return;
    window.GM = api;
    const m = game.modules.get('claude-gm-tools'); if (m) m.api = { ...(m.api ?? {}), gm: api };
    // Mark Recover as used when anyone (player or GM) uses the system's 'recover' action: its chat card carries the item.
    Hooks.on('createChatMessage', async msg => {
      if (!game.user.isActiveGM) return;
      const uuid = msg.flags?.['cosmere-rpg']?.message?.item; if (!uuid) return;
      let it = null; try { it = fromUuidSync(uuid); } catch { return; }
      if (it?.system?.id !== 'recover') return;
      const a = it.actor ?? it.parent;
      if (a?.documentName === 'Actor' && !recoverUsed(a)) await a.setFlag(MOD, 'recoverUsed', true);
    });
  });
})();
