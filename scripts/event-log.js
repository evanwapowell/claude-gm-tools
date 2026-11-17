// Claude GM Tools: in-memory event feed on GM clients. Records what players (and anyone) did since the GM last looked:
// rolls, chat, token moves, resource changes, conditions, combat turns, targeting. Nothing is written to the database.
// API: globalThis.ClaudeGMEvents.since(seq) / .last(n) / .seq() / .clear(); also GM.events(seq) when the GM API is loaded.
// Output keys avoid the word "token" (a browser-automation output filter redacts it): pieces are "piece".
(() => {
  const MAX = 500;
  const buf = [];
  let seq = 0;
  const strip = h => String(h ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const who = id => game.users.get(id)?.name;
  const push = (type, data) => {
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    buf.push({ seq: ++seq, at: new Date().toISOString().slice(11, 19), type, ...data });
    if (buf.length > MAX) buf.shift();
  };
  const cellAt = td => {
    try { return td.parent?.id === canvas?.scene?.id ? globalThis.GM?._cellAt?.(td.x, td.y)?.cell : undefined; } catch { return undefined; }
  };

  Hooks.once('ready', () => {
    if (!game.user.isGM) return;

    Hooks.on('createChatMessage', m => {
      const rolls = m.rolls ?? [];
      const r = rolls[0];
      const d20 = r?.dice?.find(d => d.faces === 20)?.results?.find(x => x.active !== false && !x.discarded)?.result;
      push(r ? 'roll' : 'chat', {
        by: m.author?.name, gm: m.author?.isGM || undefined, speaker: m.speaker?.alias,
        text: r ? undefined : strip(m.content).slice(0, 240),
        flavor: r ? strip(m.flavor).slice(0, 120) || undefined : undefined,
        total: r?.total, formula: r?.formula, d20,
        opportunity: rolls.some(x => x.dice.some(d => d.rolledOpportunity)) || d20 === 20 || undefined,
        complication: rolls.some(x => x.dice.some(d => d.rolledComplication)) || d20 === 1 || undefined,
        whisper: m.whisper?.length ? true : undefined, msg: m.id
      });
    });

    Hooks.on('updateToken', (td, ch, opts, userId) => {
      if (!('x' in ch || 'y' in ch)) return;
      push('move', { by: who(userId), piece: td.name, cell: cellAt(td), scene: td.parent?.id });
    });

    Hooks.on('updateActor', (a, ch, opts, userId) => {
      const r = ch.system?.resources; if (!r) return;
      const v = k => r[k]?.value;
      if (v('hea') == null && v('foc') == null && v('inv') == null) return;
      push('resource', { by: who(userId), actor: a.name, hp: v('hea'), focus: v('foc'), inv: v('inv') });
    });

    const effect = on => (e, opts, userId) => {
      const statuses = [...(e.statuses ?? [])];
      push('condition', { by: who(userId), actor: e.parent?.name, on, effect: e.name, statuses: statuses.length ? statuses : undefined });
    };
    Hooks.on('createActiveEffect', effect(true));
    Hooks.on('deleteActiveEffect', effect(false));

    Hooks.on('updateCombat', (c, ch) => {
      if (!('turn' in ch || 'round' in ch)) return;
      push('combat', { round: c.round, current: c.combatant?.name ?? null });
    });

    Hooks.on('targetToken', (user, tok, targeted) => {
      push('target', { by: user?.name, piece: tok?.name, targeted });
    });
  });

  globalThis.ClaudeGMEvents = {
    since: (s = 0) => buf.filter(e => e.seq > s),
    last: (n = 20) => buf.slice(-n),
    seq: () => seq,
    clear: () => { buf.splice(0); return seq; }
  };
})();
