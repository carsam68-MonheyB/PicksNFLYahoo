/* Motor de cálculo para la asignación de puntos de confianza (Yahoo NFL Pick'em).
   Sin dependencias ni DOM: se puede ejecutar en el navegador o en Node para pruebas. */
(function (root) {
  'use strict';

  // Conferencia y división por abreviatura de ESPN.
  const DIVISIONS = {
    BUF: ['AFC', 'Este'], MIA: ['AFC', 'Este'], NE: ['AFC', 'Este'], NYJ: ['AFC', 'Este'],
    BAL: ['AFC', 'Norte'], CIN: ['AFC', 'Norte'], CLE: ['AFC', 'Norte'], PIT: ['AFC', 'Norte'],
    HOU: ['AFC', 'Sur'], IND: ['AFC', 'Sur'], JAX: ['AFC', 'Sur'], TEN: ['AFC', 'Sur'],
    DEN: ['AFC', 'Oeste'], KC: ['AFC', 'Oeste'], LV: ['AFC', 'Oeste'], LAC: ['AFC', 'Oeste'],
    DAL: ['NFC', 'Este'], NYG: ['NFC', 'Este'], PHI: ['NFC', 'Este'], WSH: ['NFC', 'Este'], WAS: ['NFC', 'Este'],
    CHI: ['NFC', 'Norte'], DET: ['NFC', 'Norte'], GB: ['NFC', 'Norte'], MIN: ['NFC', 'Norte'],
    ATL: ['NFC', 'Sur'], CAR: ['NFC', 'Sur'], NO: ['NFC', 'Sur'], TB: ['NFC', 'Sur'],
    ARI: ['NFC', 'Oeste'], LAR: ['NFC', 'Oeste'], SF: ['NFC', 'Oeste'], SEA: ['NFC', 'Oeste'],
  };

  // Impacto (en puntos de línea) de perder a un jugador por posición.
  const POS_WEIGHTS = {
    QB: 6, RB: 1.5, WR: 1.5, TE: 1.0, FB: 0.3,
    OT: 1.2, T: 1.2, G: 0.8, OG: 0.8, C: 1.0, OL: 1.0,
    DE: 1.2, DT: 1.0, NT: 0.8, DL: 1.0, EDGE: 1.2, OLB: 1.0, LB: 0.8, ILB: 0.8, MLB: 0.8,
    CB: 1.2, S: 0.8, FS: 0.8, SS: 0.8, DB: 0.8,
    K: 0.8, PK: 0.8, P: 0.3, LS: 0.2,
  };
  const DEFAULT_POS_WEIGHT = 0.6;

  // Multiplicador según estatus en el reporte de lesiones (orden de evaluación).
  const STATUS_MULT = [
    ['injured reserve', 1], ['physically unable', 1], ['non-football', 1], ['suspend', 1],
    ['doubtful', 0.75], ['questionable', 0.35], ['day-to-day', 0.35], ['probable', 0.1],
    ['out', 1], ['ir', 1], ['pup', 1], ['nfi', 1],
  ];

  const POSTSEASON_LABELS = { 1: 'Comodines', 2: 'Ronda divisional', 3: 'Campeonatos de conferencia', 5: 'Super Bowl' };

  const DEFAULT_SETTINGS = {
    recency: 0.85,      // peso de cada jornada anterior respecto a la última (0.5–1)
    homeAdv: 2.0,       // ventaja de local en puntos
    recordBlend: 0.35,  // mezcla: 0 = solo margen (SRS), 1 = solo récord
    prior: 2,           // partidos "neutros" de regularización del rating
    marginCap: 24,      // tope del margen por partido
    h2hW: 0.25,         // peso del enfrentamiento directo de la temporada
    commonW: 0.3,       // peso de rivales comunes
    chainW: 0.8,        // puntos por cadena transitiva neta (A venció a X, X venció a B)
    chainCap: 3,        // tope del ajuste por cadenas
    injuryScale: 0.6,   // escala global de bajas
    injuryCap: 9,       // tope de penalización por equipo
    spreadSd: 13.5,     // desviación estándar de la línea → probabilidad
    proxy: '',          // prefijo opcional de proxy CORS
  };

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  // Función de distribución normal estándar (aproximación de Abramowitz–Stegun).
  function phi(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  const orderKey = (seasonType, week) => seasonType * 100 + week;

  function weekLabel(seasonType, week) {
    if (seasonType === 3) return POSTSEASON_LABELS[week] || ('Postemporada ' + week);
    if (seasonType === 1) return 'Pretemporada ' + week;
    return 'Semana ' + week;
  }

  function teamInfo(abbr) {
    const d = DIVISIONS[abbr] || ['—', '—'];
    return { conf: d[0], division: d[1] };
  }

  // Convierte un evento del scoreboard de ESPN a la forma compacta que usa la app.
  function normalizeEvent(ev, fallbackSeasonType, fallbackWeek) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const status = (comp.status && comp.status.type) || (ev.status && ev.status.type) || {};
    const seasonType = Number((ev.season && ev.season.type) || fallbackSeasonType || 2);
    const week = Number((ev.week && ev.week.number) || fallbackWeek || 0);
    const competitors = comp.competitors || [];
    const side = (ha) => {
      const c = competitors.find((x) => x.homeAway === ha) || competitors[ha === 'home' ? 0 : 1] || {};
      const t = c.team || {};
      const rec = (c.records || []).find((r) => r.type === 'total' || r.name === 'overall');
      const abbr = t.abbreviation || '';
      return {
        id: String(t.id || abbr),
        abbr,
        name: t.displayName || t.name || abbr,
        short: t.shortDisplayName || t.name || abbr,
        logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || '',
        color: t.color || '',
        score: c.score != null && c.score !== '' ? Number(c.score) : null,
        winner: c.winner === true,
        record: rec ? rec.summary : '',
      };
    };
    const broadcast = (comp.broadcasts || []).map((b) => (b.names || []).join('/')).filter(Boolean).join(', ');
    return {
      id: String(ev.id),
      key: orderKey(seasonType, week),
      seasonType,
      week,
      date: ev.date || comp.date || '',
      neutral: comp.neutralSite === true,
      completed: status.completed === true || status.state === 'post',
      state: status.state || 'pre',
      detail: status.shortDetail || status.detail || status.description || '',
      shortName: ev.shortName || ev.name || '',
      venue: (comp.venue && comp.venue.fullName) || '',
      broadcast,
      home: side('home'),
      away: side('away'),
    };
  }

  function normalizeInjuries(payload) {
    const out = {};
    const teams = (payload && (payload.injuries || payload.items)) || [];
    teams.forEach((t) => {
      const teamId = String(t.id || (t.team && t.team.id) || '');
      const abbr = t.abbreviation || (t.team && t.team.abbreviation) || '';
      const entries = t.injuries || t.items || [];
      const list = entries.map((e) => {
        const a = e.athlete || {};
        const pos = (a.position && (a.position.abbreviation || a.position.name)) || e.position || '';
        return {
          athleteId: String(a.id || (a.displayName + '|' + teamId)),
          name: a.displayName || a.shortName || 'Jugador',
          pos: String(pos).toUpperCase(),
          status: e.status || (e.type && (e.type.description || e.type.name)) || '',
          detail: (e.details && (e.details.type || e.details.detail)) || e.shortComment || '',
          date: e.date || '',
          returnDate: (e.details && e.details.returnDate) || '',
        };
      });
      if (teamId) out[teamId] = { teamId, abbr, name: t.displayName || (t.team && t.team.displayName) || abbr, list };
    });
    return out;
  }

  function statusMultiplier(status) {
    const s = String(status || '').toLowerCase().trim();
    if (!s) return 0.5;
    for (const [k, m] of STATUS_MULT) {
      if (s === k || s.includes(k)) return m;
    }
    return 0.5;
  }

  function injuryPenalty(team, settings, overrides) {
    const list = (team && team.list) || [];
    const marks = (overrides && overrides.injuries) || {};
    let qbSeen = 0;
    const items = list.map((e) => {
      let posW = POS_WEIGHTS[e.pos] != null ? POS_WEIGHTS[e.pos] : DEFAULT_POS_WEIGHT;
      let qbNote = '';
      if (e.pos === 'QB') {
        qbSeen += 1;
        if (qbSeen > 1) { posW = 1.0; qbNote = 'QB suplente (peso reducido)'; }
      }
      const sMult = statusMultiplier(e.status);
      const mark = marks[e.athleteId] || '';
      const factor = mark === 'ignore' ? 0 : mark === 'key' ? 1.6 : 1;
      const contribution = posW * sMult * factor * settings.injuryScale;
      return Object.assign({}, e, { posW, sMult, mark, qbNote, contribution });
    });
    items.sort((a, b) => b.contribution - a.contribution);
    const raw = items.reduce((s, i) => s + i.contribution, 0);
    return { items, raw, total: Math.min(raw, settings.injuryCap), capped: raw > settings.injuryCap };
  }

  function emptyStats(id) {
    return { id, gp: 0, w: 0, l: 0, t: 0, pf: 0, pa: 0, results: [], srs: 0, recordRating: 0, rating: 0, wpct: 0, wpctW: 0, lastGame: null, streak: '' };
  }

  // Estadísticas y ratings con los partidos terminados antes de `beforeKey`.
  function computeStats(games, beforeKey, settings) {
    const stats = {};
    const get = (id) => (stats[id] || (stats[id] = emptyStats(id)));
    const played = games
      .filter((g) => g.completed && g.key < beforeKey && g.seasonType >= 2 && g.home.score != null && g.away.score != null)
      .sort((a, b) => a.key - b.key || a.date.localeCompare(b.date));

    const keys = Array.from(new Set(played.map((g) => g.key))).sort((a, b) => a - b);
    const idx = new Map(keys.map((k, i) => [k, i]));
    const latest = keys.length; // índice "actual" = última jornada + 1

    played.forEach((g) => {
      const hs = g.home.score, as = g.away.score;
      const w = Math.pow(settings.recency, latest - 1 - idx.get(g.key));
      const hAdj = g.neutral ? 0 : settings.homeAdv;
      const add = (me, opp, pf, pa, isHome) => {
        const s = get(me.id);
        const margin = pf - pa;
        s.gp += 1; s.pf += pf; s.pa += pa;
        if (margin > 0) s.w += 1; else if (margin < 0) s.l += 1; else s.t += 1;
        const r = {
          gameId: g.id, opp: opp.id, oppAbbr: opp.abbr, oppName: opp.short, week: g.week, seasonType: g.seasonType, key: g.key,
          home: isHome, neutral: g.neutral, pf, pa, margin,
          cappedMargin: clamp(margin, -settings.marginCap, settings.marginCap),
          adjMargin: clamp(margin, -settings.marginCap, settings.marginCap) - (isHome ? hAdj : -hAdj),
          won: margin > 0, tie: margin === 0, weight: w,
        };
        s.results.push(r);
        s.lastGame = r;
      };
      add(g.home, g.away, hs, as, true);
      add(g.away, g.home, as, hs, false);
    });

    const ids = Object.keys(stats);
    // Récord ponderado por recencia
    ids.forEach((id) => {
      const s = stats[id];
      const sw = s.results.reduce((a, r) => a + r.weight, 0);
      s.wpct = s.gp ? (s.w + 0.5 * s.t) / s.gp : 0;
      s.wpctW = sw ? s.results.reduce((a, r) => a + r.weight * (r.won ? 1 : r.tie ? 0.5 : 0), 0) / sw : 0;
      s.recordRating = s.gp ? (s.wpctW - 0.5) * 20 * (s.gp / (s.gp + settings.prior)) : 0;
      // racha
      let streak = 0, kind = '';
      for (let i = s.results.length - 1; i >= 0; i--) {
        const r = s.results[i];
        const k = r.won ? 'G' : r.tie ? 'E' : 'P';
        if (!kind) kind = k;
        if (k !== kind) break;
        streak += 1;
      }
      s.streak = kind ? kind + streak : '';
    });

    // SRS (Simple Rating System) iterativo con recencia y regularización.
    ids.forEach((id) => { stats[id].srs = 0; });
    for (let it = 0; it < 300; it++) {
      let maxDelta = 0;
      const next = {};
      ids.forEach((id) => {
        const s = stats[id];
        let num = 0, den = settings.prior;
        s.results.forEach((r) => {
          const o = stats[r.opp];
          num += r.weight * (r.adjMargin + (o ? o.srs : 0));
          den += r.weight;
        });
        next[id] = den ? num / den : 0;
      });
      const mean = avg(ids.map((id) => next[id]));
      ids.forEach((id) => {
        const v = next[id] - mean;
        maxDelta = Math.max(maxDelta, Math.abs(v - stats[id].srs));
        stats[id].srs = v;
      });
      if (maxDelta < 1e-6) break;
    }
    ids.forEach((id) => {
      const s = stats[id];
      s.rating = (1 - settings.recordBlend) * s.srs + settings.recordBlend * s.recordRating;
    });
    return stats;
  }

  function oppMargins(s) {
    const m = {};
    (s.results || []).forEach((r) => {
      (m[r.opp] || (m[r.opp] = { abbr: r.oppAbbr, name: r.oppName, margins: [], games: [] })).margins.push(r.cappedMargin);
      m[r.opp].games.push(r);
    });
    Object.values(m).forEach((v) => { v.avg = avg(v.margins); });
    return m;
  }

  // Análisis de un partido: componentes de la línea estimada y probabilidad.
  function analyzeGame(game, stats, injuries, settings, overrides) {
    const H = stats[game.home.id] || emptyStats(game.home.id);
    const A = stats[game.away.id] || emptyStats(game.away.id);
    const homeAdv = game.neutral ? 0 : settings.homeAdv;
    const base = H.rating - A.rating;

    // Enfrentamiento directo en la temporada
    const h2hGames = H.results.filter((r) => r.opp === game.away.id);
    const h2h = h2hGames.length ? avg(h2hGames.map((r) => r.cappedMargin)) * settings.h2hW : 0;

    // Rivales comunes
    const mh = oppMargins(H), ma = oppMargins(A);
    const commonDetails = Object.keys(mh)
      .filter((o) => ma[o] && o !== game.away.id && o !== game.home.id)
      .map((o) => ({ opp: o, abbr: mh[o].abbr, name: mh[o].name, homeAvg: mh[o].avg, awayAvg: ma[o].avg, diff: mh[o].avg - ma[o].avg }));
    const common = commonDetails.length ? avg(commonDetails.map((c) => c.diff)) * settings.commonW : 0;

    // Cadenas transitivas de segundo grado
    const beat = (s) => new Set(s.results.filter((r) => r.won).map((r) => r.opp));
    const lostTo = (s) => new Set(s.results.filter((r) => !r.won && !r.tie).map((r) => r.opp));
    const hBeat = beat(H), hLost = lostTo(H), aBeat = beat(A), aLost = lostTo(A);
    const nameOf = (id) => (mh[id] && mh[id].abbr) || (ma[id] && ma[id].abbr) || id;
    const chainsHome = [...hBeat].filter((x) => aLost.has(x)).map((x) => ({ via: nameOf(x), text: `${game.home.abbr} venció a ${nameOf(x)} y ${nameOf(x)} venció a ${game.away.abbr}` }));
    const chainsAway = [...aBeat].filter((x) => hLost.has(x)).map((x) => ({ via: nameOf(x), text: `${game.away.abbr} venció a ${nameOf(x)} y ${nameOf(x)} venció a ${game.home.abbr}` }));
    const chains = clamp((chainsHome.length - chainsAway.length) * settings.chainW, -settings.chainCap, settings.chainCap);

    // Bajas
    const injH = injuryPenalty(injuries[game.home.id], settings, overrides);
    const injA = injuryPenalty(injuries[game.away.id], settings, overrides);

    const spreadHome = base + homeAdv + h2h + common + chains - injH.total + injA.total;
    const probHome = clamp(phi(spreadHome / settings.spreadSd), 0.01, 0.99);
    const modelPick = probHome >= 0.5 ? 'home' : 'away';
    const forced = overrides && overrides.picks && overrides.picks[game.id];
    const pick = forced === 'home' || forced === 'away' ? forced : modelPick;
    const prob = pick === 'home' ? probHome : 1 - probHome;

    return {
      game, H, A, homeAdv, base, h2h, h2hGames, common, commonDetails, chains, chainsHome, chainsAway,
      injH, injA, spreadHome, probHome, modelPick, pick, prob, overridden: pick !== modelPick,
      pickTeam: pick === 'home' ? game.home : game.away,
      otherTeam: pick === 'home' ? game.away : game.home,
    };
  }

  // Ordena los partidos y reparte N…1 puntos. `manualOrder` (ids) tiene prioridad si cubre todos los partidos.
  function allocatePoints(analyses, manualOrder) {
    const byModel = analyses.slice().sort((a, b) => b.prob - a.prob || Math.abs(b.spreadHome) - Math.abs(a.spreadHome) || a.game.date.localeCompare(b.game.date));
    let ordered = byModel;
    if (manualOrder && manualOrder.length === analyses.length) {
      const map = new Map(analyses.map((a) => [a.game.id, a]));
      const m = manualOrder.map((id) => map.get(id)).filter(Boolean);
      if (m.length === analyses.length) ordered = m;
    }
    const n = ordered.length;
    ordered.forEach((a, i) => { a.points = n - i; a.rank = i + 1; a.modelRank = byModel.indexOf(a) + 1; });
    return ordered;
  }

  // Tabla de posiciones calculada a partir de resultados (más datos oficiales si existen).
  function standings(stats, teams, official) {
    const rows = Object.values(teams).map((t) => {
      const s = stats[t.id] || emptyStats(t.id);
      const info = teamInfo(t.abbr);
      let dw = 0, dl = 0, dt = 0, cw = 0, cl = 0, ct = 0;
      s.results.forEach((r) => {
        const o = teams[r.opp];
        if (!o) return;
        const oi = teamInfo(o.abbr);
        if (oi.conf === info.conf) { if (r.won) cw++; else if (r.tie) ct++; else cl++; }
        if (oi.conf === info.conf && oi.division === info.division) { if (r.won) dw++; else if (r.tie) dt++; else dl++; }
      });
      const off = (official && official[t.id]) || {};
      return Object.assign({ team: t, conf: info.conf, division: info.division, stats: s, divRecord: `${dw}-${dl}${dt ? '-' + dt : ''}`, confRecord: `${cw}-${cl}${ct ? '-' + ct : ''}`, divPct: dw + dl + dt ? (dw + 0.5 * dt) / (dw + dl + dt) : 0 }, off);
    });
    rows.sort((a, b) => b.stats.wpct - a.stats.wpct || b.divPct - a.divPct || (b.stats.pf - b.stats.pa) - (a.stats.pf - a.stats.pa) || b.stats.rating - a.stats.rating);
    const groups = {};
    rows.forEach((r) => {
      const g = `${r.conf} ${r.division}`;
      (groups[g] || (groups[g] = [])).push(r);
    });
    Object.values(groups).forEach((list) => list.forEach((r, i) => { r.divRank = i + 1; }));
    const byConf = {};
    rows.forEach((r) => { (byConf[r.conf] || (byConf[r.conf] = [])).push(r); });
    Object.values(byConf).forEach((list) => list.forEach((r, i) => { r.confRank = i + 1; }));
    return { rows, groups };
  }

  function normalizeStandings(payload) {
    const out = {};
    const walk = (node, groupName) => {
      if (!node || typeof node !== 'object') return;
      const name = node.name || node.abbreviation || groupName;
      const entries = (node.standings && node.standings.entries) || node.entries || [];
      entries.forEach((e) => {
        const id = String((e.team && e.team.id) || '');
        if (!id) return;
        const st = {};
        (e.stats || []).forEach((s) => { st[s.name] = s.displayValue != null ? s.displayValue : s.value; });
        out[id] = { group: name, seed: st.playoffSeed || '', officialStreak: st.streak || '', clincher: (e.team && e.team.clincher) || '' };
      });
      (node.children || []).forEach((c) => walk(c, name));
    };
    walk(payload, '');
    return out;
  }

  const api = {
    DIVISIONS, POS_WEIGHTS, STATUS_MULT, DEFAULT_SETTINGS, POSTSEASON_LABELS,
    phi, orderKey, weekLabel, teamInfo, normalizeEvent, normalizeInjuries, normalizeStandings,
    statusMultiplier, injuryPenalty, computeStats, analyzeGame, allocatePoints, standings, clamp, avg,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PicksModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
