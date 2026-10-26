'use strict';

/**
 * F12 — turn-of-month (A), low volatility (B), value + quality (C).
 * Pre-registered in docs/fund-program-preregistration-2026-10-25.md.
 * Research only.
 *
 *   node scripts/run-f12-tom-lowvol-value.js [--only=A|B|C]
 */

const fs = require('fs');
const path = require('path');
const fp = require('../lib/research/fund-program');
const { INSTRUMENTS, MICRO_ROUND_TRIP_PCT } = require('../lib/research/fund-program-data');

const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'scripts', 'f12-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'f12-readout-2026-10-25.md');
const ONLY = (process.argv.find(arg => arg.startsWith('--only=')) || '').slice(7) || null;
const EQUITY_MARKETS = ['US', 'UK', 'France', 'Germany'];

// ── A. Turn-of-month ───────────────────────────────────────────────────────
const TOM_VARIANTS = [
  { id: '-1..+3', from: -1, to: 3 },
  { id: '-1..+1', from: -1, to: 1 },
  { id: '-2..+3', from: -2, to: 3 },
];
const TOM_MARKET = { 'ES=F': 'US', '^N225': 'Japan', '^HSI': 'Hong Kong', '^GDAXI': 'Germany', '^FCHI': 'France', '^FTSE': 'UK', 'ISF.L': 'UK' };

function dayIndex(monthEnd, day) {
  // day −1 = month end index; −2 = one before; +k = k sessions after.
  return day < 0 ? monthEnd + day + 1 : monthEnd + day;
}
async function runTom() {
  const instruments = INSTRUMENTS.filter(row => row.tom);
  const books = [];
  for (const instrument of instruments) {
    const series = await fp.loadOrFetchSeries(instrument.symbol);
    if (!series) continue;
    const rt = instrument.symbol === 'ISF.L' ? 0.001 : MICRO_ROUND_TRIP_PCT[instrument.assetClass] / 100;
    const ends = fp.periodEnds(series.dates);
    for (const variant of TOM_VARIANTS) {
      const periods = []; const monthly = [];
      for (const end of ends) {
        const entry = dayIndex(end, variant.from) + 1;
        const exit = dayIndex(end, variant.to);
        if (entry < 1 || exit >= series.dates.length || exit < entry) continue;
        if (series.dates[entry] < fp.SAMPLE_START) continue;
        const entryPx = series.open[entry]; const exitPx = series.close[exit];
        if (!(entryPx > 0) || !(exitPx > 0)) continue;
        const sessions = exit - entry + 1;
        const roll = instrument.rollsPerYear * rt * (sessions / 252);
        const gross = exitPx / entryPx - 1;
        const net = gross - rt - roll;
        // Rest-of-month comparison: sessions in the two calendar months spanned, excluding held sessions.
        const months = new Set([series.dates[end].slice(0, 7), series.dates[Math.min(end + 1, series.dates.length - 1)].slice(0, 7)]);
        const rest = [];
        for (let index = Math.max(1, end - 25); index < Math.min(series.dates.length, end + 26); index += 1) {
          if (index >= entry && index <= exit) continue;
          if (!months.has(series.dates[index].slice(0, 7))) continue;
          rest.push(series.close[index] / series.close[index - 1] - 1);
        }
        const restScaled = rest.length ? fp.mean(rest) * sessions : null;
        periods.push({ date: series.dates[exit], entryDate: series.dates[entry], exitDate: series.dates[exit], ret: net, gross, cost: rt + roll, turnover: 1, names: 1 });
        monthly.push({ date: series.dates[exit], tom: gross, rest: restScaled });
      }
      const sim = { periods, trades: periods.map(row => ({ date: row.date, ret: row.ret })) };
      const vsRest = monthly.filter(row => row.rest != null).map(row => row.tom - row.rest);
      const market = TOM_MARKET[instrument.symbol];
      const book = fp.scoreBook({
        label: `A TOM ${instrument.tomLabel} (${instrument.symbol}) ${variant.id}`,
        sim, calendarDates: series.dates, horizon: 'short', benchmarkSeries: null, needsAlpha: false,
        market, cell: `${market} × short × long`, tradeRule: true,
        extra: {
          instrument: instrument.symbol, ibkr: instrument.ibkr, variant: variant.id,
          vsRestOfMonth: { n: vsRest.length, meanPp: fp.pct(fp.mean(vsRest)), t: fp.fix(fp.tStat(vsRest).t) },
          buyAndHoldPct: fp.pct(series.close[series.dates.length - 1] / series.open[fp.firstOnOrAfter(series, periods[0]?.entryDate || fp.SAMPLE_START)] - 1),
          yearlyTrades: yearlyTrades(periods),
        },
      });
      books.push(book);
    }
  }
  return books;
}
function yearlyTrades(periods) {
  const by = new Map();
  for (const row of periods) {
    const year = row.date.slice(0, 4);
    if (!by.has(year)) by.set(year, []);
    by.get(year).push(row.ret);
  }
  return [...by.entries()].map(([year, rets]) => {
    const stats = fp.tradeStats(rets);
    return { year, trades: rets.length, returnPct: fp.pct(fp.compound(rets)), win: stats.win == null ? null : +(stats.win * 100).toFixed(1) };
  });
}

// ── B. Low volatility ──────────────────────────────────────────────────────
function lowVolChooser(universe, { requireMomentum, k }) {
  return signalDate => {
    const members = fp.membersOn(universe, signalDate);
    const rows = [];
    for (const symbol of members) {
      const book = universe.books.get(symbol);
      if (!book) continue;
      const at = fp.indexOf(book.series, signalDate);
      if (at < 252 || book.series.dates[at] < signalDate.slice(0, 7)) continue; // must have a bar in the signal month
      const vol = fp.realizedVol(book.series, at, 252);
      if (!(vol > 0)) continue;
      if (requireMomentum) {
        const mom = fp.momentum12_1(book.series, at);
        if (!(mom > 0)) continue;
      }
      rows.push({ symbol, vol, price: book.series.close[at] });
    }
    rows.sort((a, b) => a.vol - b.vol);
    const target = new Map();
    if (!rows.length) return target;
    if (k) {
      const chosen = rows.slice(0, k);
      const ticket = fp.ticketLocal(universe);
      for (const row of chosen) target.set(row.symbol, { weight: fp.slotNotional(universe, row.symbol, row.price) / (k * ticket), price: row.price });
    } else {
      const q = Math.max(1, Math.floor(rows.length / 5));
      for (const row of rows.slice(0, q)) target.set(row.symbol, { weight: 1 / q, price: row.price });
    }
    return target;
  };
}
function runLowVol(universes, benchmarks) {
  const books = [];
  for (const market of EQUITY_MARKETS) {
    const universe = universes[market];
    const bench = benchmarks[universe.spec.benchmark];
    const ends = fp.periodEnds(bench.dates);
    for (const requireMomentum of [true, false]) {
      for (const k of [null, 5, 10]) {
        const sim = fp.simulatePeriodic({ universe, calendar: bench, ends, chooser: lowVolChooser(universe, { requireMomentum, k }) });
        const label = `B LowVol ${market} ${requireMomentum ? '+mom>0' : 'no filter'} ${k ? `k=${k}` : 'quintile'}`;
        books.push(fp.scoreBook({
          label, sim, calendarDates: bench.dates, horizon: 'medium', benchmarkSeries: bench,
          hurdleSeries: universe.spec.hurdle ? benchmarks[universe.spec.hurdle] : null,
          market, cell: `${market} × medium × long`,
          extra: { family: 'B', variant: requireMomentum ? 'mom>0' : 'nofilter', k: k || 'quintile' },
        }));
      }
    }
  }
  return books;
}

// ── C. Value + quality ─────────────────────────────────────────────────────
function reportedToLocal(row, universe) {
  const reported = String(row.reportedCurrency || universe.spec.currency).toUpperCase();
  const local = universe.spec.currency;
  if (reported === local) return 1;
  // reported → USD → local
  return fp.usdPerUnit(reported) / fp.usdPerUnit(local);
}
function valueQualityChooser(universe, { k }) {
  return signalDate => {
    const members = fp.membersOn(universe, signalDate);
    const rows = [];
    for (const symbol of members) {
      const book = universe.books.get(symbol);
      if (!book || !book.statements) continue;
      const at = fp.indexOf(book.series, signalDate);
      if (at < 252 || book.series.dates[at] < signalDate.slice(0, 7)) continue;
      if (!(fp.piotroskiAt(book.statements, signalDate) >= 6)) continue;
      const f = fp.fundamentalsAt(book.statements, signalDate);
      if (!f) continue;
      const latestIncome = book.statements.incomeStatements.filter(r => r.availableOn <= signalDate).pop();
      const fx = reportedToLocal(latestIncome, universe);
      const price = book.series.close[at];
      const mcap = fp.localPrice(universe, symbol, price) * f.shares;
      if (!(mcap > 0)) continue;
      rows.push({ symbol, price, ey: (f.ttmNetIncome * fx) / mcap, bp: (f.equity * fx) / mcap });
    }
    fp.percentileRanks(rows, 'ey');
    fp.percentileRanks(rows, 'bp');
    const ranked = rows.filter(r => Number.isFinite(r.eyPct) && Number.isFinite(r.bpPct)).map(r => ({ ...r, score: (r.eyPct + r.bpPct) / 2 }));
    ranked.sort((a, b) => b.score - a.score);
    const target = new Map();
    if (!ranked.length) return target;
    if (k) {
      const ticket = fp.ticketLocal(universe);
      for (const row of ranked.slice(0, k)) target.set(row.symbol, { weight: fp.slotNotional(universe, row.symbol, row.price) / (k * ticket), price: row.price });
    } else {
      const q = Math.max(1, Math.floor(ranked.length / 5));
      for (const row of ranked.slice(0, q)) target.set(row.symbol, { weight: 1 / q, price: row.price });
    }
    target.eligible = ranked.length;
    return target;
  };
}
function runValueQuality(universes, benchmarks) {
  const books = [];
  for (const market of EQUITY_MARKETS) {
    const universe = universes[market];
    const bench = benchmarks[universe.spec.benchmark];
    const ends = fp.periodEnds(bench.dates, { quarterly: true });
    for (const k of [null, 10]) {
      const eligibleCounts = [];
      const chooser = valueQualityChooser(universe, { k });
      const wrapped = (date, index) => { const t = chooser(date, index); eligibleCounts.push(t.eligible || 0); return t; };
      const sim = fp.simulatePeriodic({ universe, calendar: bench, ends, chooser: wrapped });
      books.push(fp.scoreBook({
        label: `C Value+Quality ${market} P≥6 ${k ? `k=${k}` : 'quintile'}`,
        sim, calendarDates: bench.dates, horizon: 'long', benchmarkSeries: bench,
        hurdleSeries: universe.spec.hurdle ? benchmarks[universe.spec.hurdle] : null,
        market, cell: `${market} × long × long`,
        extra: { family: 'C', k: k || 'quintile', avgEligible: fp.fix(fp.mean(eligibleCounts), 1), minEligible: Math.min(...eligibleCounts) },
      }));
    }
  }
  return books;
}

// ── Readout ────────────────────────────────────────────────────────────────
function render(books, universes, deflated) {
  const lines = [];
  lines.push('# F12 readout — turn-of-month, low volatility, value + quality (2026-10-25)');
  lines.push('');
  lines.push('Research only. Specification frozen in `docs/fund-program-preregistration-2026-10-25.md` (commit 43320cd) before this run. Pass rules: VALIDATION_PASS = every window with trades profitable with PF ≥ 1.2, full sample beats the benchmark, monthly excess t ≥ 3 and alpha t ≥ 2 (US: SPY+QQQ and beats QQQ); F12-A uses per-trade t ≥ 3 vs zero and PF ≥ 1.2. INCUBATION_ELIGIBLE = positive net excess, ≥ 3 of 4 windows positive, t ≥ 1.5, max DD < 50%.');
  lines.push('');
  const passing = books.filter(b => b.verdict === 'VALIDATION_PASS');
  const incubation = books.filter(b => b.verdict === 'INCUBATION_ELIGIBLE');
  lines.push(`Trials: ${books.length} (A ${books.filter(b => b.label.startsWith('A')).length}, B ${books.filter(b => b.label.startsWith('B')).length}, C ${books.filter(b => b.label.startsWith('C')).length}). VALIDATION_PASS: ${passing.length}. INCUBATION_ELIGIBLE: ${incubation.length}.`);
  lines.push('');
  lines.push('## Cells filled');
  lines.push('');
  if (!passing.length && !incubation.length) lines.push('No row passes or is incubation-eligible; no empty cell is filled by F12.');
  for (const book of passing) lines.push(`- **${book.verdict}** ${book.label} → fills \`${book.cell}\``);
  for (const book of incubation) lines.push(`- ${book.verdict} ${book.label} → candidate for \`${book.cell}\` (incubation only, not validated)`);
  lines.push('');
  lines.push('## Deflated Sharpe (all F12 trials)');
  lines.push('');
  const top = deflated.filter(d => d.probability != null).sort((a, b) => b.probability - a.probability).slice(0, 10);
  lines.push(mdTableDeflated(top, books.length));
  lines.push('');
  lines.push('## Universe coverage (ever-member files)');
  lines.push('');
  lines.push(fp.mdTable(['Market', 'Ever', 'Current', 'Former', 'Former priced', 'Priced', 'With statements', 'Piotroski-eligible', 'With sector'],
    Object.values(universes).map(u => [u.market, u.coverage.everMembers, u.coverage.current, u.coverage.former, u.coverage.formerPriced, u.coverage.priced, u.coverage.withStatements, u.coverage.withPiotroski, u.coverage.withSector])));
  lines.push('');
  for (const u of Object.values(universes)) {
    lines.push(`<details><summary>${u.market} members priced by year</summary>`, '');
    lines.push(fp.mdTable(['Year', 'Members', 'Priced', 'Missing'], u.years.map(y => [y.year, y.members, y.priced, y.missing])));
    lines.push('', '</details>', '');
  }
  for (const family of ['A', 'B', 'C']) {
    const rows = books.filter(b => b.label.startsWith(`${family} `));
    if (!rows.length) continue;
    lines.push(`## ${family === 'A' ? 'A. Turn-of-month (index level)' : family === 'B' ? 'B. Low volatility (monthly)' : 'C. Value + quality (quarterly)'}`);
    lines.push('');
    if (family === 'A') {
      lines.push(fp.mdTable(['Book', 'IBKR', 'Trades', 'Mean/trade %', 'Per-trade t', 'PF', 'Win %', 'Net %', 'B&H %', 'vs rest-of-month pp', 'vs rest t', 'Max DD %', 'Windows', 'Verdict'], rows.map(b => [
        b.label, b.ibkr, b.trades, b.perTradeMeanPct, b.perTradeT, b.pf, b.win, b.netReturnPct, b.buyAndHoldPct, b.vsRestOfMonth.meanPp, b.vsRestOfMonth.t, b.maxDrawdownPct,
        b.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''), b.verdict,
      ])));
    } else {
      lines.push(fp.mdTable(fp.SUMMARY_HEADERS, rows.map(fp.bookSummaryRow)));
    }
    lines.push('');
    for (const b of rows) {
      lines.push(`<details><summary>${b.label} — ${b.verdict}${b.failReasons.length ? ` (${b.failReasons.join('; ')})` : ''}</summary>`, '');
      if (b.alpha) lines.push(`Alpha: ${b.alpha.model}, ${b.alpha.alphaAnnualPct}%/yr, t ${b.alpha.t}${b.alpha.betaSpy != null ? `, β SPY ${b.alpha.betaSpy}, β QQQ ${b.alpha.betaQqq}` : b.alpha.beta != null ? `, β ${b.alpha.beta}` : ''}.`);
      if (b.hurdle) lines.push(`QQQ hurdle: QQQ ${b.hurdle.qqqReturnPct}% over the sample, beats QQQ: ${b.hurdle.beatsQqq ? 'yes' : 'no'}, excess-vs-QQQ t ${b.hurdle.excessVsQqqT}.`);
      if (b.avgEligible != null) lines.push(`Eligible names per quarter: mean ${b.avgEligible}, min ${b.minEligible}.`);
      if (b.avgNames != null && family !== 'A') lines.push(`Average names held ${b.avgNames}; average turnover ${b.avgTurnover}; annualized ${b.annualizedPct}%.`);
      lines.push('', '**Windows**', '', fp.windowsTable(b.windows), '');
      if (family === 'A') {
        lines.push('**Per year**', '', fp.mdTable(['Year', 'Trades', 'Return %', 'Win %'], b.yearlyTrades.map(y => [y.year, y.trades, y.returnPct, y.win])), '');
      } else {
        lines.push('**Per year**', '', fp.yearlyMd(b.yearly), '');
      }
      lines.push('</details>', '');
    }
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- Index series for Nikkei, Hang Seng, DAX, CAC and FTSE are cash indices; the S&P 500 uses the `ES=F` front-month series. Micro-futures costs are applied to all; `ISF.L` uses a 0.10% ETF round trip.');
  lines.push('- Equity universes: a name without a price file is dropped (see coverage); delisted names exit at their last available close.');
  lines.push('- UK Piotroski eligibility covers only quarterly filers (half-year filers are `INELIGIBLE_STATEMENT_CADENCE`), so the UK value + quality book is a small survivor-leaning sample and carries a coverage caveat regardless of verdict.');
  lines.push('- Fundamentals reported in a currency other than the market currency are converted at the latest cached FX rate (approximation; affects ranks only).');
  return lines.join('\n');
}
function mdTableDeflated(rows, nTrials) {
  return fp.mdTable(['Book', `Trials`, 'Sharpe (excess, ann.)', 'SR0', 'P(deflated)'], rows.map(d => [d.label, nTrials, fp.fix(d.annualized), fp.fix(d.sr0 == null ? null : d.sr0 * Math.sqrt(12)), fp.fix(d.probability, 3)]));
}

async function main() {
  const benchmarks = {};
  for (const symbol of ['SPY', 'QQQ', 'EWU', 'EWQ', 'EWG']) benchmarks[symbol] = await fp.loadOrFetchSeries(symbol);
  const universes = {};
  if (!ONLY || ONLY !== 'A') {
    for (const market of EQUITY_MARKETS) {
      universes[market] = fp.loadMarketUniverse(market, { fundamentals: !ONLY || ONLY === 'C' });
      console.log(`${market}: ${JSON.stringify(universes[market].coverage)}`);
    }
  }
  const books = [];
  if (!ONLY || ONLY === 'A') { console.log('A. turn-of-month'); books.push(...await runTom()); }
  if (!ONLY || ONLY === 'B') { console.log('B. low volatility'); books.push(...runLowVol(universes, benchmarks)); }
  if (!ONLY || ONLY === 'C') { console.log('C. value + quality'); books.push(...runValueQuality(universes, benchmarks)); }
  const deflated = fp.deflate(books);
  for (const book of books) console.log(`${book.verdict.padEnd(20)} ${book.label.padEnd(48)} net ${book.netReturnPct}% bench ${book.benchmarkReturnPct}% t ${book.excessT} alpha t ${book.alpha?.t ?? '—'} DD ${book.maxDrawdownPct}% windows ${book.windows.map(w => w.returnPct).join('/')}`);
  const report = {
    generatedAt: new Date().toISOString(), preregistration: 'docs/fund-program-preregistration-2026-10-25.md', trials: books.length,
    coverage: Object.fromEntries(Object.values(universes).map(u => [u.market, { ...u.coverage, years: u.years }])),
    books: books.map(fp.stripPrivate), deflated,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_MD, render(books, universes, deflated));
  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
