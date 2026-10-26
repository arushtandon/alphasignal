#!/usr/bin/env node
'use strict';

// Research only. Re-scores the three momentum books that the cell strategy
// search surfaced, under the current standards of the strategy-gaps amendment
// (docs/strategy-gaps-amendment-2026-10-06.md):
//   - ever-member universes (every name that was a member on any replayed date),
//     a signal requires membership on the signal date;
//   - point-in-time Piotroski from dated statements, filing date + 45 days;
//   - signal at the month-end close, enter next open, exit next open;
//   - monthly excess t versus the market benchmark; alpha and alpha t
//     (US: SPY and QQQ together; UK: EWU); QQQ hurdle for US;
//   - executable k=1 and k=2 books, $30,000 tickets, real lot sizing;
//   - UK stamp duty on UK buys through implementation-cost-v1.
//
//   node scripts/run-momentum-rescore.js

const fs = require('fs');
const path = require('path');
const { estimateRoundTripCostPct } = require('../lib/research/cost-model');
const { buildPitPiotroskiScores } = require('../lib/research/pit-piotroski');
const { membershipAt } = require('../lib/research/us-universe');
const { buildDateAlignedFolds } = require('../lib/research/walk-forward-optimizer');
const { EMBARGO, FOLD_SPEC } = require('../lib/research/consistency-study');
const {
  compound, maxDrawdown, tStat, tradeStats, sharpe, twoFactor, deflatedSharpe,
} = require('../lib/research/strategy-gaps');

const ROOT = path.join(__dirname, '..');
const PRICE_DIRS = [
  path.join(ROOT, 'data', 'research', 'strategy-amendment-prices'),
  path.join(ROOT, 'data', 'research', 'exit-amendment-prices'),
];
const FMP_DIR = path.join(ROOT, 'data', 'research', 'fmp');
const MEMBER_DIR = path.join(ROOT, 'data', 'research', 'index-membership');
const OUT_JSON = path.join(ROOT, 'scripts', 'momentum-rescore-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'momentum-rescore-2026-10-25.md');
const TICKET = 30000;
const TOP = 10;
const US_SIGNAL_START = '2014-01-23';
const SAMPLE_START = '2010-01-01';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function dateOf(bar) {
  const value = Number(bar?.t ?? bar);
  if (!value) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
}
function pack(raw) {
  const bars = Array.isArray(raw) ? raw : (raw?.bars || []);
  const dates = []; const open = []; const close = [];
  for (const bar of bars) {
    const date = dateOf(bar);
    if (!date || !(Number(bar.c) > 0)) continue;
    dates.push(date);
    open.push(Number(bar.o) > 0 ? Number(bar.o) : Number(bar.c));
    close.push(Number(bar.c));
  }
  return { dates, open, close };
}
function priceFile(symbol) {
  const name = `${String(symbol).replace(/^\^/, '_').replace(/[\\/]/g, '_')}.json`;
  for (const dir of PRICE_DIRS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
function loadSeries(symbol) {
  const file = priceFile(symbol);
  return file ? pack(readJson(file)) : null;
}
function indexOf(series, date) {
  let lo = 0; let hi = series.dates.length - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
function firstOnOrAfter(series, date) {
  let lo = 0; let hi = series.dates.length - 1; let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] >= date) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found;
}
function monthEnds(series) {
  const ends = [];
  for (let index = 1; index < series.dates.length; index += 1) {
    if (series.dates[index].slice(0, 7) !== series.dates[index - 1].slice(0, 7)) ends.push(index - 1);
  }
  return ends;
}
function everMembers(snapshot) {
  const ever = new Set(snapshot.currentSymbols || []);
  const dates = [];
  for (const change of snapshot.historicalMembership?.changes || []) {
    if (change.added) ever.add(change.added);
    if (change.removed) ever.add(change.removed);
    if (change.date) dates.push(change.date);
  }
  for (const date of dates) for (const symbol of membershipAt(snapshot, date)) ever.add(symbol);
  return ever;
}
function shiftFiling(row) {
  const filed = row?.acceptedDate || row?.filingDate;
  if (!filed || !Number.isFinite(Date.parse(filed))) return null;
  const available = new Date(Date.parse(filed) + 45 * 86400000).toISOString().slice(0, 10);
  return { ...row, acceptedDate: available, filingDate: available };
}
function loadScores(market, symbol) {
  const dir = path.join(FMP_DIR, market, symbol);
  const read = kind => {
    const file = path.join(dir, `${kind}.json`);
    if (!fs.existsSync(file)) return [];
    const record = readJson(file);
    if (record.status !== 'OK' || !Array.isArray(record.rows)) return [];
    return record.rows.map(shiftFiling).filter(Boolean);
  };
  const statements = {
    incomeStatements: read('income'), balanceSheets: read('balance'), cashFlowStatements: read('cashflow'), market,
  };
  if (!statements.incomeStatements.length) return null;
  const pio = buildPitPiotroskiScores(statements);
  return (pio.scores || [])
    .map(row => ({ availableOn: row.availableOn, score: row.score }))
    .sort((a, b) => String(a.availableOn).localeCompare(String(b.availableOn)));
}
function scoreBefore(scores, date) {
  if (!scores) return null;
  let found = null;
  for (const row of scores) {
    if (row.availableOn < date) found = row.score; else break;
  }
  return found;
}
function notional(symbol, market, price) {
  const scale = String(symbol).toUpperCase().endsWith('.L') || market === 'UK' ? 0.01 : 1;
  const px = price * scale;
  if (!(px > 0)) return 0;
  const lots = px > TICKET ? 1 : Math.max(1, Math.floor(TICKET / px));
  return lots * px;
}
const pct = value => (value == null || !Number.isFinite(value) ? null : +(value * 100).toFixed(2));
const fix = (value, digits = 2) => (value == null || !Number.isFinite(value) ? null : +value.toFixed(digits));

// ── Universe ───────────────────────────────────────────────────────────────
function loadUniverse(spec) {
  const snapshot = readJson(spec.membershipFile);
  const ever = everMembers(snapshot);
  const candidates = spec.universe === 'current' ? new Set(snapshot.currentSymbols || []) : ever;
  const books = new Map();
  let withScores = 0;
  for (const symbol of candidates) {
    const series = loadSeries(symbol);
    if (!series || series.dates.length < 260) continue;
    const scores = spec.quality ? loadScores(spec.statementMarket, symbol) : null;
    if (scores && scores.length) withScores += 1;
    books.set(symbol, { symbol, series, scores });
  }
  const years = [];
  const changeYears = (snapshot.historicalMembership?.changes || []).map(row => String(row.date || '').slice(0, 4)).filter(Boolean).sort();
  for (let year = Number(changeYears[0]); year <= Number(changeYears[changeYears.length - 1]); year += 1) {
    const members = membershipAt(snapshot, `${year}-12-31`);
    let priced = 0;
    for (const symbol of members) if (priceFile(symbol)) priced += 1;
    years.push({ year, members: members.size, priced, missing: members.size - priced });
  }
  const former = [...ever].filter(symbol => !(snapshot.currentSymbols || []).includes(symbol));
  return {
    snapshot, books, years,
    coverage: {
      everMembers: ever.size,
      current: (snapshot.currentSymbols || []).length,
      former: former.length,
      formerPriced: former.filter(symbol => priceFile(symbol)).length,
      candidates: candidates.size,
      priced: books.size,
      withStatements: spec.quality ? withScores : null,
      formerWithStatements: spec.quality ? former.filter(symbol => books.get(symbol)?.scores?.length).length : null,
    },
  };
}

// ── Book simulation ────────────────────────────────────────────────────────
// Signal at month-end close `ends[e]`; enter at the open of ends[e]+1; each
// later month re-marks at the open of ends[e+1]+1. Research book: all TOP names
// equal weight, sleeves averaged. Executable k: top k names not already held,
// $30k tickets, slot count hold*k, empty slots earn 0.
function rankAt(universe, spec, benchmark, signalIndex) {
  const date = benchmark.dates[signalIndex];
  if (date < spec.signalStart) return [];
  const members = membershipAt(universe.snapshot, date);
  const ranked = [];
  for (const [symbol, row] of universe.books) {
    if (!members.has(symbol)) continue;
    const at = indexOf(row.series, date);
    if (at < 252) continue;
    if (spec.quality && !(scoreBefore(row.scores, date) >= 6)) continue;
    const from = row.series.close[at - 252];
    const to = row.series.close[at - 21];
    if (!(from > 0) || !(to > 0)) continue;
    ranked.push({ symbol, series: row.series, score: to / from - 1 });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
function simulate(universe, spec, benchmark, k) {
  const ends = monthEnds(benchmark);
  const hold = spec.horizon === 'long' ? 6 : 1;
  const slots = hold * (k || 1);
  const months = [];
  const trades = [];
  const sleeves = [];
  const sizes = [];
  let earlyExits = 0;
  for (let edge = 0; edge < ends.length - 1; edge += 1) {
    const entryIdx = ends[edge] + 1;
    const exitIdx = ends[edge + 1] + 1;
    if (exitIdx >= benchmark.open.length) break;
    const entryDate = benchmark.dates[entryIdx];
    const exitDate = benchmark.dates[exitIdx];
    const ranked = rankAt(universe, spec, benchmark, ends[edge]);
    const open = sleeves.filter(s => edge >= s.start && edge < s.start + hold).flatMap(s => s.names.map(n => n.symbol));
    const picked = k
      ? ranked.filter(row => !open.includes(row.symbol)).slice(0, k)
      : ranked.slice(0, TOP);
    sizes.push(picked.length);
    if (picked.length) {
      sleeves.push({
        start: edge,
        names: picked.map(row => ({
          ...row,
          equity: 1,
          cost: estimateRoundTripCostPct({ market: spec.costMarket, symbol: row.symbol, side: 'buy' }) / 100,
          stopped: false,
          scale: null,
        })),
      });
    }
    const active = sleeves.filter(s => edge >= s.start && edge < s.start + hold);
    let sum = 0;
    let count = 0;
    for (const sleeve of active) {
      const piece = [];
      for (const name of sleeve.names) {
        if (name.stopped) continue;
        const entryAt = firstOnOrAfter(name.series, entryDate);
        if (entryAt < 0 || !(name.series.open[entryAt] > 0)) { name.stopped = true; continue; }
        if (name.scale == null) name.scale = notional(name.symbol, spec.market, name.series.open[entryAt]) / TICKET;
        const exitAt = firstOnOrAfter(name.series, exitDate);
        let exitPx;
        if (exitAt > entryAt) exitPx = name.series.open[exitAt];
        else {
          const last = name.series.close.length - 1;
          exitPx = name.series.close[last];
          name.stopped = true;
          if (Date.parse(benchmark.dates[benchmark.dates.length - 1]) - Date.parse(name.series.dates[last]) > 7 * 86400000) earlyExits += 1;
        }
        const gross = exitPx / name.series.open[entryAt] - 1;
        const net = gross - (edge === sleeve.start ? name.cost : 0);
        name.equity *= 1 + net;
        piece.push(k ? net * name.scale : net);
      }
      if (!piece.length) continue;
      const sleeveRet = piece.reduce((a, b) => a + b, 0) / (k ? slots / hold : piece.length);
      if (k) { sum += sleeveRet; count = hold; } else { sum += sleeveRet; count += 1; }
      if (edge + 1 === sleeve.start + hold) {
        for (const name of sleeve.names) trades.push({ date: exitDate, symbol: name.symbol, ret: name.equity - 1 });
      }
    }
    // Research book: average of the active sleeves, scaled by how many of the
    // `hold` sleeves are invested (same convention as the prior momentum books).
    // Executable book: total over `slots`, empty slots earn 0.
    const ret = !count ? 0 : k ? sum / count : (sum / count) * Math.min(1, count / hold);
    months.push({ date: exitDate, entryDate, ret });
  }
  // Sample starts at the first month the book can be invested (first signal).
  const firstEntry = months.find(row => row.entryDate > spec.signalStart && row.date >= SAMPLE_START)?.date;
  return {
    months: months.filter(row => row.date >= SAMPLE_START && (!firstEntry || row.date >= firstEntry)),
    trades, sizes, earlyExits, hold, slots,
  };
}

// ── Scoring ────────────────────────────────────────────────────────────────
// Benchmark marked on the same sessions as the book: entry open → exit open.
function benchmarkMonths(series, months) {
  return months.map(row => {
    const entryAt = firstOnOrAfter(series, row.entryDate);
    const exitAt = firstOnOrAfter(series, row.date);
    const from = entryAt >= 0 ? series.open[entryAt] : null;
    const to = exitAt >= 0 ? series.open[exitAt] : null;
    return { date: row.date, ret: from > 0 && to > 0 ? to / from - 1 : 0 };
  });
}
function oneFactor(y, x) {
  const n = Math.min(y.length, x.length);
  if (n < 6) return null;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i += 1) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const denom = n * sxx - sx * sx;
  if (!(Math.abs(denom) > 1e-18)) return null;
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (y[i] - alpha - beta * x[i]) ** 2;
  const se = Math.sqrt(Math.max(0, sse / (n - 2)) * (1 / n + ((sx / n) ** 2) / (sxx - sx * sx / n)));
  return { n, alphaAnnual: alpha * 12, t: se > 0 ? alpha / se : null, beta };
}
function foldsFor(dates, horizon) {
  return buildDateAlignedFolds(dates, { ...FOLD_SPEC, embargoBars: EMBARGO[horizon] });
}
function yearly(months, bench) {
  const by = new Map();
  months.forEach((row, index) => {
    const year = row.date.slice(0, 4);
    if (!by.has(year)) by.set(year, { book: [], bench: [] });
    by.get(year).book.push(row.ret);
    by.get(year).bench.push(bench[index].ret);
  });
  return [...by.entries()].map(([year, v]) => ({ year, returnPct: pct(compound(v.book)), benchmarkReturnPct: pct(compound(v.bench)) }));
}
function scoreBook(label, sim, spec, series) {
  const { months, trades } = sim;
  const bench = benchmarkMonths(series.benchmark, months);
  const y = months.map(row => row.ret);
  const x = bench.map(row => row.ret);
  const excess = y.map((v, i) => v - x[i]);
  const folds = foldsFor(series.benchmark.dates, spec.horizon);
  const windows = folds.map(fold => {
    const inside = row => row.date >= fold.test.from && row.date <= fold.test.to;
    const slice = months.filter(inside);
    const bslice = bench.filter(inside);
    const windowTrades = trades.filter(inside).map(row => row.ret);
    const stats = tradeStats(windowTrades);
    return {
      fold: fold.fold, from: fold.test.from, to: fold.test.to,
      returnPct: pct(compound(slice.map(r => r.ret))),
      benchmarkReturnPct: pct(compound(bslice.map(r => r.ret))),
      excessPp: pct(compound(slice.map(r => r.ret)) - compound(bslice.map(r => r.ret))),
      trades: stats.n,
      win: stats.win == null ? null : +(stats.win * 100).toFixed(1),
      pf: stats.pf === Infinity ? null : fix(stats.pf, 3),
      pfInfinite: stats.pf === Infinity,
      maxDrawdownPct: pct(maxDrawdown(slice.map(r => r.ret))),
    };
  });
  const excessT = tStat(excess);
  const full = tradeStats(trades.map(row => row.ret));
  const net = compound(y);
  const benchRet = compound(x);
  let alpha;
  let qqq = null;
  if (spec.market === 'US' && series.qqq) {
    const q = benchmarkMonths(series.qqq, months).map(row => row.ret);
    const fit = twoFactor(y, x, q);
    alpha = fit ? { model: 'SPY+QQQ', alphaAnnualPct: pct(fit.alphaAnnual), t: fix(fit.t), betaSpy: fix(fit.betaSpy), betaQqq: fix(fit.betaQqq), n: fit.n } : null;
    const spyOnly = oneFactor(y, x);
    const qqqRet = compound(q);
    qqq = {
      qqqReturnPct: pct(qqqRet),
      bookMinusQqqPp: pct(net - qqqRet),
      qqqMaxDrawdownPct: pct(maxDrawdown(q)),
      bookSharpe: fix(sharpe(y).sharpe), qqqSharpe: fix(sharpe(q).sharpe),
      beatsQqq: net > qqqRet || (net === qqqRet && maxDrawdown(y) < maxDrawdown(q)),
      windows: folds.map(fold => {
        const inside = row => row.date >= fold.test.from && row.date <= fold.test.to;
        const b = months.filter(inside).map(r => r.ret);
        const qq = months.map((row, i) => ({ date: row.date, ret: q[i] })).filter(inside).map(r => r.ret);
        return { fold: fold.fold, excessPp: pct(compound(b) - compound(qq)) };
      }),
      spyOnlyAlpha: spyOnly ? { alphaAnnualPct: pct(spyOnly.alphaAnnual), t: fix(spyOnly.t), beta: fix(spyOnly.beta) } : null,
    };
  } else {
    const fit = oneFactor(y, x);
    alpha = fit ? { model: spec.benchmark, alphaAnnualPct: pct(fit.alphaAnnual), t: fix(fit.t), beta: fix(fit.beta), n: fit.n } : null;
  }
  const judged = windows.filter(w => w.trades > 0);
  const allProfitable = windows.length === 4 && judged.length > 0 && judged.every(w => w.returnPct > 0 && (w.pfInfinite || w.pf >= 1.2));
  const positiveWindows = windows.filter(w => w.returnPct > 0).length;
  const excessPositive = windows.filter(w => w.excessPp > 0).length;
  const dd = maxDrawdown(y);
  const validation = allProfitable && net > benchRet && excessT.t != null && excessT.t >= 3
    && alpha && alpha.t != null && alpha.t >= 2 && (spec.market !== 'US' || (qqq && qqq.beatsQqq));
  const incubation = !validation && net - benchRet > 0 && positiveWindows >= 3 && excessT.t != null && excessT.t >= 1.5 && dd < 0.5;
  return {
    label,
    months: months.length,
    firstMonth: months[0]?.date || null,
    lastMonth: months[months.length - 1]?.date || null,
    full: {
      returnPct: pct(net), benchmarkReturnPct: pct(benchRet), excessPp: pct(net - benchRet),
      maxDrawdownPct: pct(dd), benchmarkMaxDrawdownPct: pct(maxDrawdown(x)),
      sharpeMonthly: fix(sharpe(y).sharpe), sharpeAnnual: fix((sharpe(y).sharpe || 0) * Math.sqrt(12)),
      trades: full.n, win: full.win == null ? null : +(full.win * 100).toFixed(1),
      pf: full.pf === Infinity ? null : fix(full.pf, 3),
      medianNames: sim.sizes.length ? [...sim.sizes].sort((a, b) => a - b)[Math.floor(sim.sizes.length / 2)] : 0,
      earlyExits: sim.earlyExits,
    },
    excess: { t: fix(excessT.t), n: excessT.n, meanMonthlyPct: pct(excess.reduce((a, b) => a + b, 0) / (excess.length || 1)), sharpe: fix(sharpe(excess).sharpe) },
    alpha,
    qqq,
    windows,
    positiveWindows,
    excessPositiveWindows: excessPositive,
    verdict: validation ? 'VALIDATION_PASS' : incubation ? 'INCUBATION_ELIGIBLE' : 'FAIL',
    failReasons: validation ? [] : [
      !allProfitable ? `windows: ${windows.map(w => `${w.returnPct}%/PF ${w.pfInfinite ? '∞' : w.pf}`).join(', ')}` : null,
      !(net > benchRet) ? 'full sample does not beat benchmark' : null,
      !(excessT.t >= 3) ? `excess t ${fix(excessT.t)} < 3` : null,
      !(alpha && alpha.t >= 2) ? `alpha t ${alpha ? fix(alpha.t) : '—'} < 2` : null,
      spec.market === 'US' && !(qqq && qqq.beatsQqq) ? 'does not beat QQQ' : null,
    ].filter(Boolean),
    years: yearly(months, bench),
    monthlyReturns: y,
    excessReturns: excess,
  };
}

const CELLS = [
  {
    id: 'US__long__12-1__piotroski6', market: 'US', horizon: 'long', quality: true,
    membershipFile: path.join(FMP_DIR, 'us-universe.json'), statementMarket: 'US', universe: 'ever',
    benchmark: 'SPY', costMarket: 'US', signalStart: US_SIGNAL_START,
    strategy: '12-1 momentum among point-in-time Piotroski ≥ 6, top 10, six-month hold in six sleeves',
    cell: 'US long', prior: ['B__US__long__piotroski6__regimeoff (new-strategy-types PASS)', 'B__US__long__piotroski6__regimeoff__longsample (amendment CANDIDATE)'],
    liveNote: 'Not live. docs/us-long-piotroski-paper-design.md is a paper design only; no setup-book cell, flag, or order exists.',
  },
  {
    id: 'UK__long__12-1__piotroski6', market: 'UK', horizon: 'long', quality: true,
    membershipFile: path.join(MEMBER_DIR, 'ftse100.json'), statementMarket: 'UK', universe: 'ever',
    benchmark: 'EWU', costMarket: 'UK', signalStart: SAMPLE_START,
    strategy: '12-1 momentum among point-in-time Piotroski ≥ 6, top 10, six-month hold in six sleeves',
    cell: 'UK long', prior: ['B__UK__long__piotroski6__regimeoff (new-strategy-types PASS, current constituents)'],
    liveNote: 'Not live. The live UK_LONG_MOMENTUM is plain 12-1, k=1, no Piotroski screen.',
  },
  {
    id: 'UK__long__12-1__plain', market: 'UK', horizon: 'long', quality: false,
    membershipFile: path.join(MEMBER_DIR, 'ftse100.json'), statementMarket: 'UK', universe: 'ever',
    benchmark: 'EWU', costMarket: 'UK', signalStart: SAMPLE_START,
    strategy: 'Plain 12-1 momentum, top 10, six-month hold in six sleeves (the live UK_LONG_MOMENTUM definition; k=1 row is the live book)',
    cell: 'UK long', prior: ['UK__long__k1 (executable-momentum 2026-10-06)', 'docs/momentum-check-2026-10-07.md'],
    liveNote: 'LIVE as UK_LONG_MOMENTUM at k=1 (Experimental).',
  },
  {
    id: 'UK__medium__12-1__plain', market: 'UK', horizon: 'medium', quality: false,
    membershipFile: path.join(MEMBER_DIR, 'ftse100.json'), statementMarket: 'UK', universe: 'ever',
    benchmark: 'EWU', costMarket: 'UK', signalStart: SAMPLE_START,
    strategy: 'Plain 12-1 momentum, top 10, one-month hold, monthly rebalance',
    cell: 'UK medium', prior: ['B__UK__medium__momentum__regimeoff (new-strategy-types CANDIDATE, current constituents)'],
    liveNote: 'Not live.',
  },
  {
    id: 'UK__medium__12-1__plain__currentSymbols', market: 'UK', horizon: 'medium', quality: false,
    membershipFile: path.join(MEMBER_DIR, 'ftse100.json'), statementMarket: 'UK', universe: 'current',
    benchmark: 'EWU', costMarket: 'UK', signalStart: SAMPLE_START,
    strategy: 'Same book on the current-constituent universe (reconciliation row; not a candidate)',
    cell: 'UK medium', prior: [], reconciliationOnly: true,
    liveNote: 'Reconciliation only.',
  },
];

function main() {
  const spy = loadSeries('SPY');
  const qqqSeries = loadSeries('QQQ');
  const ewu = loadSeries('EWU');
  const results = [];
  const universes = new Map();
  for (const spec of CELLS) {
    const key = `${spec.membershipFile}|${spec.quality}|${spec.universe}`;
    if (!universes.has(key)) {
      console.log(`[universe] ${spec.market} quality=${spec.quality} universe=${spec.universe}`);
      universes.set(key, loadUniverse(spec));
    }
    const universe = universes.get(key);
    const series = { benchmark: spec.benchmark === 'SPY' ? spy : ewu, qqq: spec.market === 'US' ? qqqSeries : null };
    const books = {};
    for (const [label, k] of [['research', 0], ['k1', 1], ['k2', 2]]) {
      const sim = simulate(universe, spec, series.benchmark, k);
      books[label] = scoreBook(label, sim, spec, series);
      console.log(`  ${spec.id} ${label}: months ${sim.months.length} full ${books[label].full.returnPct}% vs ${books[label].full.benchmarkReturnPct}% excess t ${books[label].excess.t} alpha t ${books[label].alpha?.t} ${books[label].verdict}`);
    }
    results.push({ ...spec, membershipFile: path.relative(ROOT, spec.membershipFile), coverage: universe.coverage, years: universe.years, books });
  }
  // Deflated Sharpe over every book scored here (the trial set of this re-score).
  const trials = results.filter(r => !r.reconciliationOnly).flatMap(r => Object.values(r.books).map(b => ({ sharpe: b.excess.sharpe, id: `${r.id}|${b.label}` })));
  for (const row of results) {
    for (const book of Object.values(row.books)) {
      const ds = deflatedSharpe(trials, book.excessReturns);
      book.deflatedExcessSharpe = { nTrials: ds.nTrials, probability: fix(ds.probability, 3), annualized: fix(ds.annualized) };
      delete book.monthlyReturns;
      delete book.excessReturns;
    }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    liveBehaviorChanged: false,
    standards: 'docs/strategy-gaps-amendment-2026-10-06.md (ever-member universe, PIT Piotroski filing+45d, monthly excess t, alpha t, k=1/k=2, QQQ hurdle)',
    passRule: {
      VALIDATION_PASS: 'every window with trades profitable with PF ≥ 1.2; full sample beats benchmark; monthly excess t ≥ 3; alpha t ≥ 2 (US: SPY+QQQ two-factor; UK: EWU); US must beat QQQ',
      INCUBATION_ELIGIBLE: 'positive full-sample net excess; ≥ 3 of 4 windows positive; excess t ≥ 1.5; max DD < 50%',
    },
    trials: trials.length,
    cells: results,
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${render(payload)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
}

const f = value => (value == null ? '—' : value);
const p = value => (value == null ? '—' : `${value}%`);
function render(payload) {
  const lines = [
    '# Momentum re-score under current standards — 2026-10-25',
    '',
    'Research only. No live signal, setup-book cell, flag, bracket, order, or deployment setting changed.',
    '',
    '## What is live',
    '',
    '- `UK_LONG_MOMENTUM`: plain 12-1 momentum, k=1 (one new name a month, six-month hold, six slots, $30,000 tickets), no Piotroski screen, Experimental. `FRANCE_LONG_MOMENTUM` is the same design and is paused.',
    '- The US long Piotroski ≥ 6 book is **not** enabled. `docs/us-long-piotroski-paper-design.md` is a paper design; no cell, flag, tag, or order exists for it.',
    '',
    `Standards: ${payload.standards}.`,
    '',
    `Pass rule — VALIDATION_PASS: ${payload.passRule.VALIDATION_PASS}. INCUBATION_ELIGIBLE: ${payload.passRule.INCUBATION_ELIGIBLE}. Deflated Sharpe is over the ${payload.trials} excess-return series scored here.`,
    '',
    'Mechanics: signal at the month-end close, enter the next open, re-mark at each later first-session open. Research book = top 10 equal weight (long: six overlapping sleeves). k=1 / k=2 = top k names not already held, $30,000 tickets, real lot sizing, empty slots earn 0. Costs through implementation-cost-v1 at entry (UK: 50 bps stamp on the buy).',
    '',
    '## Summary',
    '',
    '| Book | Variant | Verdict | Months | Full | Benchmark | Excess pp | Excess t | Alpha ann. | Alpha t | Beta | Max DD | Bench DD | Windows (+ / 4) | Trades | WR | PF | DSR p |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const cell of payload.cells) {
    for (const book of Object.values(cell.books)) {
      const a = book.alpha || {};
      const beta = a.beta != null ? a.beta : (a.betaSpy != null ? `${a.betaSpy}/${a.betaQqq}` : '—');
      lines.push(`| \`${cell.id}\` | ${book.label} | ${book.verdict} | ${book.months} | ${p(book.full.returnPct)} | ${p(book.full.benchmarkReturnPct)} | ${f(book.full.excessPp)} | ${f(book.excess.t)} | ${p(a.alphaAnnualPct)} | ${f(a.t)} | ${beta} | ${p(book.full.maxDrawdownPct)} | ${p(book.full.benchmarkMaxDrawdownPct)} | ${book.positiveWindows} | ${book.full.trades} | ${p(book.full.win)} | ${f(book.full.pf)} | ${f(book.deflatedExcessSharpe.probability)} |`);
    }
  }
  for (const cell of payload.cells) {
    lines.push('', `## ${cell.id}`, '');
    lines.push(`${cell.strategy}. Cell: ${cell.cell}. ${cell.liveNote}`, '');
    const c = cell.coverage;
    lines.push(`Universe (${cell.universe === 'current' ? 'current constituents only' : 'ever-members'}): ever-members ${c.everMembers}, current ${c.current}, former ${c.former} (${c.formerPriced} with a price file). Candidates ${c.candidates}, priced ${c.priced}${c.withStatements != null ? `, with dated statements ${c.withStatements} (former members with statements: ${c.formerWithStatements})` : ''}.`);
    if (c.withStatements != null && c.formerWithStatements === 0) {
      lines.push('', '**Coverage caveat:** statement files exist only for current constituents, so no former member can pass the Piotroski screen. The quality book is still survivorship-tilted even on the ever-member universe; the plain book is not.');
    }
    if (cell.prior.length) lines.push('', `Prior rows superseded: ${cell.prior.join('; ')}.`);
    lines.push('', '| Year | Members | With prices | Missing |', '| --- | ---: | ---: | ---: |');
    for (const y of cell.years) lines.push(`| ${y.year} | ${y.members} | ${y.priced} | ${y.missing} |`);
    for (const book of Object.values(cell.books)) {
      lines.push('', `### ${book.label} — ${book.verdict}`, '');
      if (book.failReasons.length) lines.push(`Fails on: ${book.failReasons.join('; ')}.`, '');
      lines.push(`Sample ${book.firstMonth} → ${book.lastMonth}, ${book.months} months. Full ${p(book.full.returnPct)} vs benchmark ${p(book.full.benchmarkReturnPct)} (excess ${f(book.full.excessPp)} pp). Max DD ${p(book.full.maxDrawdownPct)} vs ${p(book.full.benchmarkMaxDrawdownPct)}. Monthly excess t ${f(book.excess.t)} (n ${book.excess.n}, mean ${p(book.excess.meanMonthlyPct)}/month). Alpha ${p(book.alpha?.alphaAnnualPct)} ann., t ${f(book.alpha?.t)} (${book.alpha?.model || '—'}). Trades ${book.full.trades}, WR ${p(book.full.win)}, PF ${f(book.full.pf)}, median names ${book.full.medianNames}, early exits ${book.full.earlyExits}. Deflated excess Sharpe p ${f(book.deflatedExcessSharpe.probability)}.`);
      if (book.qqq) {
        lines.push('', `QQQ hurdle: QQQ ${p(book.qqq.qqqReturnPct)} (book minus QQQ ${f(book.qqq.bookMinusQqqPp)} pp), QQQ max DD ${p(book.qqq.qqqMaxDrawdownPct)}, book Sharpe ${f(book.qqq.bookSharpe)} vs QQQ ${f(book.qqq.qqqSharpe)}, beats QQQ: ${book.qqq.beatsQqq}. Per window vs QQQ: ${book.qqq.windows.map(w => `${w.fold}: ${f(w.excessPp)} pp`).join(', ')}. SPY-only alpha ${p(book.qqq.spyOnlyAlpha?.alphaAnnualPct)} (t ${f(book.qqq.spyOnlyAlpha?.t)}, beta ${f(book.qqq.spyOnlyAlpha?.beta)}).`);
      }
      lines.push('', '| Window | From | To | Book | Benchmark | Excess pp | Trades | WR | PF | Max DD |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
      for (const w of book.windows) lines.push(`| ${w.fold} | ${w.from} | ${w.to} | ${p(w.returnPct)} | ${p(w.benchmarkReturnPct)} | ${f(w.excessPp)} | ${w.trades} | ${p(w.win)} | ${w.pfInfinite ? '∞' : f(w.pf)} | ${p(w.maxDrawdownPct)} |`);
      lines.push('', '| Year | Book | Benchmark |', '| --- | ---: | ---: |');
      for (const y of book.years) lines.push(`| ${y.year} | ${p(y.returnPct)} | ${p(y.benchmarkReturnPct)} |`);
    }
  }
  lines.push('', 'Machine-readable: `scripts/momentum-rescore-results.json`.');
  return lines.join('\n');
}

main();
