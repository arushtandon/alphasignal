'use strict';

/**
 * Consolidated fund-program readout: every F12/F13/F14 trial, the verdict
 * tally, the cell map, and the deflated Sharpe per family.
 *
 *   node scripts/run-fund-program-summary.js
 */

const fs = require('fs');
const path = require('path');
const fp = require('../lib/research/fund-program');

const ROOT = path.join(__dirname, '..');
const OUT_MD = path.join(ROOT, 'docs', 'fund-program-readout-2026-10-25.md');
const read = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8'));

function main() {
  const f12 = read('f12-results.json'); const f13 = read('f13-results.json'); const f14 = read('f14-results.json');
  const data = read('fund-program-data-check.json');
  const all = [
    ...f12.books.map(b => ({ family: 'F12', ...b })),
    ...f13.books.map(b => ({ family: 'F13', ...b })),
    ...f14.books.map(b => ({ family: 'F14', ...b })),
  ];
  const passing = all.filter(b => b.verdict === 'VALIDATION_PASS');
  const incubation = all.filter(b => b.verdict === 'INCUBATION_ELIGIBLE');
  const byCell = new Map();
  for (const b of all) {
    if (!byCell.has(b.cell)) byCell.set(b.cell, []);
    byCell.get(b.cell).push(b);
  }
  const lines = [];
  lines.push('# Fund-style program — consolidated readout (2026-10-25)');
  lines.push('');
  lines.push('Research only; no bridge or live change. Pre-registration `docs/fund-program-preregistration-2026-10-25.md` (commit 43320cd) was frozen before any run. Family readouts: `docs/f12-readout-2026-10-25.md`, `docs/f13-readout-2026-10-25.md`, `docs/f14-readout-2026-10-25.md`. Data check: `docs/fund-program-data-check-2026-10-25.md`. Execution feasibility: `docs/fund-program-execution-feasibility-2026-10-25.md`.');
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  lines.push(`${all.length} trials (F12 ${f12.books.length}, F13 ${f13.books.length}, F14 ${f14.books.length}). **VALIDATION_PASS: ${passing.length}. INCUBATION_ELIGIBLE: ${incubation.length}.** No empty cell is filled by a validated strategy.`);
  lines.push('');
  lines.push('Deviations from the pre-registration, all stricter or neutral: F14 scores the k = 5 / k = 10 books as separate long, short and L/S trials (144 rather than 80), so its deflated Sharpe uses more trials; the F12-A rest-of-month comparison uses the sessions of the two calendar months spanned by the trade (the pre-registration said "that month"). No book was added, removed or re-parameterised after seeing results.');
  lines.push('');
  lines.push('## Data check (step 0)');
  lines.push('');
  const partial = data.rows.filter(r => r.verdict !== 'OK' && r.assetClass !== 'benchmark');
  lines.push(`All requested series are continuous daily from January 2010 except: ${partial.map(r => `\`${r.symbol}\` from ${r.report.first}`).join(', ')}. Reported, not substituted; those instruments enter F13 when their lookback is complete. Yahoo \`=F\` series are front-month continuous with roll jumps (used as-is; roll cost charged explicitly). IBKR micro Treasury contracts are yield-quoted (sign inversion is an execution item).`);
  lines.push('');
  lines.push('## Incubation-eligible rows and the cell each would fill');
  lines.push('');
  lines.push('None is validated. Rows marked "beta" have an index β near or above 1 after construction and an alpha t below 2 — the return is market exposure, not a strategy.');
  lines.push('');
  lines.push(fp.mdTable(['Family', 'Row', 'Cell', 'Periods', 'Net %', 'Bench / index %', 't', 'Alpha t', 'Index β (diag)', 'Alpha t (diag)', 'Max DD %', 'PF (spells)', 'Windows', 'Why not validated'], incubation.map(b => [
    b.family, b.label, `\`${b.cell}\``, b.periods, b.netReturnPct, b.benchmarkReturnPct ?? b.indexDiagnostics?.indexReturnPct ?? '0 (vs zero)', b.excessT, b.alpha?.t ?? '—',
    b.indexDiagnostics?.beta ?? '—', b.indexDiagnostics?.alphaT ?? '—', b.maxDrawdownPct, b.pf,
    b.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''),
    (b.indexDiagnostics && b.indexDiagnostics.beta > 0.5 && !(b.indexDiagnostics.alphaT >= 2) ? '**beta**; ' : '') + b.failReasons.join('; '),
  ])));
  lines.push('');
  lines.push('## Cell map — best row per cell across F12, F13, F14');
  lines.push('');
  lines.push('"Best" = highest monthly t (per-trade t for F12-A). Cells not listed were not addressed by this program.');
  lines.push('');
  const cellRows = [...byCell.entries()].map(([cell, rows]) => {
    const best = rows.slice().sort((a, b) => (b.excessT ?? -99) - (a.excessT ?? -99))[0];
    return [`\`${cell}\``, rows.length, best.label, best.excessT, best.alpha?.t ?? best.indexDiagnostics?.alphaT ?? '—', best.maxDrawdownPct, best.verdict];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  lines.push(fp.mdTable(['Cell', 'Trials', 'Best row', 't', 'Alpha t', 'Max DD %', 'Verdict'], cellRows));
  lines.push('');
  lines.push('## Deflated Sharpe by family (best trial)');
  lines.push('');
  const bestOf = (deflated, n) => deflated.filter(d => d.probability != null).sort((a, b) => b.probability - a.probability)[0] || null;
  lines.push(fp.mdTable(['Family', 'Trials', 'Best trial', 'Sharpe (ann.)', 'SR0 (ann.)', 'P(deflated)'], [
    ['F12', f12.trials, ...(d => d ? [d.label, fp.fix(d.annualized), fp.fix(d.sr0 * Math.sqrt(12)), fp.fix(d.probability, 3)] : ['—', '—', '—', '—'])(bestOf(f12.deflated))],
    ['F13', f13.trials, ...(d => d ? [d.label, fp.fix(d.annualized), fp.fix(d.sr0 * Math.sqrt(12)), fp.fix(d.probability, 3)] : ['—', '—', '—', '—'])(bestOf(f13.deflated))],
    ['F14', f14.trials, ...(d => d ? [d.label, fp.fix(d.annualized), fp.fix(d.sr0 * Math.sqrt(12)), fp.fix(d.probability, 3)] : ['—', '—', '—', '—'])(bestOf(f14.deflated))],
  ]));
  lines.push('');
  lines.push('No family produces a trial whose deflated-Sharpe probability exceeds 0.55; the best candidates are indistinguishable from the best of N noise trials.');
  lines.push('');
  lines.push('## Family summaries');
  lines.push('');
  lines.push('### F12-A turn-of-month');
  lines.push('');
  const tom = f12.books.filter(b => b.label.startsWith('A '));
  lines.push(fp.mdTable(['Index', 'Variant', 'Trades', 'Mean/trade %', 'Per-trade t', 'PF', 'Net %', 'Buy & hold %', 'vs rest-of-month t', 'Max DD %', 'Windows', 'Verdict'], tom.map(b => [b.label.replace(/^A TOM /, '').replace(/ -?\d\.\.\+\d$/, ''), b.variant, b.trades, b.perTradeMeanPct, b.perTradeT, b.pf, b.netReturnPct, b.buyAndHoldPct, b.vsRestOfMonth?.t, b.maxDrawdownPct, b.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''), b.verdict])));
  lines.push('');
  lines.push('The effect is positive on most indices for the −1..+3 window (mean 0.2–0.3% per trade, PF 1.3–1.5) and it beats the rest of the month at t ≈ 2 on the FTSE and S&P, but no index reaches per-trade t ≥ 3, and each has at least one losing window. Nikkei shows nothing. Costs (micro round trip + pro-rata roll, 0.04% + ~0.0001%) are not the binding constraint.');
  lines.push('');
  lines.push('### F12-B low volatility');
  lines.push('');
  lines.push(fp.mdTable(fp.SUMMARY_HEADERS, f12.books.filter(b => b.label.startsWith('B ')).map(fp.bookSummaryRow)));
  lines.push('');
  lines.push('Low vol trails the index in the US (excess t −1.7 to −2.1 against SPY) and is flat to mildly positive in Europe (alpha t up to 2.2 for Germany k=10 but excess t ≤ 0.5 and a losing window in every variant). The 12-1 > 0 filter does not help.');
  lines.push('');
  lines.push('### F12-C value + quality');
  lines.push('');
  lines.push(fp.mdTable(fp.SUMMARY_HEADERS, f12.books.filter(b => b.label.startsWith('C ')).map(fp.bookSummaryRow)));
  lines.push('');
  lines.push('With Piotroski ≥ 6 the UK, France and Germany pools are ~10 names a quarter (UK quarterly filers only), so the "quintile" is one or two names and the book is a concentration lottery (max DD 52–63%). The US pool is 124–300 names and still trails SPY (99% vs 307%). Not a candidate anywhere.');
  lines.push('');
  lines.push('### F13 managed-futures trend');
  lines.push('');
  lines.push(fp.mdTable(['Variant', 'Months', 'Net %', 'Ann. %', 'Realized vol %', 'Sharpe', 't vs 0', 'Max DD %', 'Corr SPY', 'Book in worst-10% SPY months', '60/40 Sharpe', 'Windows', 'Verdict'], f13.books.map(b => [b.variant, b.periods, b.netReturnPct, b.annualizedPct, b.realizedVolPct, b.sharpeAnnual, b.sharpeT, b.maxDrawdownPct, b.corrSpy, `${b.worstSpyMonths.bookMeanPct}% vs SPY ${b.worstSpyMonths.spyMeanPct}%`, b.sixtyForty.sharpeAnnual, b.windows.map(w => (w.periods ? (w.returnPct > 0 ? '+' : '−') : '·')).join(''), b.verdict])));
  lines.push('');
  lines.push('Vol targeting works (realized 9.9–10.8% against a 10% target). 12-month trend is the only variant with a positive Sharpe worth naming (0.34, t 1.4) and it has a losing first window; 1-month trend loses 49% after costs. Crisis behaviour is the expected one only for the 1m variant (+2.2% in the worst-decile SPY months) — the slower variants are flat to slightly negative there. 60/40 earned a Sharpe of about 0.85 over the same sample. Per-instrument and per-class tables are in the F13 readout; equity index longs (NQ, ES, YM) and the yen carry the 12m book, FX and rates detract.');
  lines.push('');
  lines.push('### F14 multi-factor long/short');
  lines.push('');
  lines.push('Long legs: no market beats its index on excess t (best US long k=5 at −0.8; France quarterly quintile long has alpha t 2.4 but excess t 1.75 and a losing window). Hedged short legs: the US quarterly k=5/k=10 books are the only rows anywhere in the program with index-neutral alpha t above 2 (2.2–2.7), with t vs zero 1.8–2.2 and spell PF ≈ 0.85–1.0 — the single-name shorts lose money and the hedge earns it back with a negative net beta; incubation-eligible, not validated. Combined L/S rows are net long the index by construction (see the F14 readout caveat); their t vs zero is beta. UK shorts lose 50–85% in every variant (half-year filers excluded from quality, thin sectors).');
  lines.push('');
  lines.push('## What this means for the cell grid');
  lines.push('');
  lines.push('- No cell gains a validated strategy from F12, F13 or F14.');
  lines.push(`- Incubation-eligible, not beta-driven: F12-A FTSE 100 −1..+3 and −1..+1 (\`UK × short × long\`), F12-A S&P 500 −1..+3 (\`US × short × long\`), F12-A Hang Seng −1..+1 (\`Hong Kong × short × long\`), F14 US quarterly comp-A/B k=5 and comp-B k=10 SHORT (hedged) (\`US × long × short\`).`);
  lines.push('- Incubation-eligible but beta: every F14 L/S row (US, France) — index β 0.4–1.7 with alpha t < 2 except US quarterly comp-B k=10 L/S (alpha t 2.06, β 1.4).');
  lines.push('- F13 does not fill the new `MULTI-ASSET × medium × long/short` cell.');
  lines.push('- Execution work for micro futures, single-stock shorts and hedged baskets (feasibility write-up) is not warranted by these results.');
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Wrote ${path.relative(ROOT, OUT_MD)}: ${all.length} trials, ${passing.length} pass, ${incubation.length} incubation`);
}

main();
