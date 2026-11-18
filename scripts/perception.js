// Claude GM Tools: per-token perception and intent checking (Foundry v13, Cosmere RPG 3.x).
//   GM.perceptionFor(tokenKey, opts) -> what ONE token's character can perceive right now, using Foundry's own vision,
//       lighting and detection-mode checks evaluated for that token alone (not the GM's view): self state, the
//       creatures it can currently see, allies, nearby terrain/doors it can see, and a small ASCII map centered on it.
//       Hidden tokens and secret doors are never included. `text` is a compact rendering to hand to a player agent.
//   GM.checkIntent(tokenKey, intent) -> GM-side legality check of a declared turn (move, actions, targets) before the GM
//       carries it out. This output is for the GM only (it may mention things the character can't perceive).
// Logic only: no campaign or adventure content lives in this module.
(() => {
  const SYS = 'cosmere-rpg';
  const err = msg => { throw new Error(`[GM] ${msg}`); };
  const lc = s => String(s ?? '').toLowerCase();

  // Basic actions and their action costs (Stormlight Handbook ch. 10). Used for listing and for intent checks.
  const BASIC = { strike: 1, move: 1, disengage: 1, brace: 1, 'gain advantage': 1, interact: 1, 'use a skill': 1, ready: 1,
    grapple: 2, shove: 2, recover: 2, 'breathe stormlight': 2, enhance: 1, mount: 2, dismount: 2, reload: 1 };
  // Statuses another creature could plausibly notice by looking.
  const VISIBLE_STATUS = new Set(['prone', 'restrained', 'immobilized', 'unconscious', 'dead', 'stunned', 'flying', 'burrowing', 'enhanced']);

  const T = () => globalThis.GM ?? err('GM API not loaded');
  const tokenOf = key => { const td = T()._find(canvas.scene.tokens, key, 'token'); return td.object ?? err(`token ${td.name} is not drawn on the viewed scene`); };
  const gs = () => canvas.grid.size;
  const units = () => canvas.scene.grid.units || 'ft';
  const cellAt = (x, y) => T()._cellAt(x, y);
  const centerOfCell = (col, row) => {
    const z = canvas.dimensions; const o = canvas.grid.getOffset({ x: z.sceneX + 1, y: z.sceneY + 1 });
    return canvas.grid.getCenterPoint({ i: o.i + row, j: o.j + col });
  };
  const parseCellArg = c => (typeof c === 'string' ? T().parseCell(c) : c);
  // Cells a token occupies (square grids).
  const occupied = (t, at) => {
    const base = at ?? cellAt(t.document.x, t.document.y); const w = Math.max(1, Math.round(t.document.width)), h = Math.max(1, Math.round(t.document.height));
    const out = []; for (let dc = 0; dc < w; dc++) for (let dr = 0; dr < h; dr++) out.push({ col: base.col + dc, row: base.row + dr });
    return out;
  };
  const pathDist = (a, b) => canvas.grid.measurePath([a, b]).distance;
  // Nearest-cell distance between two sets of cells (respects the scene's diagonal rule).
  const cellsDist = (A, B) => { let m = Infinity; for (const a of A) for (const b of B) m = Math.min(m, pathDist(centerOfCell(a.col, a.row), centerOfCell(b.col, b.row))); return m; };
  const DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  const dir = (from, to) => { const dx = to.x - from.x, dy = to.y - from.y; if (!dx && !dy) return 'here'; return DIRS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]; };
  const blocks = (a, b, type = 'move') => CONFIG.Canvas.polygonBackends[type].testCollision(a, b, { type, mode: 'any' });
  const res = (a, k) => { const r = a?.system?.resources?.[k]; return r ? { value: r.value, max: r.max?.value ?? null } : null; };
  const hpWord = a => {
    const r = res(a, 'hea'); if (!r?.max) return undefined;
    const f = r.value / r.max;
    return f >= 1 ? 'unhurt' : f > 0.5 ? 'lightly wounded' : f > 0.25 ? 'badly wounded' : f > 0 ? 'near collapse' : 'down';
  };
  const cost = c => (!c ? null : c.type === 'act' ? `${c.value ?? 1} action${(c.value ?? 1) === 1 ? '' : 's'}` : c.type === 'rea' ? 'reaction' : c.type === 'fre' ? 'free' : 'special');

  // ------------------------------------------------------------- vision for one token (Foundry's checks, detached source)
  function viewerFor(t) {
    const vis = canvas.visibility;
    if (!vis.tokenVision) return { mode: 'scene has token vision off: everything is visible', see: () => 'no-vision-scene', seePoint: () => true, done() {} };
    if (!t.hasSight) return { mode: 'token has no sight configured: sees nothing', warn: true, see: () => false, seePoint: () => false, done() {} };
    // A PointVisionSource built from the token's own data but never attached to the canvas, so it affects no one's view.
    const vs = new CONFIG.Canvas.visionSourceClass({ sourceId: `${t.sourceId}.claudePerception`, object: t });
    const bl = t._getVisionBlindedStates(); for (const k in bl) vs.blinded[k] = bl[k];
    vs.initialize(t._getVisionSourceData());
    const modes = CONFIG.Canvas.detectionModes, dmodes = t.document.detectionModes ?? [];
    // Mirrors CanvasVisibility#testVisibility, restricted to this one vision source.
    const run = (point, object, tolerance) => {
      const cfg = vis._createVisibilityTestConfig(point, { tolerance, object });
      for (const ls of canvas.effects.lightSources) if (ls.data.vision && ls.active && ls.testVisibility(cfg) === true) return 'vision light';
      if (!vs.isBlinded) {
        const b = dmodes.find(m => m.id === 'basicSight'); if (b && modes.basicSight.testVisibility(vs, b, cfg) === true) return 'sight';
        const l = dmodes.find(m => m.id === 'lightPerception'); if (l && modes.lightPerception.testVisibility(vs, l, cfg) === true) return 'sight';
      }
      if (!(object instanceof foundry.canvas.placeables.Token)) return false;
      for (const m of dmodes) {
        if (m.id === 'basicSight' || m.id === 'lightPerception') continue;
        if (modes[m.id]?.testVisibility(vs, m, cfg) === true) return m.id;
      }
      return false;
    };
    return {
      mode: `${vs.data.visionMode}${vs.isBlinded ? ' (blinded)' : ''}, sight ${t.document.sight.range || 0} ${units()}`,
      see: o => { const { width, height } = o.document.getSize(); return run(o.center, o, Math.min(width, height) / 4); },
      seePoint: p => run(p, null, 2) !== false,
      done() { try { vs.destroy(); } catch { /* detached source */ } }
    };
  }

  // ------------------------------------------------------------- weapons and actions
  const dmgText = w => {
    const d = w.system.damage, st = w.system.strike;
    if (d?.formula) return `${d.formula} ${d.type ?? ''}`.trim();
    const die = st?.die; if (!die) return undefined;
    return `${typeof die === 'object' ? `${die.count ?? 1}${die.size ?? ''}` : die} ${st.damageType ?? ''}`.trim();
  };
  function weaponsOf(a) {
    const ws = a.items.filter(i => i.type === 'weapon');
    const eq = ws.filter(i => i.system.equipped); const list = eq.length ? eq : ws;
    return list.map(w => {
      const atk = w.system.attack ?? {}, tr = w.system.traits ?? {};
      const on = k => tr[k] && (tr[k].active ?? tr[k].defaultActive);
      const reachBonus = on('reach') ? (Number(tr.reach.value) || 5) : 0;
      const ranged = atk.type === 'ranged';
      const thrown = on('thrown');
      return { name: w.name, kind: ranged ? 'ranged' : 'melee', reach: ranged ? undefined : 5 + reachBonus,
        range: ranged || thrown ? { normal: atk.range?.value ?? (Number(tr.thrown?.value) || null), long: atk.range?.long ?? null } : undefined,
        damage: dmgText(w),
        skill: w.system.strike?.skill ?? undefined, traits: Object.keys(tr).filter(on) };
    });
  }
  function actionsOf(a) {
    return a.items.filter(i => i.type !== 'weapon' && i.system.activation?.cost?.type).map(i => {
      const u = i.system.activation?.uses ?? i.system.resources?.uses;
      return { name: i.name, cost: cost(i.system.activation.cost), uses: u?.max ? `${u.value ?? '?'}/${u.max}` : undefined };
    });
  }
  const combatantOf = t => game.combat?.combatants.find(c => c.tokenId === t.id) ?? null;
  const turnInfo = t => {
    const cs = T().combatState?.(); const row = cs?.order?.find(o => o.tokId === t.id);
    if (!row) return null;
    return { speed: row.speed, activated: row.activated, actions: row.actions, reactions: row.reactions, moveLeft: row.moveLeft, isCurrent: cs.current?.tokId === t.id, round: cs.round };
  };

  // ------------------------------------------------------------- ASCII map (cells + wall edges, only what it can see)
  function asciiMap(self, viewer, marks, radius) {
    if (!canvas.grid.isSquare) return { lines: ['(map only on square grids)'], legend: '' };
    const me = cellAt(self.document.x, self.document.y);
    const cols = Math.ceil(canvas.dimensions.sceneWidth / gs()), rows = Math.ceil(canvas.dimensions.sceneHeight / gs());
    const c0 = Math.max(0, me.col - radius), c1 = Math.min(cols - 1, me.col + radius), r0 = Math.max(0, me.row - radius), r1 = Math.min(rows - 1, me.row + radius);
    const seen = new Map(); const key = (c, r) => `${c},${r}`;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) seen.set(key(c, r), viewer.seePoint(centerOfCell(c, r)));
    // Walls near the window (secret doors render as plain wall; locked state is never shown).
    const p0 = centerOfCell(c0, r0), p1 = centerOfCell(c1, r1), pad = gs();
    const walls = canvas.scene.walls.filter(w => { const [x1, y1, x2, y2] = w.c; return Math.max(x1, x2) >= p0.x - pad && Math.min(x1, x2) <= p1.x + pad && Math.max(y1, y2) >= p0.y - pad && Math.min(y1, y2) <= p1.y + pad; });
    const W = CONST.WALL_MOVEMENT_TYPES ?? { NONE: 0 }, DOOR = CONST.WALL_DOOR_TYPES, DS = CONST.WALL_DOOR_STATES;
    const edge = (a, b) => {
      let ch = null;
      for (const w of walls) {
        const [x1, y1, x2, y2] = w.c;
        if (!foundry.utils.lineSegmentIntersects(a, b, { x: x1, y: y1 }, { x: x2, y: y2 })) continue;
        // Secret doors look like plain wall unless they stand open; locked doors look like any closed door.
        if (w.door === DOOR.DOOR || (w.door === DOOR.SECRET && w.ds === DS.OPEN)) { ch = w.ds === DS.OPEN ? (ch ?? '/') : 'D'; continue; }
        if (w.door === DOOR.SECRET) { ch = (ch === 'D') ? 'D' : '#'; continue; }
        else if (w.move !== W.NONE) ch = (ch === 'D') ? 'D' : '#';
        else if (w.sight) ch = ch ?? ':';
      }
      return ch;
    };
    // Difficult terrain from region behaviors (names are never shown).
    const slowCells = new Set();
    for (const reg of canvas.scene.regions ?? []) {
      if (!reg.behaviors?.some(b => !b.disabled && /movementcost|difficult/i.test(b.type))) continue;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const p = centerOfCell(c, r);
        try { if (reg.testPoint({ x: p.x, y: p.y, elevation: self.document.elevation })) slowCells.add(key(c, r)); } catch { /* region API differs */ }
      }
    }
    const lines = [];
    const header = ['   ']; for (let c = c0; c <= c1; c++) header.push(T().label(c, 0).replace(/\d+$/, '').padEnd(2).slice(0, 2)); lines.push(header.join(''));
    for (let r = r0; r <= r1; r++) {
      let row = String(r + 1).padStart(3), under = '   ';
      for (let c = c0; c <= c1; c++) {
        const s = seen.get(key(c, r)), here = centerOfCell(c, r);
        row += s ? (marks.get(key(c, r)) ?? (slowCells.has(key(c, r)) ? '~' : '.')) : ' ';
        // edge to the east and to the south, drawn only if one side is visible
        if (c < c1) { const s2 = seen.get(key(c + 1, r)); const e = (s || s2) ? edge(here, centerOfCell(c + 1, r)) : null; row += e ? (e === '#' ? '|' : e) : ' '; }
        if (r < r1) { const s2 = seen.get(key(c, r + 1)); const e = (s || s2) ? edge(here, centerOfCell(c, r + 1)) : null; under += (e ? (e === '#' ? '-' : e) : ' ') + ' '; }
      }
      lines.push(row.replace(/\s+$/, ''));
      if (r < r1 && under.trim()) lines.push(under.replace(/\s+$/, ''));
    }
    return { lines, legend: "@ you · a-z allies · 1-9 others · . open · ~ difficult · | - wall · D closed door · / open door · : see-through barrier · blank = can't see" };
  }

  // ------------------------------------------------------------- perceptionFor
  function perceptionFor(key, { radius = 6, known = [], map = true } = {}) {
    const self = tokenOf(key); const a = self.actor ?? err('token has no actor');
    const viewer = viewerFor(self);
    try {
      const me = cellAt(self.document.x, self.document.y); const meCells = occupied(self, me);
      const weapons = weaponsOf(a);
      const melee = weapons.filter(w => w.kind === 'melee'); const maxReach = Math.max(5, ...melee.map(w => w.reach));
      const knownSet = new Set(known.map(lc));
      const friendly = o => o.document.disposition === self.document.disposition && self.document.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY;
      const nameVisibleToPlayers = o => [CONST.TOKEN_DISPLAY_MODES.HOVER, CONST.TOKEN_DISPLAY_MODES.ALWAYS].includes(o.document.displayName);
      const allies = [], others = [], marks = new Map();
      marks.set(`${me.col},${me.row}`, '@');
      const others0 = canvas.tokens.placeables.filter(o => o !== self && !o.document.hidden && o.actor);
      for (const o of others0) {
        const how = viewer.see(o); const isAlly = friendly(o);
        if (!how && !isAlly) continue; // never list unseen non-allies
        const oc = cellAt(o.document.x, o.document.y); const oCells = occupied(o, oc);
        const d = cellsDist(meCells, oCells);
        const loe = !blocks(self.center, o.center, 'move');
        const entry = {
          cell: oc.cell, distance: d, direction: dir(self.center, o.center), seen: !!how || undefined,
          identity: (isAlly || nameVisibleToPlayers(o) || knownSet.has(lc(o.name))) ? o.name : `unknown ${o.document.width > 1 ? 'large ' : ''}creature`,
          looks: how ? hpWord(o.actor) : undefined,
          visibleConditions: how ? [...(o.actor.statuses ?? [])].filter(s => VISIBLE_STATUS.has(s)) : undefined,
          inReach: how ? (d <= maxReach && loe) : undefined,
          inRange: how ? Object.fromEntries(weapons.filter(w => w.range?.normal).map(w => [w.name, !loe ? 'no line of effect' : d <= w.range.normal ? 'yes' : (w.range.long && d <= w.range.long) ? 'long (disadvantage)' : 'no'])) : undefined,
          cover: how ? (T().los(self.id, o.id).verdict.startsWith('clear') ? 'none' : 'partial') : undefined
        };
        if (entry.inRange && !Object.keys(entry.inRange).length) delete entry.inRange;
        entry._cells = how ? oCells : [];
        (isAlly ? allies : others).push(entry);
      }
      allies.sort((x, y) => x.distance - y.distance); others.sort((x, y) => x.distance - y.distance);
      allies.forEach((e, i) => { e.label = String.fromCharCode(97 + (i % 26)); });
      others.forEach((e, i) => { e.label = String(i + 1); });
      for (const e of [...allies, ...others]) { for (const c of e._cells) marks.set(`${c.col},${c.row}`, e.label.length === 1 ? e.label : '+'); delete e._cells; }
      const mov = a.system.movement?.walk?.rate; const senses = a.system.senses?.range;
      const selfInfo = {
        name: a.name, cell: me.cell, size: self.document.width,
        health: res(a, 'hea'), focus: res(a, 'foc'), investiture: res(a, 'inv')?.max ? res(a, 'inv') : undefined,
        defenses: { physical: a.system.defenses?.phy?.value, cognitive: a.system.defenses?.cog?.value, spiritual: a.system.defenses?.spi?.value },
        deflect: a.system.deflect?.value || 0, movement: mov?.value ?? mov?.derived, senses: senses?.value ?? senses?.derived,
        conditions: [...(a.statuses ?? [])], injuries: a.items.filter(i => i.type === 'injury').map(i => i.name),
        turn: turnInfo(self), weapons, actions: actionsOf(a), basicActions: BASIC
      };
      const m = map ? asciiMap(self, viewer, marks, radius) : null;
      const out = { self: selfInfo, vision: viewer.mode, allies, creatures: others, map: m?.lines, legend: m?.legend };
      out.text = render(out);
      return out;
    } finally { viewer.done(); }
  }

  function render(p) {
    const s = p.self, L = [];
    const r = x => (x ? `${x.value}/${x.max}` : '-');
    L.push(`YOU: ${s.name} at ${s.cell}. Health ${r(s.health)}, focus ${r(s.focus)}${s.investiture ? `, Investiture ${r(s.investiture)}` : ''}. Defenses phy ${s.defenses.physical} / cog ${s.defenses.cognitive} / spi ${s.defenses.spiritual}, deflect ${s.deflect}. Move ${s.movement} ${units()} per Move action.`);
    if (s.conditions.length || s.injuries.length) L.push(`Conditions: ${[...s.conditions, ...s.injuries].join(', ')}`);
    if (s.turn) L.push(`Turn: ${s.turn.speed ?? '?'}${s.turn.actions ? `, actions left ${s.turn.actions}` : ''}${s.turn.reactions ? `, reactions ${s.turn.reactions}` : ''}${s.turn.moveLeft != null ? `, movement left ${s.turn.moveLeft}` : ''}${s.turn.activated ? ' (already acted this round)' : ''}`);
    for (const w of s.weapons) L.push(`Weapon: ${w.name} (${w.kind}${w.reach ? `, reach ${w.reach}` : ''}${w.range ? `, range ${w.range.normal}${w.range.long ? '/' + w.range.long : ''}` : ''}${w.damage ? `, ${w.damage}` : ''}${w.traits.length ? `, ${w.traits.join(' ')}` : ''})`);
    if (s.actions.length) L.push(`Abilities: ${s.actions.map(x => `${x.name} [${x.cost}${x.uses ? `, ${x.uses}` : ''}]`).join('; ')}`);
    L.push(`Basic actions: ${Object.entries(s.basicActions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    L.push(`Vision: ${p.vision}`);
    const line = e => `  ${e.label} ${e.identity} at ${e.cell}, ${e.distance} ${units()} ${e.direction}${e.seen === undefined ? ' (out of sight)' : ''}${e.looks ? `, ${e.looks}` : ''}${e.visibleConditions?.length ? `, ${e.visibleConditions.join(' ')}` : ''}${e.inReach ? ', IN REACH' : ''}${e.inRange ? `, in range: ${Object.entries(e.inRange).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}${e.cover && e.cover !== 'none' ? `, ${e.cover} cover` : ''}`;
    L.push(`Allies:${p.allies.length ? '' : ' none'}`); p.allies.forEach(e => L.push(line(e)));
    L.push(`Others you can see:${p.creatures.length ? '' : ' none'}`); p.creatures.forEach(e => L.push(line(e)));
    if (p.map) { L.push('Map:'); L.push(...p.map); L.push(p.legend); }
    return L.join('\n');
  }

  // ------------------------------------------------------------- checkIntent (GM-side)
  // intent: { speed: 'fast'|'slow', move: 'D8' | ['C7','D8'], actions: [{ name: 'Strike', with: 'Spear', target: 'E5' | name | id }, ...], focus: n }
  function checkIntent(key, intent = {}) {
    const self = tokenOf(key); const a = self.actor; const problems = [], notes = [];
    const ti = turnInfo(self);
    const budget = ti?.actions ? Number(String(ti.actions).split('/')[0]) : (intent.speed === 'fast' ? 2 : 3);
    if (ti?.activated && !ti.isCurrent) problems.push('already acted this round');
    if (ti && intent.speed && ti.speed && intent.speed !== ti.speed && ti.isCurrent) notes.push(`turn speed is set to ${ti.speed} in Foundry`);
    // movement
    let pos = cellAt(self.document.x, self.document.y), moveActions = 0, moved = 0;
    const rate = a.system.movement?.walk?.rate?.value ?? a.system.movement?.walk?.rate?.derived ?? 25;
    if (intent.move) {
      const legs = (Array.isArray(intent.move) ? intent.move : [intent.move]).map(parseCellArg);
      let from = pos;
      for (const to of legs) {
        const A = centerOfCell(from.col, from.row), B = centerOfCell(to.col, to.row);
        if (blocks(A, B, 'move')) problems.push(`path ${T().label(from.col, from.row)}→${T().label(to.col, to.row)} crosses a wall or closed door`);
        moved += pathDist(A, B); from = to;
      }
      const dest = from; const destLabel = T().label(dest.col, dest.row);
      const occ = canvas.tokens.placeables.filter(o => o !== self && occupied(o).some(c => c.col === dest.col && c.row === dest.row));
      if (occ.some(o => !o.document.hidden)) problems.push(`${destLabel} is occupied`);
      if (occ.some(o => o.document.hidden)) notes.push(`${destLabel} holds a hidden token (GM only)`);
      const left = ti?.moveLeft ?? 0;
      moveActions = Math.max(0, Math.ceil((moved - left) / rate));
      pos = { ...dest, cell: destLabel };
    }
    // actions
    const weapons = weaponsOf(a); const items = actionsOf(a);
    let spent = moveActions; const targets = [];
    for (const act of intent.actions ?? []) {
      const n = lc(act.name); let c = BASIC[n];
      const item = c == null ? items.find(i => lc(i.name) === n) ?? items.find(i => lc(i.name).includes(n)) : null;
      const weaponNamed = weapons.find(w => lc(w.name) === n || lc(w.name) === lc(act.with));
      if (c == null && item) c = item.cost === 'reaction' || item.cost === 'free' ? 0 : Number(item.cost?.split(' ')[0]) || 1;
      if (c == null && weaponNamed) c = 1;
      if (c == null) { problems.push(`unknown action "${act.name}"`); continue; }
      spent += c;
      if (act.target) {
        let tgt;
        try { const cell = /^[A-Za-z]+\d+$/.test(act.target) ? T().parseCell(act.target) : null; tgt = cell ? canvas.tokens.placeables.find(o => occupied(o).some(x => x.col === cell.col && x.row === cell.row)) : tokenOf(act.target); } catch { tgt = null; }
        if (!tgt) { problems.push(`target "${act.target}" not found`); continue; }
        if (tgt.document.hidden) problems.push(`target "${act.target}" is a hidden token`);
        const v = viewerFor(self); const seen = v.see(tgt); v.done();
        if (!seen) problems.push(`${self.name} cannot currently see the target`);
        const d = cellsDist(occupied(self, pos), occupied(tgt));
        const loe = !blocks(centerOfCell(pos.col, pos.row), tgt.center, 'move');
        const w = weaponNamed ?? (n === 'strike' ? weapons[0] : null);
        if (['strike', 'grapple', 'shove'].includes(n) || weaponNamed) {
          if (!loe) problems.push(`no line of effect to target from ${T().label(pos.col, pos.row)}`);
          if (w?.kind === 'ranged' || (w?.range && d > (w.reach ?? 5))) {
            if (!w.range?.normal || d > (w.range.long ?? w.range.normal)) problems.push(`target ${d} ${units()} away is out of range for ${w.name}`);
            else if (d > w.range.normal) notes.push(`${w.name} at long range: disadvantage`);
          } else if (d > (w?.reach ?? 5)) problems.push(`target ${d} ${units()} away is out of reach (${w?.reach ?? 5}) for ${w?.name ?? 'unarmed'}`);
        }
        targets.push({ target: tgt.name, distance: d, lineOfEffect: loe });
      }
    }
    if (spent > budget) problems.push(`needs ${spent} actions (${moveActions} for movement) but has ${budget}`);
    const foc = res(a, 'foc');
    if (intent.focus && foc && intent.focus > foc.value) problems.push(`spends ${intent.focus} focus but has ${foc.value}`);
    return { ok: problems.length === 0, problems, notes, plan: { budget, moveActions, actionCost: spent, moved, destination: pos.cell ?? T().label(pos.col, pos.row) }, targets };
  }

  Hooks.once('ready', () => {
    if (!game.user.isGM || !globalThis.GM) return;
    Object.assign(globalThis.GM, { perceptionFor, checkIntent });
  });
  globalThis.ClaudeGMPerception = { perceptionFor, checkIntent, viewerFor };
})();
