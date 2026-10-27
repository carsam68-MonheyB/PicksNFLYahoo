/* Interfaz: carga de datos de ESPN, estado local y render. Depende de model.js (window.PicksModel). */
(function () {
  'use strict';
  const M = window.PicksModel;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  const STANDINGS_URL = 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings';
  const LS = {
    settings: 'nflpicks.settings',
    cache: (y) => 'nflpicks.cache.' + y,
    overrides: (y) => 'nflpicks.overrides.' + y,
    meta: 'nflpicks.meta',
  };
  const WEEK_FRESH_MS = 10 * 60 * 1000;
  const INJ_FRESH_MS = 30 * 60 * 1000;
  const REGULAR_WEEKS = 18;
  const POST_WEEKS = [1, 2, 3, 5];

  const state = {
    settings: loadJSON(LS.settings) || {},
    year: null,
    currentKey: null,
    selectedKey: null,
    games: [],
    teams: {},
    injuries: {},
    official: {},
    overrides: { picks: {}, injuries: {}, order: {} },
    cache: null,
    loading: false,
    openDetails: new Set(),
    tab: 'picks',
    lastErrors: [],
  };
  state.settings = Object.assign({}, M.DEFAULT_SETTINGS, state.settings);

  function loadJSON(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio o modo privado */ } }
  function saveSettings() { saveJSON(LS.settings, state.settings); }
  function saveOverrides() { if (state.year) saveJSON(LS.overrides(state.year), state.overrides); }
  function saveCache() { if (state.year && state.cache) saveJSON(LS.cache(state.year), state.cache); }

  // ---------- Red ----------
  function url(u) { const p = (state.settings.proxy || '').trim(); return p ? p + encodeURIComponent(u) : u; }
  async function getJSON(u, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(url(u), { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + u);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  function weekList() {
    const list = [];
    for (let w = 1; w <= REGULAR_WEEKS; w++) list.push({ seasonType: 2, week: w, key: M.orderKey(2, w), label: M.weekLabel(2, w) });
    POST_WEEKS.forEach((w) => list.push({ seasonType: 3, week: w, key: M.orderKey(3, w), label: M.weekLabel(3, w) }));
    return list;
  }

  async function load(force) {
    if (state.loading) return;
    state.loading = true;
    state.lastErrors = [];
    setBanner('<span class="loading"></span>Cargando datos de ESPN…', '');
    try {
      // 1. Semana actual y año de temporada
      let meta = null;
      try {
        const sb = await getJSON(BASE + '/scoreboard');
        const year = Number((sb.season && sb.season.year) || (sb.leagues && sb.leagues[0] && sb.leagues[0].season && sb.leagues[0].season.year));
        const type = Number((sb.season && sb.season.type) || 2);
        const week = Number((sb.week && sb.week.number) || 1);
        meta = { year, type, week, at: Date.now() };
        saveJSON(LS.meta, meta);
      } catch (e) {
        state.lastErrors.push('Portada: ' + e.message);
        meta = loadJSON(LS.meta);
        if (!meta) throw new Error('No se pudo conectar con ESPN y no hay datos guardados. ' + e.message);
      }
      state.year = meta.year;
      state.currentKey = meta.type === 3 ? M.orderKey(3, meta.week) : meta.type === 2 ? M.orderKey(2, meta.week) : meta.type === 1 ? M.orderKey(2, 1) : M.orderKey(3, 5);
      state.cache = loadJSON(LS.cache(state.year)) || { weeks: {}, injuries: null, standings: null };
      state.overrides = Object.assign({ picks: {}, injuries: {}, order: {} }, loadJSON(LS.overrides(state.year)) || {});

      // 2. Todas las semanas (regular + playoffs)
      const now = Date.now();
      const jobs = weekList().map(async (wk) => {
        const c = state.cache.weeks[wk.key];
        const fresh = c && (now - c.fetchedAt) < WEEK_FRESH_MS;
        const settled = c && c.games.length > 0 && c.games.every((g) => g.completed);
        const future = c && c.games.length > 0 && wk.key > state.currentKey + 1 && c.games.every((g) => !g.completed);
        if (c && !force && (settled || fresh || future)) return;
        try {
          const data = await getJSON(`${BASE}/scoreboard?dates=${state.year}&seasontype=${wk.seasonType}&week=${wk.week}`);
          const events = (data.events || []).filter((ev) => {
            const y = Number((ev.season && ev.season.year) || state.year);
            return y === state.year;
          });
          const games = events.map((ev) => M.normalizeEvent(ev, wk.seasonType, wk.week)).filter((g) => g.seasonType === wk.seasonType && g.week === wk.week && g.home.abbr && g.away.abbr);
          state.cache.weeks[wk.key] = { fetchedAt: Date.now(), games };
        } catch (e) {
          state.lastErrors.push(`${wk.label}: ${e.message}`);
        }
      });

      // 3. Lesiones
      jobs.push((async () => {
        const c = state.cache.injuries;
        if (c && !force && (now - c.fetchedAt) < INJ_FRESH_MS) return;
        try {
          const data = await getJSON(BASE + '/injuries', 20000);
          state.cache.injuries = { fetchedAt: Date.now(), data: M.normalizeInjuries(data) };
        } catch (e) { state.lastErrors.push('Lesiones: ' + e.message); }
      })());

      // 4. Posiciones oficiales (opcional)
      jobs.push((async () => {
        const c = state.cache.standings;
        if (c && !force && (now - c.fetchedAt) < WEEK_FRESH_MS) return;
        try {
          const data = await getJSON(`${STANDINGS_URL}?season=${state.year}&level=3`);
          state.cache.standings = { fetchedAt: Date.now(), data: M.normalizeStandings(data) };
        } catch (e) { /* opcional: no se reporta */ }
      })());

      await Promise.all(jobs);
      saveCache();
      assemble();
      if (state.selectedKey == null || !state.games.some((g) => g.key === state.selectedKey)) state.selectedKey = pickDefaultWeek();
      if (state.lastErrors.length) setBanner('Algunos datos no se pudieron actualizar: ' + state.lastErrors.slice(0, 3).join(' · ') + (state.lastErrors.length > 3 ? ` (+${state.lastErrors.length - 3})` : ''), 'warn');
      else setBanner('', '');
    } catch (e) {
      setBanner('No se pudieron cargar los datos. ' + e.message + '<br><span class="small">Si tu navegador bloquea la API de ESPN, abre Ajustes y configura un proxy CORS, o revisa tu conexión.</span>', 'error');
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  function assemble() {
    const games = [];
    Object.values(state.cache.weeks).forEach((w) => games.push(...w.games));
    games.sort((a, b) => a.key - b.key || a.date.localeCompare(b.date));
    state.games = games;
    const teams = {};
    games.forEach((g) => [g.home, g.away].forEach((t) => {
      if (!teams[t.id] || (!teams[t.id].logo && t.logo)) teams[t.id] = { id: t.id, abbr: t.abbr, name: t.name, short: t.short, logo: t.logo, color: t.color };
    }));
    state.teams = teams;
    state.injuries = (state.cache.injuries && state.cache.injuries.data) || {};
    state.official = (state.cache.standings && state.cache.standings.data) || {};
  }

  function pickDefaultWeek() {
    const keys = Array.from(new Set(state.games.map((g) => g.key))).sort((a, b) => a - b);
    if (!keys.length) return state.currentKey;
    let k = keys.includes(state.currentKey) ? state.currentKey : keys[0];
    const allDone = (key) => state.games.filter((g) => g.key === key).every((g) => g.completed);
    while (allDone(k)) {
      const next = keys.find((x) => x > k);
      if (!next) break;
      k = next;
    }
    return k;
  }

  // ---------- Cálculo ----------
  function compute() {
    const key = state.selectedKey;
    const games = state.games.filter((g) => g.key === key);
    const stats = M.computeStats(state.games, key, state.settings);
    const analyses = games.map((g) => M.analyzeGame(g, stats, state.injuries, state.settings, state.overrides));
    const ordered = M.allocatePoints(analyses, state.overrides.order[key]);
    return { games, stats, ordered };
  }

  // ---------- Utilidades de render ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x, d) => (x > 0 ? '+' : '') + Number(x).toFixed(d == null ? 1 : d);
  const pct = (p) => Math.round(p * 100) + ' %';
  const cls = (x) => (x > 0.05 ? 'pos' : x < -0.05 ? 'neg' : '');
  const dateFmt = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : dateFmt.format(d); };
  const logo = (t) => (t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : '');
  const lineText = (a) => {
    const s = a.spreadHome;
    if (Math.abs(s) < 0.25) return 'Parejo';
    return s > 0 ? `${a.game.home.abbr} −${Math.abs(s).toFixed(1)}` : `${a.game.away.abbr} −${Math.abs(s).toFixed(1)}`;
  };

  function setBanner(html, kind) {
    const b = $('#banner');
    if (!html) { b.hidden = true; b.innerHTML = ''; return; }
    b.hidden = false; b.className = 'banner' + (kind ? ' ' + kind : ''); b.innerHTML = html;
  }

  function renderAll() {
    renderHeader();
    renderWeekBar();
    renderPicks();
    renderStandings();
    renderInjuries();
    renderSettings();
  }

  function renderHeader() {
    $('#season-label').textContent = state.year ? `Temporada ${state.year} · ${state.games.filter((g) => g.completed).length} partidos jugados` : 'Temporada —';
    const ages = [];
    const wk = state.cache && Object.values(state.cache.weeks).map((w) => w.fetchedAt).filter(Boolean);
    if (wk && wk.length) ages.push('Resultados: ' + ago(Math.max(...wk)));
    if (state.cache && state.cache.injuries) ages.push('Lesiones: ' + ago(state.cache.injuries.fetchedAt));
    $('#data-age').textContent = ages.join(' · ') || 'Sin datos';
    $('#btn-refresh').disabled = state.loading;
  }
  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60); if (h < 48) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} días`;
  }

  function renderWeekBar() {
    const sel = $('#week-select');
    const keys = Array.from(new Set(state.games.map((g) => g.key))).sort((a, b) => a - b);
    const list = weekList().filter((w) => keys.includes(w.key));
    sel.innerHTML = list.map((w) => `<option value="${w.key}"${w.key === state.selectedKey ? ' selected' : ''}>${esc(w.label)}${w.key === state.currentKey ? ' · actual' : ''}</option>`).join('') || '<option>Sin semanas</option>';
    const i = list.findIndex((w) => w.key === state.selectedKey);
    $('#week-prev').disabled = i <= 0;
    $('#week-next').disabled = i < 0 || i >= list.length - 1;
    const games = state.games.filter((g) => g.key === state.selectedKey);
    if (games.length) {
      const ds = games.map((g) => g.date).filter(Boolean).sort();
      const f = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short' });
      $('#week-dates').textContent = ds.length ? `${f.format(new Date(ds[0]))} – ${f.format(new Date(ds[ds.length - 1]))} · ${games.length} partidos` : '';
    } else $('#week-dates').textContent = '';
  }

  // ---------- Picks ----------
  function renderPicks() {
    const box = $('#games');
    if (!state.games.length) { box.innerHTML = `<div class="empty">${state.loading ? 'Cargando…' : 'Sin datos. Pulsa “Actualizar datos”.'}</div>`; $('#picks-summary').textContent = ''; return; }
    const { ordered } = compute();
    if (!ordered.length) { box.innerHTML = '<div class="empty">No hay partidos programados en esta semana.</div>'; $('#picks-summary').textContent = ''; return; }
    const n = ordered.length;
    const done = ordered.filter((a) => a.game.completed);
    const hits = done.filter((a) => a.pickTeam.winner).length;
    const expected = ordered.reduce((s, a) => s + a.points * a.prob, 0);
    const manual = state.overrides.order[state.selectedKey] ? ' · orden manual' : '';
    const past = state.selectedKey < state.currentKey ? ' · bajas según el reporte actual' : '';
    $('#picks-summary').textContent = `${n} partidos · ${n * (n + 1) / 2} puntos en juego · ${Math.round(expected)} esperados${manual}${past}` + (done.length ? ` · ${hits}/${done.length} aciertos en partidos ya jugados` : '');
    box.innerHTML = ordered.map((a, i) => gameCard(a, i, n)).join('');
  }

  function gameCard(a, i, n) {
    const g = a.game;
    const chips = [];
    chips.push(`<span class="chip ${cls(a.base)}">Rating ${fmt(a.base)}</span>`);
    if (a.homeAdv) chips.push(`<span class="chip">Local +${a.homeAdv.toFixed(1)}</span>`);
    if (a.h2hGames.length) chips.push(`<span class="chip ${cls(a.h2h)}">Directo ${fmt(a.h2h)}</span>`);
    if (a.commonDetails.length) chips.push(`<span class="chip ${cls(a.common)}">Rivales comunes ${fmt(a.common)} (${a.commonDetails.length})</span>`);
    if (a.chainsHome.length || a.chainsAway.length) chips.push(`<span class="chip ${cls(a.chains)}">Cadenas ${fmt(a.chains)}</span>`);
    if (a.injH.total > 0.05) chips.push(`<span class="chip warn">Bajas ${g.home.abbr} −${a.injH.total.toFixed(1)}</span>`);
    if (a.injA.total > 0.05) chips.push(`<span class="chip warn">Bajas ${g.away.abbr} −${a.injA.total.toFixed(1)}</span>`);
    if (a.overridden) chips.push('<span class="chip warn">Pick manual</span>');
    if (a.rank !== a.modelRank) chips.push(`<span class="chip">Modelo: puesto ${a.modelRank}</span>`);
    const teamBtn = (t, side, s) => `<button type="button" class="team-btn${a.pick === side ? ' picked' : ''}${g.completed && t.winner ? ' won' : ''}" data-act="pick" data-id="${g.id}" data-side="${side}" title="Elegir a ${esc(t.name)}">${logo(t)}<span>${esc(t.abbr)}</span><span class="rec">${esc(recordOf(s, t))}</span>${g.completed && t.score != null ? `<strong>${t.score}</strong>` : ''}</button>`;
    const result = g.completed ? `<span class="${a.pickTeam.winner ? 'pos' : 'neg'}">${a.pickTeam.winner ? 'Acierto' : 'Fallo'} · ${esc(g.detail)}</span>` : esc(fmtDate(g.date)) + (g.broadcast ? ' · ' + esc(g.broadcast) : '');
    const open = state.openDetails.has(g.id);
    return `<article class="game${g.completed ? ' done' : ''}" data-id="${g.id}">
      <div class="game-row">
        <div class="pts">${a.points}<small>pts</small></div>
        <div class="matchup">
          <div class="teams">${teamBtn(g.away, 'away', a.A)}<span class="at">en</span>${teamBtn(g.home, 'home', a.H)}${g.neutral ? '<span class="chip">Sede neutral</span>' : ''}</div>
          <div class="meta"><span>${result}</span>${g.venue ? `<span>${esc(g.venue)}</span>` : ''}</div>
          <div class="chips">${chips.join('')}</div>
        </div>
        <div class="prob">
          <span class="p">${pct(a.prob)}</span>
          <span class="line">${esc(a.pickTeam.abbr)} gana · línea ${esc(lineText(a))}</span>
          <div class="order">
            <button type="button" class="btn ghost tiny" data-act="up" data-id="${g.id}" ${i === 0 ? 'disabled' : ''} aria-label="Subir">▲</button>
            <button type="button" class="btn ghost tiny" data-act="down" data-id="${g.id}" ${i === n - 1 ? 'disabled' : ''} aria-label="Bajar">▼</button>
            <button type="button" class="btn ghost tiny" data-act="toggle" data-id="${g.id}" aria-expanded="${open}">${open ? 'Ocultar' : 'Detalle'}</button>
          </div>
        </div>
      </div>
      <div class="detail" ${open ? '' : 'hidden'}>${open ? detailHTML(a) : ''}</div>
    </article>`;
  }

  function recordOf(s, t) {
    if (s && s.gp) return `${s.w}-${s.l}${s.t ? '-' + s.t : ''}`;
    return t.record || '0-0';
  }

  function detailHTML(a) {
    const g = a.game;
    const rows = [
      ['Rating local − visitante', a.base, `${g.home.abbr} ${a.H.rating.toFixed(1)} · ${g.away.abbr} ${a.A.rating.toFixed(1)}`],
      ['Ventaja de local', a.homeAdv, g.neutral ? 'Sede neutral' : ''],
      ['Enfrentamiento directo', a.h2h, a.h2hGames.map((r) => `${M.weekLabel(r.seasonType, r.week)}: ${g.home.abbr} ${r.pf}-${r.pa}`).join('; ') || 'No se han enfrentado'],
      ['Rivales comunes', a.common, a.commonDetails.length ? `${a.commonDetails.length} rivales` : 'Ninguno'],
      ['Cadenas de resultados', a.chains, `${a.chainsHome.length} a favor de ${g.home.abbr}, ${a.chainsAway.length} a favor de ${g.away.abbr}`],
      ['Bajas de ' + g.home.abbr, -a.injH.total, a.injH.capped ? 'Tope aplicado' : ''],
      ['Bajas de ' + g.away.abbr, a.injA.total, a.injA.capped ? 'Tope aplicado' : ''],
    ];
    const compTable = `<table class="comp"><thead><tr><th>Componente</th><th class="num">Puntos</th><th>Nota</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="num ${cls(r[1])}">${fmt(r[1])}</td><td class="small">${esc(r[2])}</td></tr>`).join('')}
      <tr class="total"><td>Línea del local</td><td class="num ${cls(a.spreadHome)}">${fmt(a.spreadHome)}</td><td class="small">Prob. ${g.home.abbr} ${pct(a.probHome)} · ${g.away.abbr} ${pct(1 - a.probHome)}</td></tr>
    </tbody></table>`;
    const teamBlock = (t, s) => {
      const lg = s.lastGame;
      return `<h4>${esc(t.name)}</h4><ul>
        <li>Récord ${recordOf(s, t)} · PF ${s.pf} · PC ${s.pa} · Dif ${fmt(s.pf - s.pa, 0)}${s.streak ? ' · Racha ' + s.streak : ''}</li>
        <li>SRS ${fmt(s.srs)} · Récord ponderado ${fmt(s.recordRating)} · Rating ${fmt(s.rating)}</li>
        <li>Última jornada: ${lg ? `${lg.won ? 'ganó' : lg.tie ? 'empató' : 'perdió'} ${lg.pf}-${lg.pa} ${lg.home ? 'vs' : 'en'} ${esc(lg.oppAbbr)} (${fmt(lg.margin, 0)})` : 'sin partidos'}</li>
      </ul>`;
    };
    const common = a.commonDetails.length ? `<h4>Rivales comunes</h4><table><thead><tr><th>Rival</th><th class="num">${g.home.abbr}</th><th class="num">${g.away.abbr}</th><th class="num">Dif</th></tr></thead><tbody>
      ${a.commonDetails.map((c) => `<tr><td>${esc(c.abbr)}</td><td class="num ${cls(c.homeAvg)}">${fmt(c.homeAvg)}</td><td class="num ${cls(c.awayAvg)}">${fmt(c.awayAvg)}</td><td class="num ${cls(c.diff)}">${fmt(c.diff)}</td></tr>`).join('')}
    </tbody></table><p class="small muted">Margen promedio de cada equipo contra ese rival (topado).</p>` : '';
    const chains = (a.chainsHome.length || a.chainsAway.length) ? `<h4>Cadenas</h4><ul>${a.chainsHome.map((c) => `<li class="pos">${esc(c.text)}</li>`).join('')}${a.chainsAway.map((c) => `<li class="neg">${esc(c.text)}</li>`).join('')}</ul>` : '';
    const inj = (t, p) => `<h4>Bajas · ${esc(t.abbr)} (−${p.total.toFixed(1)})</h4>${p.items.length ? injuryTable(t, p.items.slice(0, 12)) + (p.items.length > 12 ? `<p class="small muted">+${p.items.length - 12} más en la pestaña Bajas</p>` : '') : '<p class="small muted">Sin reporte</p>'}`;
    return `<div class="cols">
      <div>${compTable}${common}${chains}</div>
      <div>${teamBlock(g.home, a.H)}${teamBlock(g.away, a.A)}</div>
      <div>${inj(g.home, a.injH)}${inj(g.away, a.injA)}</div>
    </div>`;
  }

  function injuryTable(t, items) {
    return `<table><thead><tr><th>Jugador</th><th>Pos</th><th>Estatus</th><th class="num">Pts</th><th>Marca</th></tr></thead><tbody>
      ${items.map((e) => `<tr class="inj-row ${e.mark === 'ignore' ? 'ignored' : e.mark === 'key' ? 'key' : ''}">
        <td>${esc(e.name)}${e.detail ? `<span class="small muted"> · ${esc(e.detail)}</span>` : ''}${e.qbNote ? `<span class="small muted"> · ${esc(e.qbNote)}</span>` : ''}</td>
        <td>${esc(e.pos)}</td><td>${esc(e.status)}</td><td class="num">${e.contribution ? '−' + e.contribution.toFixed(1) : '0'}</td>
        <td><span class="mark">
          <button type="button" class="${e.mark === 'key' ? 'on' : ''}" data-act="mark" data-ath="${esc(e.athleteId)}" data-mark="key">Clave</button>
          <button type="button" class="${e.mark === 'ignore' ? 'on ign' : ''}" data-act="mark" data-ath="${esc(e.athleteId)}" data-mark="ignore">Ignorar</button>
        </span></td></tr>`).join('')}
    </tbody></table>`;
  }

  // ---------- Posiciones ----------
  function renderStandings() {
    const box = $('#standings');
    if (!state.games.length) { box.innerHTML = '<div class="empty">Sin datos.</div>'; return; }
    const stats = M.computeStats(state.games, state.selectedKey, state.settings);
    const { groups } = M.standings(stats, state.teams, state.official);
    const order = ['AFC Este', 'AFC Norte', 'AFC Sur', 'AFC Oeste', 'NFC Este', 'NFC Norte', 'NFC Sur', 'NFC Oeste'];
    const names = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 100) % 100 - (order.indexOf(b) + 100) % 100);
    box.innerHTML = `<p class="muted small">Calculada con los partidos jugados antes de la semana seleccionada. Rating = mezcla de SRS (margen ajustado por rivales, con recencia) y récord ponderado.</p>` + names.map((name) => `<div class="division"><h3>${esc(name)}</h3>
      <table><thead><tr><th>#</th><th>Equipo</th><th>Récord</th><th>Div</th><th>Conf</th><th class="num">PF</th><th class="num">PC</th><th class="num">Dif</th><th>Racha</th><th class="num">SRS</th><th class="num">Rating</th><th class="num">Conf #</th>${hasSeeds() ? '<th>Semilla</th>' : ''}</tr></thead><tbody>
      ${groups[name].map((r) => `<tr><td>${r.divRank}</td><td>${logo(r.team)}${esc(r.team.name)}</td><td>${recordOf(r.stats, r.team)}</td><td>${r.divRecord}</td><td>${r.confRecord}</td><td class="num">${r.stats.pf}</td><td class="num">${r.stats.pa}</td><td class="num ${cls(r.stats.pf - r.stats.pa)}">${fmt(r.stats.pf - r.stats.pa, 0)}</td><td>${r.stats.streak || '—'}</td><td class="num ${cls(r.stats.srs)}">${fmt(r.stats.srs)}</td><td class="num ${cls(r.stats.rating)}">${fmt(r.stats.rating)}</td><td class="num">${r.confRank}</td>${hasSeeds() ? `<td>${esc(r.seed || '')}${r.clincher ? ' ' + esc(r.clincher) : ''}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>`).join('');
  }
  function hasSeeds() { return Object.values(state.official).some((o) => o.seed); }

  // ---------- Bajas ----------
  function renderInjuries() {
    const box = $('#injuries');
    const games = state.games.filter((g) => g.key === state.selectedKey);
    if (!games.length) { box.innerHTML = '<div class="empty">Sin partidos en esta semana.</div>'; return; }
    if (!Object.keys(state.injuries).length) { box.innerHTML = '<div class="empty">No hay reporte de lesiones cargado.</div>'; return; }
    const teams = [];
    games.forEach((g) => { teams.push(g.away, g.home); });
    box.innerHTML = teams.map((t) => {
      const p = M.injuryPenalty(state.injuries[t.id], state.settings, state.overrides);
      return `<div class="inj-team"><h3><span>${logo(t)}${esc(t.name)}</span><span class="small muted">Penalización −${p.total.toFixed(1)}${p.capped ? ` (tope; suma ${p.raw.toFixed(1)})` : ''}</span></h3>${p.items.length ? injuryTable(t, p.items) : '<p class="small muted" style="padding:.5rem .75rem">Sin jugadores en el reporte.</p>'}</div>`;
    }).join('');
  }

  // ---------- Ajustes ----------
  const SETTING_DEFS = [
    ['recency', 'Recencia (peso de jornadas anteriores)', 0.5, 1, 0.01, 'Cada jornada anterior pesa este factor respecto a la siguiente. 1 = todas iguales; 0.7 = casi solo las últimas semanas.'],
    ['homeAdv', 'Ventaja de local (pts)', 0, 4, 0.1, 'Se descuenta en los ratings y se suma al local en la línea. 0 la desactiva.'],
    ['recordBlend', 'Mezcla récord vs margen', 0, 1, 0.05, '0 = solo márgenes (SRS); 1 = solo posición/récord.'],
    ['marginCap', 'Tope de margen por partido', 7, 40, 1, 'Evita que una paliza domine el rating.'],
    ['prior', 'Regularización (partidos neutros)', 0, 6, 0.5, 'Partidos ficticios de margen 0 que acercan a 0 a los equipos con pocos juegos.'],
    ['h2hW', 'Peso del enfrentamiento directo', 0, 1, 0.05, 'Fracción del margen del partido previo que se suma a la línea.'],
    ['commonW', 'Peso de rivales comunes', 0, 1, 0.05, 'Fracción de la diferencia promedio contra rivales comunes.'],
    ['chainW', 'Puntos por cadena neta', 0, 3, 0.1, 'A venció a X y X venció a B.'],
    ['chainCap', 'Tope de cadenas (pts)', 0, 8, 0.5, ''],
    ['injuryScale', 'Escala de bajas', 0, 1.5, 0.05, 'Multiplica todas las penalizaciones por lesiones. 0 las desactiva.'],
    ['injuryCap', 'Tope de bajas por equipo (pts)', 0, 15, 0.5, ''],
    ['spreadSd', 'Desviación línea → probabilidad', 8, 20, 0.5, '13.5 es el estándar NFL; menor = probabilidades más extremas.'],
  ];
  function renderSettings() {
    const box = $('#settings-body');
    if (box.dataset.ready) { SETTING_DEFS.forEach(([k]) => { const r = $(`#set-${k}`); if (r) { r.value = state.settings[k]; $(`#val-${k}`).textContent = state.settings[k]; } }); return; }
    box.dataset.ready = '1';
    box.innerHTML = SETTING_DEFS.map(([k, label, min, max, step, help]) => `<div class="setting">
      <label for="set-${k}"><span>${esc(label)}</span><span id="val-${k}">${state.settings[k]}</span></label>
      <input type="range" id="set-${k}" data-key="${k}" min="${min}" max="${max}" step="${step}" value="${state.settings[k]}">
      ${help ? `<p class="help">${esc(help)}</p>` : ''}
    </div>`).join('') + `<div class="setting"><label for="set-proxy"><span>Proxy CORS (opcional)</span></label>
      <input type="text" id="set-proxy" value="${esc(state.settings.proxy || '')}" placeholder="https://tu-proxy/?url=">
      <p class="help">Solo si tu navegador bloquea la API de ESPN. Se antepone a la URL codificada.</p></div>`;
    box.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.dataset.key) { state.settings[t.dataset.key] = Number(t.value); $(`#val-${t.dataset.key}`).textContent = t.value; saveSettings(); renderPicks(); renderStandings(); renderInjuries(); }
    });
    $('#set-proxy').addEventListener('change', (ev) => { state.settings.proxy = ev.target.value.trim(); saveSettings(); });
  }

  // ---------- Eventos ----------
  function onAction(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act, id = btn.dataset.id;
    if (act === 'pick') {
      const cur = state.overrides.picks[id];
      const { ordered } = compute();
      const a = ordered.find((x) => x.game.id === id);
      const side = btn.dataset.side;
      if (a && side === a.modelPick) delete state.overrides.picks[id];
      else if (cur === side) delete state.overrides.picks[id];
      else state.overrides.picks[id] = side;
      saveOverrides(); renderPicks();
    } else if (act === 'up' || act === 'down') {
      const { ordered } = compute();
      const ids = ordered.map((x) => x.game.id);
      const i = ids.indexOf(id);
      const j = act === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      state.overrides.order[state.selectedKey] = ids;
      saveOverrides(); renderPicks();
    } else if (act === 'toggle') {
      if (state.openDetails.has(id)) state.openDetails.delete(id); else state.openDetails.add(id);
      renderPicks();
    } else if (act === 'mark') {
      const ath = btn.dataset.ath, mark = btn.dataset.mark;
      if (state.overrides.injuries[ath] === mark) delete state.overrides.injuries[ath]; else state.overrides.injuries[ath] = mark;
      saveOverrides(); renderPicks(); renderInjuries();
    }
  }

  function copyList() {
    const { ordered } = compute();
    const wk = weekList().find((w) => w.key === state.selectedKey);
    const lines = [`Picks NFL · ${wk ? wk.label : ''} · Temporada ${state.year}`];
    ordered.forEach((a) => lines.push(`${String(a.points).padStart(2, ' ')} pts · ${a.pickTeam.abbr} (${a.pick === 'home' ? 'vs' : 'en'} ${a.otherTeam.abbr}) · ${pct(a.prob)} · línea ${lineText(a)}`));
    const text = lines.join('\n');
    const done = () => setBanner('Lista copiada al portapapeles.', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copia la lista:', text));
    else window.prompt('Copia la lista:', text);
  }

  function selectTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['picks', 'standings', 'injuries', 'method'].forEach((n) => { $(`#tab-${n}`).hidden = n !== name; });
  }

  function init() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
    selectTab('picks');
    $('#games').addEventListener('click', onAction);
    $('#injuries').addEventListener('click', onAction);
    $('#btn-refresh').addEventListener('click', () => load(true));
    $('#btn-settings').addEventListener('click', () => { const s = $('#settings'); s.hidden = !s.hidden; $('#btn-settings').setAttribute('aria-expanded', String(!s.hidden)); });
    $('#btn-close-settings').addEventListener('click', () => { $('#settings').hidden = true; $('#btn-settings').setAttribute('aria-expanded', 'false'); });
    $('#btn-defaults').addEventListener('click', () => { const proxy = state.settings.proxy; state.settings = Object.assign({}, M.DEFAULT_SETTINGS, { proxy }); saveSettings(); renderSettings(); renderPicks(); renderStandings(); renderInjuries(); });
    $('#btn-reset-order').addEventListener('click', () => { delete state.overrides.order[state.selectedKey]; saveOverrides(); renderPicks(); });
    $('#btn-reset-picks').addEventListener('click', () => { const ids = new Set(state.games.filter((g) => g.key === state.selectedKey).map((g) => g.id)); Object.keys(state.overrides.picks).forEach((id) => { if (ids.has(id)) delete state.overrides.picks[id]; }); saveOverrides(); renderPicks(); });
    $('#btn-copy').addEventListener('click', copyList);
    $('#week-select').addEventListener('change', (ev) => { state.selectedKey = Number(ev.target.value); state.openDetails.clear(); renderAll(); });
    const step = (d) => { const keys = Array.from(new Set(state.games.map((g) => g.key))).sort((a, b) => a - b); const i = keys.indexOf(state.selectedKey); if (keys[i + d] != null) { state.selectedKey = keys[i + d]; state.openDetails.clear(); renderAll(); } };
    $('#week-prev').addEventListener('click', () => step(-1));
    $('#week-next').addEventListener('click', () => step(1));
    renderSettings();
    // Pintar primero lo guardado, luego actualizar.
    const meta = loadJSON(LS.meta);
    if (meta && meta.year) {
      state.year = meta.year;
      state.currentKey = meta.type === 3 ? M.orderKey(3, meta.week) : M.orderKey(2, meta.week || 1);
      state.cache = loadJSON(LS.cache(meta.year)) || { weeks: {}, injuries: null, standings: null };
      state.overrides = Object.assign({ picks: {}, injuries: {}, order: {} }, loadJSON(LS.overrides(meta.year)) || {});
      assemble();
      if (state.games.length) { state.selectedKey = pickDefaultWeek(); renderAll(); }
    }
    load(false);
  }

  document.addEventListener('DOMContentLoaded', init);
  window.PicksApp = { state, compute, load };
})();
