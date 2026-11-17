// Claude GM Tools: endeavor tracker for the Cosmere RPG ("N successes before M failures").
// State lives in one world setting; every client re-renders when it changes, so players see shown endeavors live.
// Only GMs can change it (world settings are GM-writable). API: globalThis.ClaudeGMEndeavors and game.modules.get('claude-gm-tools').api.endeavors
(() => {
  const MOD = 'claude-gm-tools';
  const KEY = 'endeavors';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = () => foundry.utils.deepClone(game.settings.get(MOD, KEY)?.list ?? []);
  const save = arr => game.settings.set(MOD, KEY, { list: arr });
  const find = (arr, key) => arr.find(e => e.title === key) ?? arr.find(e => e.id === key);
  const need = (arr, key) => find(arr, key) ?? (() => { throw new Error(`[claude-gm-tools] no endeavor "${key}"`); })();
  const resultOf = e => (e.successes >= e.need ? 'succeeded' : e.failures >= e.allow ? 'failed' : undefined);
  const state = e => e && { title: e.title, successes: `${e.successes}/${e.need}`, failures: `${e.failures}/${e.allow}`, shown: e.shown, result: resultOf(e) };
  const gmOnly = () => { if (!game.user.isGM) throw new Error('[claude-gm-tools] endeavors can only be changed by a GM'); };

  class EndeavorPanel extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: 'claude-gm-endeavors',
      classes: ['claude-gm-endeavors'],
      window: { title: 'Endeavors', icon: 'fa-solid fa-mountain-sun', resizable: false, minimizable: true },
      position: { width: 250, height: 'auto', top: 70, left: 110 }
    };
    async _renderHTML() {
      const visible = list().filter(e => game.user.isGM || e.shown);
      const pips = (n, of, cls) => Array.from({ length: of }, (_, i) => `<span class="pip ${cls}${i < n ? ' on' : ''}"></span>`).join('');
      const root = document.createElement('div');
      root.innerHTML = visible.length ? visible.map(e => `
        <section class="endeavor ${resultOf(e) ?? ''}">
          <header>${esc(e.title)}${game.user.isGM && !e.shown ? ' <em>(hidden)</em>' : ''}</header>
          <div class="row"><span class="label">Successes</span><span class="pips">${pips(e.successes, e.need, 'success')}</span><span class="count">${e.successes}/${e.need}</span></div>
          <div class="row"><span class="label">Failures</span><span class="pips">${pips(e.failures, e.allow, 'failure')}</span><span class="count">${e.failures}/${e.allow}</span></div>
          ${resultOf(e) ? `<footer>${resultOf(e) === 'succeeded' ? 'Succeeded' : 'Failed'}</footer>` : ''}
        </section>`).join('') : '<p class="empty">No active endeavors.</p>';
      return root;
    }
    _replaceHTML(result, content) { content.replaceChildren(result); }
  }

  let panel = null;
  function refresh() {
    if (!game.ready) return;
    const any = list().some(e => game.user.isGM || e.shown);
    if (any) { panel ??= new EndeavorPanel(); panel.render({ force: true }); }
    else if (panel?.rendered) panel.close();
  }

  const api = {
    /** Start an endeavor: `need` successes before `allow` failures. show: visible to players. Replaces one with the same title. */
    async create(title, needSuccesses, allowFailures, { show = true } = {}) {
      gmOnly();
      const arr = list().filter(e => e.title !== title);
      arr.push({ id: foundry.utils.randomID(), title, need: needSuccesses, allow: allowFailures, successes: 0, failures: 0, shown: show, created: Date.now() });
      await save(arr); return state(find(arr, title));
    },
    /** kind: 'success' | 'failure' (adds n), or { successes, failures } to set absolute values. */
    async mark(key, kind = 'success', n = 1) {
      gmOnly();
      const arr = list(); const e = need(arr, key);
      if (typeof kind === 'object') {
        if (kind.successes != null) e.successes = Math.max(0, Math.min(e.need, kind.successes));
        if (kind.failures != null) e.failures = Math.max(0, Math.min(e.allow, kind.failures));
      } else if (kind === 'success') e.successes = Math.min(e.need, e.successes + n);
      else if (kind === 'failure') e.failures = Math.min(e.allow, e.failures + n);
      else throw new Error(`[claude-gm-tools] kind must be 'success' or 'failure'`);
      await save(arr); return state(e);
    },
    state(key) { const arr = list(); return key ? state(need(arr, key)) : arr.map(state); },
    async show(key, shown = true) { gmOnly(); const arr = list(); const e = need(arr, key); e.shown = shown; await save(arr); return state(e); },
    async end(key) { gmOnly(); const arr = list(); need(arr, key); await save(arr.filter(e => e.title !== key && e.id !== key)); return { ended: key }; },
    open() { panel ??= new EndeavorPanel(); return panel.render({ force: true }); }
  };
  globalThis.ClaudeGMEndeavors = api;

  Hooks.once('init', () => {
    game.settings.register(MOD, KEY, { scope: 'world', config: false, type: Object, default: { list: [] }, onChange: () => refresh() });
  });
  Hooks.once('ready', () => {
    const m = game.modules.get(MOD); if (m) m.api = { ...(m.api ?? {}), endeavors: api };
    refresh();
  });
})();
