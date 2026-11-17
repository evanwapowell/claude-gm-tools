// Claude GM Tools: one-call table helpers built on window.GM (scripts/gm-api.js).
//   GM.turn()        -> everything the GM needs to read the board in one call (events since last call, scene, pieces,
//                       combat, endeavors, audio, who's online), as compact strings.
//   GM.npcTurn(spec) -> run a whole NPC turn: start turn, move, speak, attacks (roll, compare to defense, hit/graze/crit,
//                       apply damage), skill test, conditions, end turn. Returns a short log.
// Attack resolution follows the Stormlight Handbook: hit if the attack total >= the target's defense (weapon attacks ->
// Physical); on a miss the attacker may graze by spending 1 focus (damage dice only, no modifier); a hit plus an
// Opportunity can be a critical hit (dice maximized + modifier), never for minions. Deflect/immunities are applied by the
// system when damage is applied.
(() => {
  let lastSeq = 0;
  const hp = r => (r ? `${r.value}/${r.max}` : '?');

  function pieceLine(p) {
    const tags = [];
    if (p.owners?.length) tags.push(`PC:${p.owners.join('/')}`);
    else if (p.disposition) tags.push(p.disposition);
    if (p.role) tags.push(p.role);
    if (p.hidden) tags.push('HIDDEN');
    const res = [`hp ${hp(p.hp)}`, `foc ${hp(p.focus)}`];
    if (p.inv) res.push(`inv ${hp(p.inv)}`);
    const cond = [...(p.conditions ?? []), ...(p.injuries ?? []).map(i => `injury:${i}`)];
    return `${p.name} @${p.cell} ${res.join(' ')}${cond.length ? ` [${cond.join(', ')}]` : ''} (${tags.join(', ')})`;
  }

  function eventLine(e) {
    switch (e.type) {
      case 'roll': return `#${e.seq} roll ${e.by}${e.speaker && e.speaker !== e.by ? ` as ${e.speaker}` : ''}: ${e.flavor ?? e.formula} = ${e.total}${e.d20 != null ? ` (d20 ${e.d20})` : ''}${e.opportunity ? ' OPP' : ''}${e.complication ? ' COMP' : ''}${e.whisper ? ' (whisper)' : ''}`;
      case 'chat': return `#${e.seq} chat ${e.by}${e.speaker && e.speaker !== e.by ? ` as ${e.speaker}` : ''}: ${e.text}`;
      case 'move': return `#${e.seq} move ${e.by}: ${e.piece} → ${e.cell ?? '?'}`;
      case 'resource': return `#${e.seq} ${e.actor}: ${['hp', 'focus', 'inv'].filter(k => e[k] != null).map(k => `${k} ${e[k]}`).join(', ')} (by ${e.by})`;
      case 'condition': return `#${e.seq} ${e.actor} ${e.on ? '+' : '-'}${(e.statuses ?? [e.effect]).join('/')} (by ${e.by})`;
      case 'combat': return `#${e.seq} combat round ${e.round}, turn: ${e.current ?? 'none'}`;
      case 'target': return `#${e.seq} ${e.by} ${e.targeted ? 'targets' : 'untargets'} ${e.piece}`;
      default: return `#${e.seq} ${e.type}`;
    }
  }

  function combatLines() {
    const c = GM.combatState(); if (!c) return null;
    const order = c.order.map(o => `${o.name} ${o.speed}${o.boss ? '(boss)' : ''}${o.activated ? ' ✓' : ''}${o.actions ? ` act ${o.actions}` : ''}${o.reactions ? ` re ${o.reactions}` : ''}${o.moveLeft != null && o.moveLeft !== 0 ? ` mv ${o.moveLeft}ft` : ''}${o.defeated ? ' DEFEATED' : ''}`);
    return { round: c.round, current: c.current?.name ?? 'none', order };
  }

  /** One call per turn: events since the previous call (unless peek), plus the current board. */
  function turn({ since, peek = false } = {}) {
    const E = globalThis.ClaudeGMEvents;
    const from = since ?? lastSeq;
    const events = (E?.since(from) ?? []).map(eventLine);
    const seq = E?.seq() ?? from;
    if (!peek) lastSeq = seq;
    const out = { seq, events };
    if (canvas?.scene) {
      const b = GM.board();
      out.scene = `${b.scene.name} | players see "${b.scene.navName ?? ''}" | ${b.scene.active ? 'ACTIVE' : 'not active'} | grid ${b.scene.cols}x${b.scene.rows} coords ${b.scene.coords}`;
      out.pieces = b.pieces.map(pieceLine);
    } else out.scene = 'no scene viewed';
    out.combat = combatLines();
    try { const en = GM.endeavorState(); if (en.length) out.endeavors = en.map(e => `${e.title}: ${e.successes} succ, ${e.failures} fail${e.shown ? '' : ' (hidden)'}${e.result ? ` → ${e.result}` : ''}`); } catch { /* none */ }
    const audio = GM.nowPlaying(); if (audio.length) out.audio = audio.map(p => `${p.playlist}: ${p.sounds.join(', ')}`);
    out.online = game.users.filter(u => u.active).map(u => u.name);
    return out;
  }

  const sumDice = roll => roll.dice.reduce((n, d) => n + d.results.filter(x => typeof x === 'number').reduce((a, b) => a + b, 0), 0);

  /**
   * Run an NPC's turn in one call. spec:
   *  actor: token name/id (required)
   *  start/end: start and end its combat turn (default true when it's in the current combat); bossFast: use a boss's fast turn
   *  move: 'C7' or ['C7','D8'] (walls checked; stops the turn if blocked unless continueIfBlocked)
   *  say: an in-character line posted in Foundry chat as the NPC
   *  attack: { item, target, defense: 'phy'|'cog'|'spi' (default 'phy'), graze: 'auto'|false, crit: 'auto'|false,
   *            apply: true, ignoreLos: false, rollMode } or an array of them
   *  skill: { id, dc, advantage, disadvantage, rollMode }
   *  conditions: [[tokenKey, statusId, true|false], ...]
   */
  async function npcTurn(spec) {
    const log = [];
    const scene = canvas?.scene ?? (() => { throw new Error('[GM] no scene viewed'); })();
    const td = GM._find(scene.tokens, spec.actor, 'token');
    const actor = td.actor;
    const c = game.combat;
    const inCombat = !!c && c.combatants.some(x => x.tokenId === td.id);
    const finish = async () => {
      if (inCombat && spec.end !== false) { await GM.endTurn(); log.push('turn ended'); }
      const me = GM.board().pieces.find(p => p.id === td.id);
      return { npc: td.name, log, now: me ? pieceLine(me) : null };
    };

    if (inCombat && spec.start !== false) { await GM.startTurn(td.id, { bossFast: !!spec.bossFast }); log.push('turn started'); }

    if (spec.move) {
      const r = Array.isArray(spec.move) ? await GM.moveTokenPath(td.id, spec.move) : await GM.moveToken(td.id, spec.move);
      log.push(r.moved ? `moved ${r.from?.cell}→${r.to?.cell} (${r.distance} ${r.units})` : `move blocked at ${r.from?.cell}: ${r.reason}`);
      if (!r.moved && !spec.continueIfBlocked) return finish();
    }

    if (spec.say) { await GM.say(td.id, `<p>${spec.say}</p>`); log.push('spoke in chat'); }

    for (const a of [].concat(spec.attack ?? [])) {
      const tgt = GM._find(scene.tokens, a.target, 'token');
      const sight = GM.los(td.id, tgt.id);
      if (sight.verdict === 'blocked' && !a.ignoreLos) { log.push(`${a.item} vs ${tgt.name}: no line of sight, not attempted`); continue; }
      try { tgt.object?.setTarget(true, { releaseOthers: true, groupSelection: false }); } catch { /* targeting is cosmetic */ }
      const msgs = await GM.rollItem(td.id, a.item, { rollMode: a.rollMode });
      try { tgt.object?.setTarget(false, { releaseOthers: true }); } catch { /* ignore */ }
      const m = msgs.find(x => x.rolls?.length) ?? {};
      const rolls = m.rolls ?? [];
      const atkRoll = rolls.find(r => r.dice.some(d => d.die === 'd20'));
      const dmgRoll = rolls.find(r => r !== atkRoll);
      if (!atkRoll) { log.push(`${a.item}: no attack roll found in chat`); continue; }
      const defKey = a.defense ?? 'phy';
      const def = tgt.actor.system.defenses[defKey].value;
      const hit = atkRoll.total >= def;
      const item = actor.items.find(i => i.id === a.item || i.name.toLowerCase() === String(a.item).toLowerCase())
        ?? actor.items.find(i => i.name.toLowerCase().includes(String(a.item).toLowerCase()));
      const type = item?.system?.damage?.type;
      let outcome = hit ? 'hit' : 'miss', amount = 0;
      if (dmgRoll) {
        const dice = sumDice(dmgRoll), mod = dmgRoll.total - dice;
        if (hit) {
          amount = dmgRoll.total;
          const minion = actor.system.role === 'minion';
          if (m.opportunity && a.crit !== false && !minion) {
            const max = (item?.system?.damage?.formula ?? '').match(/(\d*)d(\d+)/g)?.reduce((n, t) => { const [c2, f] = t.split('d'); return n + (Number(c2 || 1) * Number(f)); }, 0) ?? dice;
            outcome = 'critical'; amount = max + mod;
          }
        } else if (a.graze !== false && (actor.system.resources.foc?.value ?? 0) >= 1) {
          outcome = 'graze'; amount = dice;
          await GM.setResource(td.id, 'foc', actor.system.resources.foc.value - 1);
        }
      }
      let applied = '';
      if (amount > 0 && a.apply !== false) {
        const r = await GM.damage(tgt.id, amount, type);
        applied = ` → ${tgt.name} hp ${r.hp.before}→${r.hp.after}/${r.hp.max}`;
      }
      log.push(`${item?.name ?? a.item} vs ${tgt.name}: ${atkRoll.total} vs ${defKey} ${def} → ${outcome}${amount ? ` ${amount}${type ? ' ' + type : ''}` : ''}${m.opportunity ? ' [OPP]' : ''}${m.complication ? ' [COMP]' : ''}${applied}`);
    }

    if (spec.skill) {
      const s = spec.skill;
      const r = await GM.rollSkill(td.id, s.id, { dc: s.dc, advantage: s.advantage, disadvantage: s.disadvantage, rollMode: s.rollMode });
      log.push(`${s.id} test: ${r.rolls?.[0]?.total}${s.dc != null ? ` vs DC ${s.dc} → ${r.vsDC}` : ''}${r.opportunity ? ' [OPP]' : ''}${r.complication ? ' [COMP]' : ''}`);
    }

    for (const [key, status, on] of spec.conditions ?? []) {
      const r = await GM.setCondition(key, status, on !== false);
      log.push(`${r.piece}: ${on !== false ? '+' : '-'}${status}`);
    }

    return finish();
  }

  Hooks.once('ready', () => {
    if (!game.user.isGM || !globalThis.GM) return;
    Object.assign(globalThis.GM, { turn, npcTurn, _pieceLine: pieceLine });
  });
  globalThis.ClaudeGMTable = { turn, npcTurn, pieceLine, eventLine };
})();
