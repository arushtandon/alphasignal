'use strict';

/**
 * Shared machinery for the fund-style program (F12 / F13 / F14):
 * ever-member equity universes, point-in-time fundamentals, a periodic
 * weighted-portfolio simulator, benchmark alignment, four-window scoring,
 * the fixed pass rules and markdown helpers. Research only.
 *
 * Specification: docs/fund-program-preregistration-2026-10-25.md
 */

const fs = require('fs');
const path = require('path');
const { membershipAt } = require('./us-universe');
const { buildPitPiotroskiScores } = require('./pit-piotroski');
const { estimateRoundTripCostPct } = require('./cost-model');
const { buildDateAlignedFolds } = require('./walk-forward-optimizer');
const { EMBARGO, FOLD_SPEC } = require('./consistency-study');
const {
  compound, maxDrawdown, tStat, tradeStats, sharpe, deflatedSharpe, twoFactor,
} = require('./strategy-gaps');
const { pack, ensureSeries } = require('./fund-program-data');

const ROOT = path.join(__dirname, '..', '..');
const PRICE_DIRS = [
  path.join(ROOT, 'data', 'research', 'strategy-amendment-prices'),
  path.join(ROOT, 'data', 'research', 'exit-amendment-prices'),
  path.join(ROOT, 'data', 'research', 'fund-program-prices'),
];
const FMP_DIR = path.join(ROOT, 'data', 'research', 'fmp');
const PROFILE_DIR = path.join(ROOT, 'data', 'research', 'fmp-profiles');
const FX_DIR = path.join(ROOT, 'data', 'research', 'fx');
const TICKET_USD = 30_000;
const SAMPLE_START = '2010-01-01';

const MARKETS = Object.freeze({
  US: { membershipFile: path.join(FMP_DIR, 'us-universe.json'), statementMarket: 'US', benchmark: 'SPY', hurdle: 'QQQ', indexFuture: 'ES=F', currency: 'USD', signalStart: '2014-01-23', priceScale: 1, lowPrice: 5 },
  UK: { membershipFile: path.join(ROOT, 'data', 'research', 'index-membership', 'ftse100.json'), statementMarket: 'UK', benchmark: 'EWU', hurdle: null, indexFuture: '^FTSE', currency: 'GBP', signalStart: SAMPLE_START, priceScale: 0.01, lowPrice: 500 },
  France: { membershipFile: path.join(ROOT, 'data', 'research', 'index-membership', 'cac40.json'), statementMarket: 'France', benchmark: 'EWQ', hurdle: null, indexFuture: '^FCHI', currency: 'EUR', signalStart: SAMPLE_START, priceScale: 1, lowPrice: 5 },
  Germany: { membershipFile: path.join(ROOT, 'data', 'research', 'index-membership', 'dax.json'), statementMarket: 'Germany', benchmark: 'EWG', hurdle: null, indexFuture: '^GDAXI', currency: 'EUR', signalStart: SAMPLE_START, priceScale: 1, lowPrice: 5 },
});

// ── Small helpers ──────────────────────────────────────────────────────────
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pct = value => (Number.isFinite(value) ? +(value * 100).toFixed(2) : null);
const fix = (value, digits = 2) => (Number.isFinite(value) ? +value.toFixed(digits) : null);
const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const stdev = values => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
};

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
function nextDay(date) {
  return new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
}
/** Indices of the last session of each calendar month (or quarter) in a calendar. */
function periodEnds(dates, { quarterly = false, weekly = false } = {}) {
  const ends = [];
  for (let index = 0; index < dates.length - 1; index += 1) {
    const cur = dates[index]; const next = dates[index + 1];
    if (weekly) {
      // ISO week boundary: next session is on or after the following Monday.
      const d = new Date(cur); const n = new Date(next);
      const curWeek = Math.floor((d.getTime() / 86400000 + 3) / 7);
      const nextWeek = Math.floor((n.getTime() / 86400000 + 3) / 7);
      if (nextWeek !== curWeek) ends.push(index);
      continue;
    }
    if (cur.slice(0, 7) !== next.slice(0, 7)) {
      if (!quarterly || Number(cur.slice(5, 7)) % 3 === 0) ends.push(index);
    }
  }
  return ends;
}

// ── Prices ─────────────────────────────────────────────────────────────────
function priceFile(symbol) {
  const name = `${String(symbol).replace(/^\^/, '_').replace(/[\\/]/g, '_')}.json`;
  for (const dir of PRICE_DIRS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
const seriesCache = new Map();
function loadSeries(symbol) {
  if (seriesCache.has(symbol)) return seriesCache.get(symbol);
  const file = priceFile(symbol);
  const series = file ? pack(readJson(file)) : null;
  seriesCache.set(symbol, series);
  return series;
}
async function loadOrFetchSeries(symbol) {
  const cached = loadSeries(symbol);
  if (cached && cached.dates.length) return cached;
  const fetched = await ensureSeries(symbol);
  seriesCache.set(symbol, fetched);
  return fetched;
}
/** USD per one unit of local currency, latest cached value. */
function usdPerUnit(currency) {
  if (currency === 'USD') return 1;
  const file = path.join(FX_DIR, `${currency}USD_X.json`);
  if (!fs.existsSync(file)) return 1;
  const series = pack(readJson(file));
  return series.close.length ? series.close[series.close.length - 1] : 1;
}

// ── Universes ──────────────────────────────────────────────────────────────
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
  const availableOn = new Date(Date.parse(filed) + 45 * 86400000).toISOString().slice(0, 10);
  return { ...row, availableOn };
}
function loadStatements(market, symbol) {
  const dir = path.join(FMP_DIR, market, symbol);
  const read = kind => {
    const file = path.join(dir, `${kind}.json`);
    if (!fs.existsSync(file)) return [];
    const record = readJson(file);
    if (record.status !== 'OK' || !Array.isArray(record.rows)) return [];
    return record.rows.map(shiftFiling).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
  };
  const statements = { incomeStatements: read('income'), balanceSheets: read('balance'), cashFlowStatements: read('cashflow'), market };
  if (!statements.incomeStatements.length) return null;
  const pio = buildPitPiotroskiScores(statements);
  statements.piotroski = pio.eligible
    ? (pio.scores || []).filter(row => row.availableOn && Number.isFinite(row.score)).sort((a, b) => (a.availableOn < b.availableOn ? -1 : 1))
    : null;
  statements.piotroskiReason = pio.eligible ? null : pio.reason;
  return statements;
}
function piotroskiAt(statements, date) {
  if (!statements?.piotroski) return null;
  let found = null;
  for (const row of statements.piotroski) {
    if (row.availableOn <= date) found = row.score; else break;
  }
  return found;
}
/** Trailing-year fundamentals available by `date`: net income (sum of the last 4 quarters or 2 half-years), shares, equity, total assets. */
function fundamentalsAt(statements, date) {
  if (!statements) return null;
  const income = statements.incomeStatements.filter(row => row.availableOn <= date);
  const balance = statements.balanceSheets.filter(row => row.availableOn <= date);
  if (!income.length || !balance.length) return null;
  const latestIncome = income[income.length - 1];
  const latestBalance = balance[balance.length - 1];
  // Stale guard: statements older than 15 months are not used.
  if (Date.parse(date) - Date.parse(latestIncome.date) > 456 * 86400000) return null;
  const period = String(latestIncome.period || '').toUpperCase();
  const isHalf = /H[12]|S[12]/.test(period);
  const isAnnual = /FY|ANNUAL/.test(period) && !/Q/.test(period);
  let ttm;
  if (isAnnual) ttm = Number(latestIncome.netIncome);
  else {
    const need = isHalf ? 2 : 4;
    const rows = income.slice(-need);
    if (rows.length < need) return null;
    ttm = rows.reduce((sum, row) => sum + Number(row.netIncome || 0), 0);
  }
  const shares = Number(latestIncome.weightedAverageShsOutDil || latestIncome.weightedAverageShsOut);
  const equity = Number(latestBalance.totalStockholdersEquity);
  const totalAssets = Number(latestBalance.totalAssets);
  if (!(shares > 0)) return null;
  return { ttmNetIncome: ttm, shares, equity, totalAssets, statementDate: latestIncome.date };
}
function loadSector(symbol) {
  const file = path.join(PROFILE_DIR, `${symbol}.json`);
  if (!fs.existsSync(file)) return null;
  try { return readJson(file).sector || null; } catch (e) { return null; }
}

/**
 * Ever-member universe for a market with price series, statements and sector.
 * Membership check happens per signal date via `membersOn(universe, date)`.
 */
function loadMarketUniverse(marketKey, { fundamentals = true } = {}) {
  const market = MARKETS[marketKey];
  const snapshot = readJson(market.membershipFile);
  const ever = everMembers(snapshot);
  const current = new Set(snapshot.currentSymbols || []);
  const books = new Map();
  let withStatements = 0; let withPiotroski = 0; let withSector = 0;
  for (const symbol of ever) {
    const series = loadSeries(symbol);
    if (!series || series.dates.length < 260) continue;
    const statements = fundamentals ? loadStatements(market.statementMarket, symbol) : null;
    if (statements) withStatements += 1;
    if (statements?.piotroski) withPiotroski += 1;
    const sector = loadSector(symbol);
    if (sector) withSector += 1;
    books.set(symbol, { symbol, series, statements, sector, current: current.has(symbol) });
  }
  const years = [];
  const changeYears = (snapshot.historicalMembership?.changes || []).map(row => String(row.date || '').slice(0, 4)).filter(Boolean).sort();
  const firstYear = Math.max(2010, Number(changeYears[0]) || 2010);
  for (let year = firstYear; year <= new Date().getUTCFullYear(); year += 1) {
    const members = membershipAt(snapshot, `${year}-12-31`);
    let priced = 0;
    for (const symbol of members) if (books.has(symbol)) priced += 1;
    years.push({ year, members: members.size, priced, missing: members.size - priced });
  }
  const former = [...ever].filter(symbol => !current.has(symbol));
  return {
    market: marketKey,
    spec: market,
    snapshot,
    books,
    years,
    coverage: {
      everMembers: ever.size,
      current: current.size,
      former: former.length,
      formerPriced: former.filter(symbol => books.has(symbol)).length,
      priced: books.size,
      withStatements: fundamentals ? withStatements : null,
      withPiotroski: fundamentals ? withPiotroski : null,
      withSector,
    },
  };
}
function membersOn(universe, date) {
  return membershipAt(universe.snapshot, date);
}
/** Local-currency price of one share (pence → pounds for .L). */
function localPrice(universe, symbol, price) {
  return price * (universe.spec.priceScale || 1);
}
/** Ticket notional in local currency for an executable slot. */
function ticketLocal(universe) {
  return TICKET_USD / usdPerUnit(universe.spec.currency);
}
/** Notional bought with one ticket (lot-sized), local currency. */
function slotNotional(universe, symbol, price) {
  const px = localPrice(universe, symbol, price);
  const ticket = ticketLocal(universe);
  if (!(px > 0)) return 0;
  const shares = px > ticket ? 1 : Math.max(1, Math.floor(ticket / px));
  return shares * px;
}

// ── Returns and volatility ─────────────────────────────────────────────────
function returnBetween(series, fromDate, toDate) {
  // Entry at the first open on/after fromDate; exit at the first open on/after toDate
  // (or the last close when the series ends before toDate — delisting).
  const entry = firstOnOrAfter(series, fromDate);
  if (entry < 0) return null;
  let exit = firstOnOrAfter(series, toDate);
  let exitPrice;
  let delisted = false;
  if (exit < 0) { exit = series.dates.length - 1; exitPrice = series.close[exit]; delisted = true; }
  else exitPrice = series.open[exit];
  if (exit <= entry) return null;
  const entryPrice = series.open[entry];
  if (!(entryPrice > 0) || !(exitPrice > 0)) return null;
  return { ret: exitPrice / entryPrice - 1, entryDate: series.dates[entry], exitDate: series.dates[exit], entryPrice, delisted, days: exit - entry };
}
function realizedVol(series, at, lookback = 252) {
  if (at < lookback) return null;
  const rets = [];
  for (let index = at - lookback + 1; index <= at; index += 1) {
    const a = series.close[index - 1]; const b = series.close[index];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < lookback * 0.8) return null;
  return stdev(rets) * Math.sqrt(252);
}
function momentum12_1(series, at) {
  if (at < 252) return null;
  const from = series.close[at - 252]; const to = series.close[at - 21];
  return from > 0 && to > 0 ? to / from - 1 : null;
}
function percentileRanks(entries, key, { higherIsBetter = true } = {}) {
  const valid = entries.filter(row => Number.isFinite(row[key]));
  valid.sort((a, b) => (higherIsBetter ? a[key] - b[key] : b[key] - a[key]));
  const n = valid.length;
  valid.forEach((row, index) => { row[`${key}Pct`] = n > 1 ? index / (n - 1) : 0.5; });
  return valid;
}

// ── Periodic weighted portfolio simulator ──────────────────────────────────
/**
 * Simulate a book that re-chooses target weights at each period end.
 *   chooser(signalDate, signalIndexOnCalendar) → Map(symbol → {weight, side:'long'|'short', price})
 * Weights are fractions of leg capital (sum to ≤ 1). Costs: market round trip
 * on weight bought (or sold short) at entry; borrow for short weight; a name
 * whose series ends is exited at its last close. Returns period rows and
 * trade spells.
 */
function simulatePeriodic({ universe, calendar, ends, chooser, side = 'long', borrow = false, costFn }) {
  const periods = []; const trades = [];
  let held = new Map(); // symbol → { weight, spellRet, entryDate, series }
  for (let e = 0; e < ends.length - 1; e += 1) {
    const signalDate = calendar.dates[ends[e]];
    if (signalDate < universe.spec.signalStart || signalDate < SAMPLE_START) continue;
    const entryDate = nextDay(signalDate);
    const exitDate = nextDay(calendar.dates[ends[e + 1]]);
    const target = chooser(signalDate, ends[e]) || new Map();
    let gross = 0; let cost = 0; let borrowCost = 0; let turnover = 0;
    const next = new Map();
    for (const [symbol, row] of target) {
      const book = universe.books.get(symbol);
      if (!book) continue;
      const leg = returnBetween(book.series, entryDate, exitDate);
      if (!leg) continue;
      const signed = side === 'short' ? -leg.ret : leg.ret;
      const prevWeight = held.get(symbol)?.weight || 0;
      const bought = Math.max(0, row.weight - prevWeight);
      const rt = (costFn || (() => estimateRoundTripCostPct({ market: universe.market, symbol, side: side === 'short' ? 'sell' : 'buy' }) / 100))(symbol, book);
      cost += bought * rt;
      turnover += bought;
      if (borrow && side === 'short') {
        const px = localPrice(universe, symbol, leg.entryPrice);
        const rate = px < universe.spec.lowPrice ? 0.03 : 0.01;
        borrowCost += row.weight * rate * (leg.days / 252);
      }
      gross += row.weight * signed;
      const prev = held.get(symbol);
      next.set(symbol, {
        weight: row.weight,
        spellRet: prev ? (1 + prev.spellRet) * (1 + signed - (bought > 0 ? rt * bought / row.weight : 0)) - 1 : signed - rt,
        entryDate: prev ? prev.entryDate : leg.entryDate,
        lastExit: leg.exitDate,
        delisted: leg.delisted,
      });
    }
    // Spells that ended: anything held before and not in the new target.
    for (const [symbol, prev] of held) {
      if (!next.has(symbol)) trades.push({ symbol, date: prev.lastExit, entryDate: prev.entryDate, ret: prev.spellRet });
    }
    // Delisted names are closed at their last close.
    for (const [symbol, row] of [...next]) {
      if (row.delisted) { trades.push({ symbol, date: row.lastExit, entryDate: row.entryDate, ret: row.spellRet }); next.delete(symbol); }
    }
    held = next;
    const net = gross - cost - borrowCost;
    periods.push({ date: calendar.dates[ends[e + 1]], signalDate, entryDate, exitDate, ret: net, gross, cost, borrowCost, turnover, names: target.size });
  }
  for (const [symbol, prev] of held) trades.push({ symbol, date: prev.lastExit, entryDate: prev.entryDate, ret: prev.spellRet, open: true });
  return { periods, trades };
}
/** Benchmark return over the same entry→exit opens as each period. */
function benchmarkPeriods(series, periods) {
  return periods.map(row => {
    const leg = returnBetween(series, row.entryDate, row.exitDate);
    return { date: row.date, ret: leg ? leg.ret : 0 };
  });
}

// ── Scoring ────────────────────────────────────────────────────────────────
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
function yearlyTable(periods, bench) {
  const by = new Map();
  periods.forEach((row, index) => {
    const year = row.date.slice(0, 4);
    if (!by.has(year)) by.set(year, { book: [], bench: [] });
    by.get(year).book.push(row.ret);
    if (bench) by.get(year).bench.push(bench[index].ret);
  });
  return [...by.entries()].map(([year, v]) => ({
    year, periods: v.book.length, returnPct: pct(compound(v.book)), benchmarkReturnPct: bench ? pct(compound(v.bench)) : null,
  }));
}
function windowsFor({ periods, bench, trades, calendarDates, horizon }) {
  const folds = foldsFor(calendarDates, horizon);
  return folds.map(fold => {
    const inside = row => row.date >= fold.test.from && row.date <= fold.test.to;
    const slice = periods.filter(inside);
    const bslice = bench ? bench.filter(inside) : null;
    const stats = tradeStats(trades.filter(inside).map(row => row.ret));
    const ret = compound(slice.map(r => r.ret));
    return {
      fold: fold.fold, from: fold.test.from, to: fold.test.to,
      periods: slice.length,
      returnPct: pct(ret),
      benchmarkReturnPct: bslice ? pct(compound(bslice.map(r => r.ret))) : null,
      excessPp: bslice ? pct(ret - compound(bslice.map(r => r.ret))) : pct(ret),
      trades: stats.n,
      win: stats.win == null ? null : +(stats.win * 100).toFixed(1),
      pf: stats.pf === Infinity ? null : fix(stats.pf, 3),
      pfInfinite: stats.pf === Infinity,
      maxDrawdownPct: pct(maxDrawdown(slice.map(r => r.ret))),
      profitable: slice.length > 0 && ret > 0,
    };
  });
}
/**
 * Fixed pass rules (pre-registration §Pass rules).
 *  statT: the family's required monthly t (excess, spread, or vs zero).
 *  alphaT: required when `needsAlpha`. beatsHurdle: QQQ hurdle for US books.
 */
function verdictFor({ windows, netReturn, benchReturn, statT, alphaT, needsAlpha, beatsHurdle, hurdleApplies, maxDd, perTradeT, pfAll, tradeRule }) {
  const withTrades = windows.filter(w => w.trades > 0);
  const windowsOk = withTrades.every(w => w.profitable && (w.pfInfinite || (w.pf != null && w.pf >= 1.2)));
  const beats = benchReturn == null ? netReturn > 0 : netReturn > benchReturn;
  const reasons = [];
  if (!windowsOk) reasons.push('a window with trades is unprofitable or PF < 1.2');
  if (!beats) reasons.push(benchReturn == null ? 'full-sample net ≤ 0' : 'full-sample net ≤ benchmark');
  if (tradeRule) {
    if (!(perTradeT >= 3)) reasons.push(`per-trade t ${fix(perTradeT)} < 3`);
    if (!(pfAll >= 1.2)) reasons.push(`PF ${fix(pfAll, 3)} < 1.2`);
  } else if (!(statT >= 3)) reasons.push(`monthly t ${fix(statT)} < 3`);
  if (needsAlpha && !(alphaT >= 2)) reasons.push(`alpha t ${fix(alphaT)} < 2`);
  if (hurdleApplies && !beatsHurdle) reasons.push('does not beat QQQ');
  const pass = reasons.length === 0;
  const positiveWindows = windows.filter(w => w.periods > 0 && w.returnPct > 0).length;
  const excessPositive = benchReturn == null ? netReturn > 0 : netReturn - benchReturn > 0;
  const incubationT = tradeRule ? perTradeT : statT;
  const incubation = !pass && excessPositive && positiveWindows >= 3 && incubationT >= 1.5 && maxDd < 0.5;
  return {
    verdict: pass ? 'VALIDATION_PASS' : incubation ? 'INCUBATION_ELIGIBLE' : 'FAIL',
    failReasons: reasons,
    positiveWindows,
  };
}
/**
 * Score a periodic book against a benchmark series (null = vs zero).
 */
function scoreBook({ label, sim, calendarDates, horizon, benchmarkSeries, hurdleSeries, spySeries, needsAlpha = true, market, cell, tradeRule = false, extra = null, verdictVsZero = false }) {
  // verdictVsZero: the benchmark is used only for alpha/beta diagnostics; the
  // verdict (and the reported excess series) is vs zero, as pre-registered for
  // hedged-short and combined L/S books.
  const { periods, trades } = sim;
  const bench = benchmarkSeries ? benchmarkPeriods(benchmarkSeries, periods) : null;
  const y = periods.map(row => row.ret);
  const x = bench && !verdictVsZero ? bench.map(row => row.ret) : y.map(() => 0);
  const excess = y.map((v, i) => v - x[i]);
  const windows = windowsFor({ periods, bench: verdictVsZero ? null : bench, trades, calendarDates, horizon });
  const net = compound(y);
  const benchRet = bench && !verdictVsZero ? compound(x) : null;
  const statT = tStat(excess).t;
  let diagnostics = null;
  if (bench && verdictVsZero) {
    const bx = bench.map(row => row.ret);
    const reg = hurdleSeries ? twoFactor(y, bx, benchmarkPeriods(hurdleSeries, periods).map(row => row.ret)) : oneFactor(y, bx);
    diagnostics = reg ? {
      model: hurdleSeries ? 'SPY+QQQ' : 'one-factor index',
      alphaAnnualPct: pct((hurdleSeries ? reg.alpha * 12 : reg.alphaAnnual)),
      alphaT: fix(reg.t),
      beta: fix(hurdleSeries ? reg.betaSpy : reg.beta, 3),
      betaQqq: hurdleSeries ? fix(reg.betaQqq, 3) : null,
      indexReturnPct: pct(compound(bx)),
    } : null;
  }
  let alpha = null; let hurdle = null;
  if (verdictVsZero) {
    // diagnostics only; no benchmark-relative verdict
  } else if (benchmarkSeries && hurdleSeries) {
    const q = benchmarkPeriods(hurdleSeries, periods).map(row => row.ret);
    const tf = twoFactor(y, x, q);
    alpha = tf ? { model: 'SPY+QQQ', alphaAnnualPct: pct(tf.alpha * 12), t: fix(tf.t), betaSpy: fix(tf.betaSpy, 3), betaQqq: fix(tf.betaQqq, 3) } : null;
    const qRet = compound(q);
    hurdle = { qqqReturnPct: pct(qRet), beatsQqq: net > qRet, excessVsQqqT: fix(tStat(y.map((v, i) => v - q[i])).t) };
  } else if (benchmarkSeries) {
    const of = oneFactor(y, x);
    alpha = of ? { model: `one-factor ${market ? MARKETS[market]?.benchmark : 'benchmark'}`, alphaAnnualPct: pct(of.alphaAnnual), t: fix(of.t), beta: fix(of.beta, 3) } : null;
  }
  const all = tradeStats(trades.map(row => row.ret));
  const maxDd = maxDrawdown(y);
  const sr = sharpe(y);
  const srExcess = sharpe(excess);
  const perTradeT = tStat(trades.map(row => row.ret)).t;
  const verdict = verdictFor({
    windows, netReturn: net, benchReturn: benchRet, statT, alphaT: alpha?.t, needsAlpha: needsAlpha && !!benchmarkSeries,
    beatsHurdle: hurdle?.beatsQqq, hurdleApplies: !!hurdle, maxDd,
    tradeRule, perTradeT, pfAll: all.pf,
  });
  let corrSpy = null; let worstSpy = null;
  if (spySeries) {
    const s = benchmarkPeriods(spySeries, periods).map(row => row.ret);
    const my = mean(y); const ms = mean(s);
    const cov = mean(y.map((v, i) => (v - my) * (s[i] - ms)));
    corrSpy = fix(cov / (stdev(y) * stdev(s)), 3);
    const sorted = s.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const worst = sorted.slice(0, Math.max(1, Math.floor(s.length * 0.1)));
    worstSpy = { months: worst.length, bookMeanPct: pct(mean(worst.map(w => y[w.i]))), spyMeanPct: pct(mean(worst.map(w => w.v))) };
  }
  return {
    label, market, cell, horizon,
    periods: periods.length, firstPeriod: periods[0]?.date || null, lastPeriod: periods[periods.length - 1]?.date || null,
    netReturnPct: pct(net), benchmarkReturnPct: pct(benchRet), excessPp: benchRet == null ? pct(net) : pct(net - benchRet),
    annualizedPct: annualized(periods, net),
    excessT: fix(statT), sharpeAnnual: fix(sr.sharpe == null ? null : sr.sharpe * Math.sqrt(periodsPerYear(periods))),
    sharpeT: fix(tStat(y).t),
    alpha, hurdle, indexDiagnostics: diagnostics,
    maxDrawdownPct: pct(maxDd),
    trades: all.n, win: all.win == null ? null : +(all.win * 100).toFixed(1), pf: all.pf === Infinity ? null : fix(all.pf, 3),
    perTradeT: fix(perTradeT), perTradeMeanPct: pct(mean(trades.map(row => row.ret))),
    ...(extra || {}),
    avgTurnover: fix(mean(periods.map(p => p.turnover)), 3),
    avgNames: fix(mean(periods.map(p => p.names)), 1),
    corrSpy, worstSpyMonths: worstSpy,
    windows,
    yearly: yearlyTable(periods, bench),
    ...verdict,
    _excess: excess, _returns: y, _excessSharpe: srExcess.sharpe,
  };
}
function annualized(periods, net) {
  if (periods.length < 2 || !(1 + net > 0)) return null;
  const years = (Date.parse(periods[periods.length - 1].date) - Date.parse(periods[0].entryDate || periods[0].date)) / 86400000 / 365.25;
  if (!(years > 0.5)) return null;
  return pct((1 + net) ** (1 / years) - 1);
}
function periodsPerYear(periods) {
  if (periods.length < 2) return 12;
  const days = (Date.parse(periods[periods.length - 1].date) - Date.parse(periods[0].date)) / 86400000;
  const perYear = (periods.length - 1) / Math.max(1 / 365, days / 365.25);
  if (perYear > 30) return 52;
  if (perYear > 8) return 12;
  if (perYear > 3) return 4;
  return 1;
}
function deflate(books) {
  const trials = books.map(book => ({ sharpe: book._excessSharpe }));
  return books.map(book => ({ label: book.label, ...deflatedSharpe(trials, book._excess) }));
}

// ── Markdown ───────────────────────────────────────────────────────────────
function mdTable(headers, rows) {
  const line = cells => `| ${cells.map(cell => (cell == null ? '—' : String(cell))).join(' | ')} |`;
  return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}
function windowsTable(windows) {
  return mdTable(['Window', 'From', 'To', 'Return %', 'Bench %', 'Trades', 'Win %', 'PF', 'Max DD %'], windows.map(w => [
    w.fold, w.from, w.to, w.returnPct, w.benchmarkReturnPct, w.trades, w.win, w.pfInfinite ? '∞' : w.pf, w.maxDrawdownPct,
  ]));
}
function yearlyMd(yearly) {
  return mdTable(['Year', 'Periods', 'Return %', 'Bench %'], yearly.map(r => [r.year, r.periods, r.returnPct, r.benchmarkReturnPct]));
}
function bookSummaryRow(book) {
  return [
    book.label, book.periods, book.netReturnPct, book.benchmarkReturnPct, book.excessT, book.alpha?.t ?? null,
    book.hurdle ? (book.hurdle.beatsQqq ? 'yes' : 'no') : '—', book.maxDrawdownPct, book.trades, book.pf,
    book.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''),
    book.verdict,
  ];
}
const SUMMARY_HEADERS = ['Book', 'Periods', 'Net %', 'Bench %', 'Excess t', 'Alpha t', 'Beats QQQ', 'Max DD %', 'Trades', 'PF', 'Windows', 'Verdict'];
function stripPrivate(book) {
  const out = { ...book };
  for (const key of Object.keys(out)) if (key.startsWith('_')) delete out[key];
  return out;
}

module.exports = {
  MARKETS, TICKET_USD, SAMPLE_START, SUMMARY_HEADERS,
  readJson, pct, fix, mean, stdev,
  indexOf, firstOnOrAfter, nextDay, periodEnds,
  priceFile, loadSeries, loadOrFetchSeries, usdPerUnit,
  everMembers, shiftFiling, loadStatements, piotroskiAt, fundamentalsAt, loadSector,
  loadMarketUniverse, membersOn, localPrice, ticketLocal, slotNotional,
  returnBetween, realizedVol, momentum12_1, percentileRanks,
  simulatePeriodic, benchmarkPeriods,
  oneFactor, foldsFor, yearlyTable, windowsFor, verdictFor, scoreBook, periodsPerYear, deflate,
  mdTable, windowsTable, yearlyMd, bookSummaryRow, stripPrivate,
  compound, maxDrawdown, tStat, tradeStats, sharpe, deflatedSharpe, twoFactor,
};
