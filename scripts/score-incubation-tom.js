'use strict';

/**
 * Score the pre-registered F12-A variants on the ETFs the incubation books
 * would actually trade. Research only. Prints eligibility; does not enable.
 *
 *   node scripts/score-incubation-tom.js
 */

const fp = require('../lib/research/fund-program');

const VARIANTS = [
  { id: '-1..+3', from: -1, to: 3 },
  { id: '-1..+1', from: -1, to: 1 },
  { id: '-2..+3', from: -2, to: 3 },
];
const NAMES = { 'ISF.L': 'UK', '2800.HK': 'Hong Kong' };

function dayIndex(monthEnd, day) {
  return day < 0 ? monthEnd + day + 1 : monthEnd + day;
}

async function score(symbol) {
  const series = await fp.loadOrFetchSeries(symbol);
  if (!series) throw new Error(`no series for ${symbol}`);
  const ends = fp.periodEnds(series.dates);
  const rows = [];
  for (const variant of VARIANTS) {
    const periods = [];
    for (const end of ends) {
      const entry = dayIndex(end, variant.from) + 1;
      const exit = dayIndex(end, variant.to);
      if (entry < 1 || exit >= series.dates.length || exit < entry) continue;
      if (series.dates[entry] < fp.SAMPLE_START) continue;
      const entryPx = series.open[entry];
      const exitPx = series.close[exit];
      if (!(entryPx > 0) || !(exitPx > 0)) continue;
      periods.push({
        date: series.dates[exit],
        entryDate: series.dates[entry],
        exitDate: series.dates[exit],
        ret: exitPx / entryPx - 1 - 0.001,
        gross: exitPx / entryPx - 1,
        cost: 0.001,
        turnover: 1,
        names: 1,
      });
    }
    const sim = { periods, trades: periods.map(row => ({ date: row.date, ret: row.ret })) };
    const book = fp.scoreBook({
      label: `${symbol} ${variant.id}`,
      sim,
      calendarDates: series.dates,
      horizon: 'short',
      benchmarkSeries: null,
      needsAlpha: false,
      market: NAMES[symbol],
      cell: 'x',
      tradeRule: true,
      extra: {},
    });
    const fail = [];
    if (!(book.netReturnPct > 0)) fail.push('net excess not positive');
    if (!(book.positiveWindows >= 3)) fail.push(`windows ${book.positiveWindows}/4`);
    if (!(book.excessT >= 1.5)) fail.push(`t ${book.excessT} < 1.5`);
    if (!(book.maxDrawdownPct < 50)) fail.push(`max DD ${book.maxDrawdownPct}%`);
    rows.push({
      symbol,
      variant: variant.id,
      trades: book.trades,
      sample: `${book.firstPeriod} .. ${book.lastPeriod}`,
      netPct: book.netReturnPct,
      excessT: book.excessT,
      positiveWindows: book.positiveWindows,
      maxDrawdownPct: book.maxDrawdownPct,
      pf: book.pf,
      eligible: fail.length === 0,
      fail,
    });
  }
  return rows;
}

async function main() {
  const rows = [];
  for (const symbol of Object.keys(NAMES)) rows.push(...await score(symbol));
  console.log(JSON.stringify(rows, null, 2));
  const chosen = rows.filter(row => row.eligible);
  console.log(chosen.length
    ? `ELIGIBLE ${chosen.map(row => `${row.symbol} ${row.variant}`).join(', ')}`
    : 'ELIGIBLE none — leave both books disabled');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
