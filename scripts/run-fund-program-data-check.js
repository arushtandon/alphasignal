'use strict';

/**
 * Fund-style program step 0: data check. Reports which daily series exist from
 * 2010 onward, where the gaps are, and the IBKR micro contract for each. Report
 * only — nothing is substituted. Fetches from Yahoo into
 * data/research/fund-program-prices when a series is not cached.
 *
 *   node scripts/run-fund-program-data-check.js [--offline]
 */

const fs = require('fs');
const path = require('path');
const { INSTRUMENTS, ensureSeries, gapReport } = require('../lib/research/fund-program-data');

const OFFLINE = process.argv.includes('--offline');
const ROOT = path.join(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'scripts', 'fund-program-data-check.json');
const OUT_MD = path.join(ROOT, 'docs', 'fund-program-data-check-2026-10-25.md');

function verdict(report) {
  if (!report || !report.bars) return 'MISSING';
  if (report.missingYears.length) return `PARTIAL (missing ${report.missingYears.join(', ')})`;
  if (!report.coversFrom2010) return `PARTIAL (starts ${report.first})`;
  if (report.gaps.some(gap => gap.days > 14)) return 'OK (gaps > 14d)';
  return 'OK';
}

async function main() {
  const rows = [];
  for (const instrument of INSTRUMENTS) {
    let series = null;
    try { series = await ensureSeries(instrument.symbol, { offline: OFFLINE }); } catch (e) { series = null; }
    const report = gapReport(series);
    rows.push({ ...instrument, report, verdict: verdict(report) });
    console.log(`${instrument.symbol.padEnd(10)} ${verdict(report).padEnd(28)} ${report.first || '-'} → ${report.last || '-'} bars ${report.bars} gaps>7d ${report.gaps.length}`);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), offline: OFFLINE, rows }, null, 2));

  const lines = [];
  lines.push('# Fund-style program — step 0 data check (2026-10-25)');
  lines.push('');
  lines.push('Report only; nothing substituted. Source: Yahoo chart v8 daily bars cached in `data/research/fund-program-prices/` (falls back to the strategy-/exit-amendment price caches). "OK" = continuous daily history from the first week of 2010 with no calendar gap > 14 days. Yahoo continuous futures (`=F`) are the front-month series — they contain roll jumps, which is why F13 costs charge an explicit roll per contract and signals are computed on this series as-is (documented limitation, not a substitution).');
  lines.push('');
  lines.push('| Series | Name | Class | IBKR contract | Mult | Ccy | Verdict | First | Last | Bars | Gaps > 7d | Note |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const gaps = row.report.gaps.length
      ? `${row.report.gaps.length} (longest ${Math.max(...row.report.gaps.map(gap => gap.days))}d)`
      : '0';
    lines.push(`| \`${row.symbol}\` | ${row.name} | ${row.assetClass} | ${row.ibkr} | ${row.multiplier} | ${row.currency} | ${row.verdict} | ${row.report.first || '—'} | ${row.report.last || '—'} | ${row.report.bars} | ${gaps} | ${row.note || ''} |`);
  }
  lines.push('');
  lines.push('## Gaps and caveats');
  lines.push('');
  const missing = rows.filter(row => row.verdict === 'MISSING');
  const partial = rows.filter(row => row.verdict.startsWith('PARTIAL'));
  lines.push(`- Missing entirely: ${missing.length ? missing.map(row => `\`${row.symbol}\``).join(', ') : 'none'}.`);
  lines.push(`- Partial 2010+ coverage: ${partial.length ? partial.map(row => `\`${row.symbol}\` (${row.verdict})`).join(', ') : 'none'}.`);
  for (const row of rows) {
    const long = row.report.gaps.filter(gap => gap.days > 14);
    if (long.length) lines.push(`- \`${row.symbol}\`: ${long.length} gap(s) > 14 days — ${long.slice(0, 5).map(gap => `${gap.from}→${gap.to} (${gap.days}d)`).join('; ')}${long.length > 5 ? '; …' : ''}.`);
  }
  lines.push('- Rates: IBKR micro Treasury contracts (10Y, 30Y, 5YY) are quoted in yield, not price. The research uses the price series (ZN/ZB/ZF) for signals and P&L; mapping to the micro yield contract inverts the sign and changes the DV01 per contract. Noted as an execution-feasibility item, not substituted here.');
  lines.push('- FTSE 100 and CAC 40 have no micro at IBKR: Z is GBP 10/pt (~GBP 80k notional), the CAC 40 mini is EUR 1/pt (~EUR 8k). The FTSE turn-of-month variant is therefore also run on `ISF.L`.');
  lines.push('- Crypto: `BTC-USD`/`ETH-USD` are spot series (7-day week). MBT/MET proxies trade CME hours (Sun–Fri); weekend bars are kept in the signal but trades are only opened on CME weekdays.');
  lines.push('- `^HSI` and `^N225` TOM entries use the next local open; no currency hedging is modelled (returns in local currency).');
  lines.push('');
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
