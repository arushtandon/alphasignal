'use strict';

/**
 * F13 — managed-futures trend (CTA-style), long and short, one portfolio.
 * Pre-registered in docs/fund-program-preregistration-2026-10-25.md.
 * Research only.
 *
 *   node scripts/run-f13-cta-trend.js
 */

const fs = require('fs');
const path = require('path');
const fp = require('../lib/research/fund-program');
const { INSTRUMENTS, MICRO_ROUND_TRIP_PCT } = require('../lib/research/fund-program-data');

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'scripts', 'f13-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'f13-readout-2026-10-25.md');

const VARIANTS = [
  { id: '1m', lookbacks: [21], weekly: true },
  { id: '3m+6m', lookbacks: [63, 126], weekly: false },
  { id: '12m', lookbacks: [252], weekly: false },
  { id: 'blend', lookbacks: [21, 63, 126, 252], weekly: false },
];
const TARGET_VOL = 0.10;
const INSTRUMENT_CAP = 4;
const PORTFOLIO_SCALAR = [0.25, 4];
const VOL_LOOKBACK = 63;

function dailyLogReturns(series) {
  const out = new Array(series.close.length).fill(null);
  for (let index = 1; index < series.close.length; index += 1) {
    const a = series.close[index - 1]; const b = series.close[index];
    out[index] = a > 0 && b > 0 ? Math.log(b / a) : null;
  }
  return out;
}
function volAt(logs, at, lookback) {
  if (at < lookback) return null;
  const slice = logs.slice(at - lookback + 1, at + 1).filter(v => v != null);
  if (slice.length < lookback * 0.8) return null;
  return fp.stdev(slice) * Math.sqrt(252);
}
function signalAt(series, at, lookbacks) {
  let sum = 0; let count = 0;
  for (const lb of lookbacks) {
    if (at < lb) return null;
    const from = series.close[at - lb]; const to = series.close[at];
    if (!(from > 0) || !(to > 0)) return null;
    sum += Math.sign(to / from - 1); count += 1;
  }
  return count ? sum / count : null;
}

/**
 * Daily simulation on the SPY calendar. Positions are set at the open after
 * each rebalance close and held to the next rebalance. Instrument P&L per
 * calendar day = weight × (close/close − 1) using the instrument's own bars
 * (a day the instrument does not trade contributes zero).
 */
function simulateVariant(variant, instruments, calendar) {
  const ends = fp.periodEnds(calendar.dates, { weekly: variant.weekly });
  const monthEnds = new Set(fp.periodEnds(calendar.dates).map(index => calendar.dates[index]));
  const dailyRaw = []; // unscaled portfolio daily returns (equal capital per live instrument)
  const dailyNet = [];
  const perInstrument = new Map(instruments.map(row => [row.symbol, { long: 0, short: 0, longDays: 0, shortDays: 0, cost: 0, assetClass: row.assetClass }]));
  const spells = [];
  let weights = new Map(); // symbol → signed weight (fraction of capital, before portfolio scalar)
  let scalar = 1;
  let openSpell = new Map();
  const monthly = [];
  let monthAcc = 1; let monthStart = null;
  const rebalanceSet = new Set(ends);
  const maxLookback = Math.max(...variant.lookbacks);
  for (let day = 1; day < calendar.dates.length; day += 1) {
    const date = calendar.dates[day];
    if (date < fp.SAMPLE_START) continue;
    if (!monthStart) monthStart = date;
    // 1) mark-to-market today with yesterday's weights
    let gross = 0; let live = 0;
    for (const row of instruments) {
      const w = weights.get(row.symbol) || 0;
      const at = fp.indexOf(row.series, date);
      if (at < 1 || row.series.dates[at] !== date) continue;
      const ret = row.series.close[at] / row.series.close[at - 1] - 1;
      if (!Number.isFinite(ret)) continue;
      live += 1;
      const pnl = w * ret;
      gross += pnl;
      const stats = perInstrument.get(row.symbol);
      if (w > 0) { stats.long += pnl * scalar; stats.longDays += 1; } else if (w < 0) { stats.short += pnl * scalar; stats.shortDays += 1; }
      // roll cost pro rata on held notional
      if (w !== 0) {
        const roll = Math.abs(w) * row.rollsPerYear * (MICRO_ROUND_TRIP_PCT[row.assetClass] / 100) / 252;
        gross -= roll; stats.cost += roll * scalar;
      }
      const spell = openSpell.get(row.symbol);
      if (spell) spell.ret = (1 + spell.ret) * (1 + Math.sign(w) * ret) - 1;
    }
    dailyRaw.push({ date, ret: gross });
    const net = gross * scalar;
    dailyNet.push({ date, ret: net });
    monthAcc *= 1 + net;
    if (monthEnds.has(date) || day === calendar.dates.length - 1) {
      monthly.push({ date, entryDate: monthStart, exitDate: date, ret: monthAcc - 1, turnover: 0, names: live });
      monthAcc = 1; monthStart = null;
    }
    // 2) rebalance at this close → new weights apply from tomorrow
    if (!rebalanceSet.has(day)) continue;
    const next = new Map();
    let liveCount = 0;
    const candidates = [];
    for (const row of instruments) {
      const at = fp.indexOf(row.series, date);
      if (at < Math.max(maxLookback, VOL_LOOKBACK) + 1) continue;
      const sig = signalAt(row.series, at, variant.lookbacks);
      const vol = volAt(row.logs, at, VOL_LOOKBACK);
      if (sig == null || !(vol > 0)) continue;
      liveCount += 1;
      candidates.push({ row, sig, vol });
    }
    for (const { row, sig, vol } of candidates) {
      const size = Math.min(INSTRUMENT_CAP, TARGET_VOL / vol);
      next.set(row.symbol, (sig * size) / liveCount);
    }
    // portfolio scalar from trailing realized vol of the unscaled portfolio
    const trailing = dailyRaw.slice(-VOL_LOOKBACK).map(r => r.ret);
    const realized = trailing.length >= VOL_LOOKBACK * 0.8 ? fp.stdev(trailing) * Math.sqrt(252) : null;
    const nextScalar = realized > 0 ? Math.min(PORTFOLIO_SCALAR[1], Math.max(PORTFOLIO_SCALAR[0], TARGET_VOL / realized)) : 1;
    // transaction costs on the change in scaled notional (charged today)
    let cost = 0;
    const symbols = new Set([...weights.keys(), ...next.keys()]);
    for (const symbol of symbols) {
      const row = instruments.find(r => r.symbol === symbol);
      const before = (weights.get(symbol) || 0) * scalar;
      const after = (next.get(symbol) || 0) * nextScalar;
      const change = Math.abs(after - before);
      if (change > 0) {
        const c = change * (MICRO_ROUND_TRIP_PCT[row.assetClass] / 100) / 2; // half round trip per side traded
        cost += c; perInstrument.get(symbol).cost += c;
      }
      // spells
      const prevSign = Math.sign(weights.get(symbol) || 0); const nextSign = Math.sign(next.get(symbol) || 0);
      if (prevSign !== nextSign) {
        const spell = openSpell.get(symbol);
        if (spell) { spells.push({ symbol, side: spell.side, entryDate: spell.entryDate, date, ret: spell.ret - spell.cost }); openSpell.delete(symbol); }
        if (nextSign !== 0) openSpell.set(symbol, { side: nextSign > 0 ? 'long' : 'short', entryDate: date, ret: 0, cost: MICRO_ROUND_TRIP_PCT[row.assetClass] / 100 });
      }
    }
    if (cost > 0) {
      dailyNet[dailyNet.length - 1].ret -= cost;
      if (monthly.length && monthly[monthly.length - 1].date === date) monthly[monthly.length - 1].ret -= cost; else monthAcc *= 1 - cost;
    }
    weights = next; scalar = nextScalar;
  }
  for (const [symbol, spell] of openSpell) spells.push({ symbol, side: spell.side, entryDate: spell.entryDate, date: calendar.dates[calendar.dates.length - 1], ret: spell.ret - spell.cost, open: true });
  return { monthly, daily: dailyNet, spells, perInstrument };
}

function sixtyForty(spy, agg, periods) {
  return periods.map(row => {
    const s = fp.returnBetween(spy, row.entryDate, row.exitDate)?.ret ?? 0;
    const a = fp.returnBetween(agg, row.entryDate, row.exitDate)?.ret ?? 0;
    return { date: row.date, ret: 0.6 * s + 0.4 * a };
  });
}
function describe(returns) {
  const t = fp.tStat(returns).t;
  const sr = fp.sharpe(returns).sharpe;
  return { netPct: fp.pct(fp.compound(returns)), sharpeAnnual: fp.fix(sr == null ? null : sr * Math.sqrt(12)), t: fp.fix(t), maxDdPct: fp.pct(fp.maxDrawdown(returns)) };
}

async function main() {
  const spy = await fp.loadOrFetchSeries('SPY');
  const agg = await fp.loadOrFetchSeries('AGG');
  const instruments = [];
  for (const row of INSTRUMENTS) {
    if (row.assetClass === 'benchmark' || row.symbol === 'ISF.L') continue;
    const series = await fp.loadOrFetchSeries(row.symbol);
    if (!series) { console.warn(`no series for ${row.symbol}`); continue; }
    instruments.push({ ...row, series, logs: dailyLogReturns(series) });
  }
  console.log(`${instruments.length} instruments`);
  const books = [];
  const detail = {};
  for (const variant of VARIANTS) {
    const sim = simulateVariant(variant, instruments, spy);
    const periods = sim.monthly;
    const trades = sim.spells.map(s => ({ date: s.date, ret: s.ret }));
    const book = fp.scoreBook({
      label: `F13 trend ${variant.id}`, sim: { periods, trades }, calendarDates: spy.dates, horizon: 'medium',
      benchmarkSeries: null, needsAlpha: false, spySeries: spy, market: 'MULTI-ASSET', cell: 'MULTI-ASSET × medium × long/short',
      extra: { variant: variant.id, rebalance: variant.weekly ? 'weekly' : 'monthly' },
    });
    const bench6040 = sixtyForty(spy, agg, periods);
    book.sixtyForty = describe(bench6040.map(r => r.ret));
    book.spyOnly = describe(fp.benchmarkPeriods(spy, periods).map(r => r.ret));
    book.vs6040T = fp.fix(fp.tStat(periods.map((p, i) => p.ret - bench6040[i].ret)).t);
    // Per asset class and per instrument
    const byClass = {};
    const perInstrument = [];
    for (const [symbol, stats] of sim.perInstrument) {
      const total = stats.long + stats.short - stats.cost;
      byClass[stats.assetClass] = (byClass[stats.assetClass] || 0) + total;
      perInstrument.push({ symbol, assetClass: stats.assetClass, longPnlPct: fp.pct(stats.long), shortPnlPct: fp.pct(stats.short), costPct: fp.pct(stats.cost), netPct: fp.pct(total), longDays: stats.longDays, shortDays: stats.shortDays });
    }
    book.byAssetClass = Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, fp.pct(v)]));
    book.perInstrument = perInstrument.sort((a, b) => b.netPct - a.netPct);
    book.realizedVolPct = fp.pct(fp.stdev(periods.map(p => p.ret)) * Math.sqrt(12));
    books.push(book);
    detail[variant.id] = { monthly: periods.map(p => ({ date: p.date, ret: fp.fix(p.ret, 6) })) };
    console.log(`${book.verdict.padEnd(20)} ${book.label.padEnd(20)} net ${book.netReturnPct}% Sharpe ${book.sharpeAnnual} t ${book.sharpeT} DD ${book.maxDrawdownPct}% corrSPY ${book.corrSpy} windows ${book.windows.map(w => w.returnPct).join('/')} 60/40 ${book.sixtyForty.netPct}%`);
  }
  const deflated = fp.deflate(books);
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), trials: books.length, instruments: instruments.map(r => ({ symbol: r.symbol, ibkr: r.ibkr, assetClass: r.assetClass, first: r.series.dates[0] })), books: books.map(fp.stripPrivate), deflated, detail }, null, 2));

  const lines = [];
  lines.push('# F13 readout — managed-futures trend, long and short (2026-10-25)');
  lines.push('');
  lines.push('Research only. Specification frozen in `docs/fund-program-preregistration-2026-10-25.md` (commit 43320cd). One portfolio of 27 instruments (10 equity index, 3 rates, 5 FX, 7 commodity, 2 crypto; `ISF.L` excluded as an ETF duplicate of `^FTSE`), 10% vol per instrument (cap 4× notional), equal capital per live instrument, portfolio scaled ex ante to 10% vol (scalar clipped 0.25–4), micro-futures round trip + roll costs. VALIDATION_PASS requires monthly t ≥ 3 vs zero, every window with trades profitable with PF ≥ 1.2 on instrument spells, positive full sample. INCUBATION_ELIGIBLE: positive net, ≥ 3 of 4 windows positive, t ≥ 1.5, max DD < 50%.');
  lines.push('');
  lines.push(`Trials: ${books.length}. VALIDATION_PASS: ${books.filter(b => b.verdict === 'VALIDATION_PASS').length}. INCUBATION_ELIGIBLE: ${books.filter(b => b.verdict === 'INCUBATION_ELIGIBLE').length}.`);
  lines.push('');
  lines.push('## Cells filled');
  lines.push('');
  const flagged = books.filter(b => b.verdict !== 'FAIL');
  if (!flagged.length) lines.push('No variant passes or is incubation-eligible; the `MULTI-ASSET × medium × long/short` cell stays empty.');
  for (const b of flagged) lines.push(`- ${b.verdict} ${b.label} → ${b.verdict === 'VALIDATION_PASS' ? 'fills' : 'candidate for'} \`${b.cell}\` (new cell outside the 14 equity cells)`);
  lines.push('');
  lines.push('## Portfolio summary');
  lines.push('');
  lines.push(fp.mdTable(['Variant', 'Rebalance', 'Months', 'Net %', 'Ann. %', 'Realized vol %', 'Sharpe', 't vs 0', 'Max DD %', 'Corr SPY', 'Worst-10% SPY months: book / SPY', 'Spells', 'PF', 'Windows', '60/40 net % / Sharpe', 't vs 60/40', 'Verdict'], books.map(b => [
    b.variant, b.rebalance, b.periods, b.netReturnPct, b.annualizedPct, b.realizedVolPct, b.sharpeAnnual, b.sharpeT, b.maxDrawdownPct, b.corrSpy,
    `${b.worstSpyMonths.bookMeanPct}% / ${b.worstSpyMonths.spyMeanPct}%`, b.trades, b.pf, b.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''),
    `${b.sixtyForty.netPct}% / ${b.sixtyForty.sharpeAnnual}`, b.vs6040T, b.verdict,
  ])));
  lines.push('');
  lines.push('## Deflated Sharpe (4 F13 trials)');
  lines.push('');
  lines.push(fp.mdTable(['Variant', 'Sharpe (ann.)', 'SR0 (ann.)', 'P(deflated)'], deflated.map(d => [d.label, fp.fix(d.annualized), fp.fix(d.sr0 == null ? null : d.sr0 * Math.sqrt(12)), fp.fix(d.probability, 3)])));
  lines.push('');
  for (const b of books) {
    lines.push(`## ${b.label} — ${b.verdict}${b.failReasons.length ? ` (${b.failReasons.join('; ')})` : ''}`);
    lines.push('');
    lines.push('**Windows** (SPY calendar, medium embargo)', '', fp.windowsTable(b.windows), '');
    lines.push('**Per year**', '', fp.mdTable(['Year', 'Months', 'Return %'], b.yearly.map(y => [y.year, y.periods, y.returnPct])), '');
    lines.push('**Per asset class (net contribution, % of capital over the sample)**', '', fp.mdTable(['Class', 'Contribution %'], Object.entries(b.byAssetClass).map(([k, v]) => [k, v])), '');
    lines.push('**Per instrument**', '', fp.mdTable(['Instrument', 'Class', 'Long P&L %', 'Short P&L %', 'Costs %', 'Net %', 'Days long', 'Days short'], b.perInstrument.map(r => [r.symbol, r.assetClass, r.longPnlPct, r.shortPnlPct, r.costPct, r.netPct, r.longDays, r.shortDays])), '');
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- Instruments enter when they have the full lookback plus 63 sessions of history: `RTY=F` from 2018, `BTC-USD` from 2015/2016, `ETH-USD` from 2018/2019 depending on the lookback.');
  lines.push('- Yahoo `=F` series are front-month continuous contracts; roll jumps are in the signal and the mark. Roll cost is charged explicitly per contract-year on held notional. Rates are traded on the ZN/ZB/ZF price series; IBKR micro Treasury contracts are yield-quoted (sign inversion is an execution item).');
  lines.push('- Spot `BTC-USD`/`ETH-USD` include weekend bars; the SPY calendar drives marks, so weekend crypto moves land on Monday.');
  lines.push('- Per-instrument P&L is in units of portfolio capital after the portfolio scalar; costs include half a round trip per side traded plus roll.');
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
