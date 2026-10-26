'use strict';

/**
 * F14 — multi-factor long/short equity, sector-neutral, short leg beta-hedged.
 * Pre-registered in docs/fund-program-preregistration-2026-10-25.md.
 * Research only.
 *
 *   node scripts/run-f14-multifactor-ls.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const fp = require('../lib/research/fund-program');
const { MICRO_ROUND_TRIP_PCT } = require('../lib/research/fund-program-data');
const { loadResearchEnv } = require('./research-env');

const ROOT = path.join(__dirname, '..');
const PROFILE_DIR = path.join(ROOT, 'data', 'research', 'fmp-profiles');
const OUT_JSON = path.join(ROOT, 'scripts', 'f14-results.json');
const OUT_MD = path.join(ROOT, 'docs', 'f14-readout-2026-10-25.md');
const MARKETS = ['US', 'UK', 'France', 'Germany'];
const MIN_SECTOR = 5;

loadResearchEnv();
const FMP_KEY = String(process.env.FMP_API_KEY || '').trim();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
/** Fetch FMP profiles (sector/industry) for symbols lacking a cached file. */
async function ensureProfiles(symbols) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const missing = symbols.filter(symbol => !fs.existsSync(path.join(PROFILE_DIR, `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.json`)));
  if (!missing.length) return { missing: 0, fetched: 0 };
  if (!FMP_KEY) { console.warn(`FMP_API_KEY absent; ${missing.length} profiles stay missing`); return { missing: missing.length, fetched: 0 }; }
  let fetched = 0;
  for (const symbol of missing) {
    const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(FMP_KEY)}`;
    let body = null;
    try {
      const response = await httpGet(url);
      if (response.status === 200) body = JSON.parse(response.raw);
    } catch (_) { body = null; }
    const row = Array.isArray(body) ? body[0] : null;
    const record = { sector: row?.sector || null, industry: row?.industry || null };
    fs.writeFileSync(path.join(PROFILE_DIR, `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.json`), JSON.stringify(record));
    fetched += 1;
  }
  return { missing: missing.length, fetched };
}

// ── Factor construction ────────────────────────────────────────────────────
function reportedToLocal(row, universe) {
  const reported = String(row?.reportedCurrency || universe.spec.currency).toUpperCase();
  const local = universe.spec.currency;
  if (reported === local) return 1;
  return fp.usdPerUnit(reported) / fp.usdPerUnit(local);
}
/** Per-name factor inputs at the signal date (null when a required input is missing). */
function factorInputs(universe, symbol, signalDate) {
  const book = universe.books.get(symbol);
  if (!book || !book.sector) return null;
  const at = fp.indexOf(book.series, signalDate);
  if (at < 252 || book.series.dates[at] < signalDate.slice(0, 7)) return null;
  const price = book.series.close[at];
  const mom = fp.momentum12_1(book.series, at);
  const vol = fp.realizedVol(book.series, at, 252);
  const rev = book.series.close[at - 21] > 0 ? -(price / book.series.close[at - 21] - 1) : null;
  const pio = fp.piotroskiAt(book.statements, signalDate);
  const f = fp.fundamentalsAt(book.statements, signalDate);
  if (mom == null || !(vol > 0) || !f) return null;
  const latestIncome = book.statements.incomeStatements.filter(r => r.availableOn <= signalDate).pop();
  const fx = reportedToLocal(latestIncome, universe);
  const mcap = fp.localPrice(universe, symbol, price) * f.shares;
  if (!(mcap > 0)) return null;
  return {
    symbol, sector: book.sector, price,
    mom, lowVol: -vol, rev,
    pio: Number.isFinite(pio) ? pio : null,
    roa: f.totalAssets > 0 ? (f.ttmNetIncome / f.totalAssets) : null,
    ey: (f.ttmNetIncome * fx) / mcap, bp: (f.equity * fx) / mcap,
  };
}
/** Sector-relative composite percentiles. Returns rows with `composite`. */
function compositeRanks(rows, { reversal }) {
  const bySector = new Map();
  for (const row of rows) {
    if (!bySector.has(row.sector)) bySector.set(row.sector, []);
    bySector.get(row.sector).push(row);
  }
  const out = [];
  for (const [sector, group] of bySector) {
    if (group.length < MIN_SECTOR) continue;
    fp.percentileRanks(group, 'mom');
    fp.percentileRanks(group, 'lowVol');
    fp.percentileRanks(group, 'ey');
    fp.percentileRanks(group, 'bp');
    if (reversal) fp.percentileRanks(group, 'rev');
    // quality: Piotroski percentile when eligible, else ROA percentile within the same sector
    const withPio = group.filter(r => r.pio != null);
    const withRoa = group.filter(r => r.pio == null && r.roa != null);
    fp.percentileRanks(withPio, 'pio');
    fp.percentileRanks(withRoa, 'roa');
    for (const row of group) {
      const quality = row.pio != null ? row.pioPct : row.roaPct;
      if (![row.momPct, row.lowVolPct, row.eyPct, row.bpPct, quality].every(Number.isFinite)) continue;
      const value = (row.eyPct + row.bpPct) / 2;
      const parts = [row.momPct, quality, value, row.lowVolPct];
      if (reversal) { if (!Number.isFinite(row.revPct)) continue; parts.push(row.revPct); }
      out.push({ ...row, sector, composite: parts.reduce((a, b) => a + b, 0) / parts.length });
    }
  }
  return out;
}
/** Long/short target maps. Research: quintiles per sector; executable: top/bottom k with ≤ 2 per sector. */
function targets(ranked, { k, universe }) {
  const long = new Map(); const short = new Map();
  if (k) {
    const ticket = fp.ticketLocal(universe);
    const pick = (sorted, into) => {
      const perSector = new Map();
      for (const row of sorted) {
        const n = perSector.get(row.sector) || 0;
        if (n >= 2) continue;
        perSector.set(row.sector, n + 1);
        into.set(row.symbol, { weight: fp.slotNotional(universe, row.symbol, row.price) / (k * ticket), price: row.price, sector: row.sector });
        if (into.size >= k) break;
      }
    };
    pick([...ranked].sort((a, b) => b.composite - a.composite), long);
    pick([...ranked].sort((a, b) => a.composite - b.composite), short);
    return { long, short };
  }
  const bySector = new Map();
  for (const row of ranked) {
    if (!bySector.has(row.sector)) bySector.set(row.sector, []);
    bySector.get(row.sector).push(row);
  }
  const sectors = [...bySector.keys()];
  for (const sector of sectors) {
    const group = bySector.get(sector).sort((a, b) => b.composite - a.composite);
    const q = Math.max(1, Math.floor(group.length / 5));
    for (const row of group.slice(0, q)) long.set(row.symbol, { weight: 1 / (q * sectors.length), price: row.price, sector });
    for (const row of group.slice(-q)) short.set(row.symbol, { weight: 1 / (q * sectors.length), price: row.price, sector });
  }
  return { long, short };
}

// ── Hedge: short basket beta to the index over the trailing 252 sessions ───
function basketBeta(universe, indexSeries, shortTarget, signalDate) {
  const end = fp.indexOf(indexSeries, signalDate);
  if (end < 252) return 1;
  const idx = []; const basket = [];
  for (let i = end - 251; i <= end; i += 1) {
    const d0 = indexSeries.dates[i - 1]; const d1 = indexSeries.dates[i];
    const ir = indexSeries.close[i] / indexSeries.close[i - 1] - 1;
    let sum = 0; let wsum = 0;
    for (const [symbol, row] of shortTarget) {
      const s = universe.books.get(symbol).series;
      const a = fp.indexOf(s, d0); const b = fp.indexOf(s, d1);
      if (a < 0 || b <= a || s.dates[b] !== d1) continue;
      sum += row.weight * (s.close[b] / s.close[a] - 1); wsum += row.weight;
    }
    if (!(wsum > 0)) continue;
    idx.push(ir); basket.push(sum / wsum);
  }
  if (idx.length < 120) return 1;
  const reg = fp.oneFactor(basket, idx);
  return reg && Number.isFinite(reg.beta) ? Math.min(2, Math.max(0, reg.beta)) : 1;
}

function runMarket(market, universe, benchmarks, indexSeries) {
  const bench = benchmarks[universe.spec.benchmark];
  const books = [];
  const futureRt = MICRO_ROUND_TRIP_PCT.equity / 100;
  for (const rebalance of ['monthly', 'quarterly']) {
    const ends = fp.periodEnds(bench.dates, { quarterly: rebalance === 'quarterly' });
    const horizon = rebalance === 'monthly' ? 'medium' : 'long';
    for (const composite of ['A', 'B']) {
      const reversal = composite === 'B';
      for (const k of [null, 5, 10]) {
        // Build all targets once per signal date; both legs share them.
        const cache = new Map();
        const stats = { eligible: [], sectors: [] };
        const prepare = signalDate => {
          if (cache.has(signalDate)) return cache.get(signalDate);
          const members = fp.membersOn(universe, signalDate);
          const rows = [];
          for (const symbol of members) { const r = factorInputs(universe, symbol, signalDate); if (r) rows.push(r); }
          const ranked = compositeRanks(rows, { reversal });
          const t = targets(ranked, { k, universe });
          t.beta = basketBeta(universe, indexSeries, t.short, signalDate);
          stats.eligible.push(ranked.length); stats.sectors.push(new Set(ranked.map(r => r.sector)).size);
          cache.set(signalDate, t);
          return t;
        };
        const longSim = fp.simulatePeriodic({ universe, calendar: bench, ends, chooser: date => prepare(date).long, side: 'long' });
        const shortSim = fp.simulatePeriodic({ universe, calendar: bench, ends, chooser: date => prepare(date).short, side: 'short', borrow: true });
        // Hedge leg: long index future at beta × short notional; cost on beta changes.
        let prevBeta = 0;
        const hedge = shortSim.periods.map(row => {
          const beta = prepare(row.signalDate).beta;
          const leg = fp.returnBetween(indexSeries, row.entryDate, row.exitDate);
          const cost = Math.abs(beta - prevBeta) * futureRt / 2 + beta * 4 * futureRt * ((leg?.days || 21) / 252);
          prevBeta = beta;
          return { date: row.date, beta, ret: (leg ? leg.ret : 0) * beta - cost };
        });
        const spread = shortSim.periods.map((row, i) => ({ ...row, ret: row.ret + hedge[i].ret }));
        const combined = longSim.periods.map((row, i) => ({ ...row, ret: row.ret + spread[i].ret, turnover: row.turnover + shortSim.periods[i].turnover }));
        const tag = `${market} ${rebalance} comp-${composite} ${k ? `k=${k}` : 'quintile'}`;
        const common = { calendarDates: bench.dates, horizon, market, extra: { family: 'F14', rebalance, composite, k: k || 'quintile', avgEligible: fp.fix(fp.mean(stats.eligible), 1), avgSectors: fp.fix(fp.mean(stats.sectors), 1), avgBeta: fp.fix(fp.mean(hedge.map(h => h.beta)), 3) } };
        books.push(fp.scoreBook({ ...common, label: `F14 ${tag} LONG`, sim: longSim, benchmarkSeries: bench, hurdleSeries: universe.spec.hurdle ? benchmarks[universe.spec.hurdle] : null, cell: `${market} × ${horizon} × long` }));
        const diag = { benchmarkSeries: bench, hurdleSeries: universe.spec.hurdle ? benchmarks[universe.spec.hurdle] : null, verdictVsZero: true, needsAlpha: false };
        books.push(fp.scoreBook({ ...common, ...diag, label: `F14 ${tag} SHORT (hedged)`, sim: { periods: spread, trades: shortSim.trades }, cell: `${market} × ${horizon} × short` }));
        books.push(fp.scoreBook({ ...common, ...diag, label: `F14 ${tag} L/S`, sim: { periods: combined, trades: [...longSim.trades, ...shortSim.trades] }, cell: `${market} × ${horizon} × long/short` }));
      }
    }
  }
  return books;
}

function render(books, universes, deflated, profileNote) {
  const lines = [];
  lines.push('# F14 readout — multi-factor long/short equity (2026-10-25)');
  lines.push('');
  lines.push('Research only. Specification frozen in `docs/fund-program-preregistration-2026-10-25.md` (commit 43320cd). Composite A = sector-relative mean percentile of 12-1 momentum, quality (Piotroski; ROA for half-year filers), value (earnings yield + book-to-price), low 252-day vol; composite B adds 1-month reversal. Long = top quintile per sector, short = bottom quintile per sector (sectors with < 5 eligible names skipped); short leg hedged with a long index future at its trailing 252-day beta. Costs: market round trip at entry (UK stamp on buys and buy-to-cover), borrow 1%/yr (3% below 5 local units), micro round trip + roll on the hedge. Executable k = 5 and 10 per side, ≤ 2 names per sector, $30k tickets.');
  lines.push('');
  lines.push('Pass rules: long leg — excess t ≥ 3 vs index and alpha t ≥ 2 (US: SPY+QQQ, beats QQQ); short leg — hedged-spread t ≥ 3; combined — t ≥ 3 vs zero; every window with trades profitable with PF ≥ 1.2 on spells; positive full sample. INCUBATION_ELIGIBLE: positive net excess, ≥ 3 of 4 windows positive, t ≥ 1.5, max DD < 50%.');
  lines.push('');
  lines.push(`Trials: ${books.length}. VALIDATION_PASS: ${books.filter(b => b.verdict === 'VALIDATION_PASS').length}. INCUBATION_ELIGIBLE: ${books.filter(b => b.verdict === 'INCUBATION_ELIGIBLE').length}. ${profileNote}`);
  lines.push('');
  lines.push('## Construction caveat — the combined L/S book is net long the index');
  lines.push('');
  lines.push('As pre-registered, combined L/S = long leg + hedged short leg, where the hedged short leg = −(short basket) + β × index future. The long leg carries ≈ +1 β, the short basket −1 β and the hedge +β (β of the short basket, 1.0–1.3 here), so the combined book has a **net index beta of roughly β, not zero**. Its t vs zero therefore mostly measures the index return over the sample, not spread alpha. The pre-registered verdict rule is kept, and the "Index diagnostics" columns (β to the index and alpha t after removing it; US: SPY+QQQ) show what remains. Any INCUBATION_ELIGIBLE L/S row whose alpha t is below 2 is beta, not a strategy. A market-neutral construction (long leg β-hedged too, or combined = long − short without the hedge) was not pre-registered and is not run here.');
  lines.push('');
  lines.push('## Cells filled');
  lines.push('');
  const flagged = books.filter(b => b.verdict !== 'FAIL');
  if (!flagged.length) lines.push('No row passes or is incubation-eligible; F14 fills no cell.');
  for (const b of flagged) {
    const d = b.indexDiagnostics;
    lines.push(`- ${b.verdict === 'VALIDATION_PASS' ? '**VALIDATION_PASS**' : 'INCUBATION_ELIGIBLE'} ${b.label} → ${b.verdict === 'VALIDATION_PASS' ? 'fills' : 'candidate for'} \`${b.cell}\`${d ? ` — index β ${d.beta}, alpha t ${d.alphaT} (${d.model})${d.alphaT != null && d.alphaT < 2 ? '; **beta, not alpha**' : ''}` : ''}`);
  }
  lines.push('');
  lines.push('## Deflated Sharpe (all F14 trials, top 10)');
  lines.push('');
  const top = deflated.filter(d => d.probability != null).sort((a, b) => b.probability - a.probability).slice(0, 10);
  lines.push(fp.mdTable(['Book', 'Trials', 'Sharpe (excess, ann.)', 'SR0', 'P(deflated)'], top.map(d => [d.label, books.length, fp.fix(d.annualized), fp.fix(d.sr0 == null ? null : d.sr0 * Math.sqrt(12)), fp.fix(d.probability, 3)])));
  lines.push('');
  lines.push('## Universe coverage');
  lines.push('');
  lines.push(fp.mdTable(['Market', 'Ever', 'Priced', 'With statements', 'Piotroski-eligible', 'With sector'], Object.values(universes).map(u => [u.market, u.coverage.everMembers, u.coverage.priced, u.coverage.withStatements, u.coverage.withPiotroski, u.coverage.withSector])));
  lines.push('');
  for (const market of MARKETS) {
    const rows = books.filter(b => b.market === market);
    lines.push(`## ${market}`);
    lines.push('');
    lines.push(fp.mdTable(['Book', 'Periods', 'Net %', 'Index %', 't', 'Alpha t', 'Beats QQQ', 'Index β (diag)', 'Alpha t (diag)', 'Max DD %', 'Spells', 'PF', 'Eligible', 'Sectors', 'β hedge', 'Windows', 'Verdict'], rows.map(b => [
      b.label.replace(`F14 ${market} `, ''), b.periods, b.netReturnPct, b.benchmarkReturnPct ?? b.indexDiagnostics?.indexReturnPct ?? null, b.excessT, b.alpha?.t ?? null, b.hurdle ? (b.hurdle.beatsQqq ? 'yes' : 'no') : '—',
      b.indexDiagnostics?.beta ?? '—', b.indexDiagnostics?.alphaT ?? '—',
      b.maxDrawdownPct, b.trades, b.pf, b.avgEligible, b.avgSectors, b.label.includes('LONG') ? '—' : b.avgBeta,
      b.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''), b.verdict,
    ])));
    lines.push('');
    for (const b of rows) {
      lines.push(`<details><summary>${b.label} — ${b.verdict}${b.failReasons.length ? ` (${b.failReasons.join('; ')})` : ''}</summary>`, '');
      if (b.alpha) lines.push(`Alpha: ${b.alpha.model}, ${b.alpha.alphaAnnualPct}%/yr, t ${b.alpha.t}.`);
      if (b.hurdle) lines.push(`QQQ ${b.hurdle.qqqReturnPct}%, beats QQQ: ${b.hurdle.beatsQqq ? 'yes' : 'no'}.`);
      if (b.indexDiagnostics) lines.push(`Index diagnostics (${b.indexDiagnostics.model}): index ${b.indexDiagnostics.indexReturnPct}% over the sample, β ${b.indexDiagnostics.beta}${b.indexDiagnostics.betaQqq != null ? ` / β QQQ ${b.indexDiagnostics.betaQqq}` : ''}, alpha ${b.indexDiagnostics.alphaAnnualPct}%/yr, alpha t ${b.indexDiagnostics.alphaT}.`);
      lines.push(`Annualized ${b.annualizedPct}%; average names ${b.avgNames}; average turnover ${b.avgTurnover}.`);
      lines.push('', fp.windowsTable(b.windows), '', fp.yearlyMd(b.yearly), '', '</details>', '');
    }
  }
  lines.push('## Notes');
  lines.push('');
  lines.push('- Trial count: the pre-registration counted 80 trials (k-books as one trial each); this run scores the k = 5 and k = 10 books as long, short and L/S separately, giving 144 trials. The deflated Sharpe is therefore computed over more trials than pre-registered (stricter); no book was added or removed.');
  lines.push('- The "t" column is the monthly excess t vs the index for LONG books and the t vs zero for SHORT (hedged) and L/S books.');
  lines.push('- Short-leg spells are scored net of borrow and costs; the hedge return is added at the portfolio level, not per spell.');
  lines.push('- Delisted names exit at the last available close (a short that is delisted at zero is not modelled; shorts of acquired names exit at the last print).');
  lines.push('- Ever-member names without a cached price or statement file are excluded (coverage table); the UK and continental samples are thin, so sector quintiles are often one or two names.');
  return lines.join('\n');
}

async function main() {
  const benchmarks = {};
  for (const symbol of ['SPY', 'QQQ', 'EWU', 'EWQ', 'EWG']) benchmarks[symbol] = await fp.loadOrFetchSeries(symbol);
  const indexSeries = {};
  for (const market of MARKETS) indexSeries[market] = await fp.loadOrFetchSeries(fp.MARKETS[market].indexFuture);
  // Profiles for all ever-members first (sector-neutral ranking needs them).
  let profileNote = '';
  for (const market of MARKETS) {
    const snapshot = fp.readJson(fp.MARKETS[market].membershipFile);
    const symbols = [...fp.everMembers(snapshot)];
    const result = await ensureProfiles(symbols);
    if (result.missing) profileNote += `${market}: ${result.fetched} of ${result.missing} missing sector profiles fetched. `;
  }
  const universes = {};
  for (const market of MARKETS) {
    universes[market] = fp.loadMarketUniverse(market);
    console.log(`${market}: ${JSON.stringify(universes[market].coverage)}`);
  }
  const books = [];
  for (const market of MARKETS) {
    console.log(`running ${market}`);
    books.push(...runMarket(market, universes[market], benchmarks, indexSeries[market]));
  }
  const deflated = fp.deflate(books);
  for (const b of books) console.log(`${b.verdict.padEnd(20)} ${b.label.padEnd(52)} net ${b.netReturnPct}% bench ${b.benchmarkReturnPct ?? '—'}% t ${b.excessT} alpha t ${b.alpha?.t ?? '—'} DD ${b.maxDrawdownPct}% windows ${b.windows.map(w => w.returnPct).join('/')}`);
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), trials: books.length, coverage: Object.fromEntries(Object.values(universes).map(u => [u.market, u.coverage])), books: books.map(fp.stripPrivate), deflated }, null, 2));
  fs.writeFileSync(OUT_MD, render(books, universes, deflated, profileNote));
  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
