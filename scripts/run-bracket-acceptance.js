#!/usr/bin/env node
/**
 * Run v143 bracket acceptance tests (sell + buy × short/medium/long).
 * Criteria: WR ≥55% OR avg ≥+0.30%/trade, AND PF ≥1.5.
 *
 * Usage:
 *   node scripts/run-bracket-acceptance.js
 *   node scripts/run-bracket-acceptance.js --window=252 --sides=sell,buy
 *   node scripts/run-bracket-acceptance.js --sides=sell --hz=short,medium,long
 */
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v == null ? '1' : v];
  })
);

const windowBars = parseInt(args.window, 10) || 252;
const sides = String(args.sides || 'sell,buy').split(',').map(s => s.trim()).filter(Boolean);
const horizons = String(args.hz || 'short,medium,long').split(',').map(s => s.trim()).filter(Boolean);
const maxTickers = parseInt(args.tickers, 10) || 30; // keep runtime sane for local Yahoo

process.env.PORT = process.env.PORT || '3999'; // unused — server only required, not listening

const {
  runBracketAcceptance,
  ACCEPTANCE_DEFAULT_TICKERS
} = require('../server.js');

async function main() {
  const tickers = ACCEPTANCE_DEFAULT_TICKERS.slice(0, maxTickers);
  const brackets = [];
  console.log(`Bracket acceptance | window=${windowBars} | tickers=${tickers.length} | sides=${sides.join(',')} | hz=${horizons.join(',')}`);
  console.log('Criteria: WR≥55% OR avg≥+0.30%/trade, AND PF≥1.5\n');

  for (const side of sides) {
    for (const hz of horizons) {
      const key = `${side}:${hz}`;
      process.stdout.write(`→ ${key} … `);
      const t0 = Date.now();
      const r = await runBracketAcceptance({
        hz, side, window: windowBars, tickers, maxTickers: tickers.length, entryStep: 3
      });
      const ms = Date.now() - t0;
      const a = r.aggregate || {};
      const pass = !!(r.acceptance && r.acceptance.pass);
      console.log(
        `${pass ? 'PASS' : 'FAIL'} | trades=${a.totalTrades ?? 0} WR=${a.winRate ?? '—'}% avg=${a.avgReturnPct ?? '—'}% PF=${a.meanProfitFactor ?? '—'} (${ms}ms)`
      );
      brackets.push({
        key, hz: r.hz, side: r.side, windowBars: r.windowBars, range: r.range,
        aggregate: r.aggregate, acceptance: r.acceptance, tickersTested: r.tickersTested
      });
    }
  }

  const out = {
    ranAt: new Date().toISOString(),
    windowBars,
    criteria: 'WR≥55% OR avg≥+0.30%/trade, AND PF≥1.5',
    tickers,
    passed: brackets.filter(b => b.acceptance.pass).map(b => b.key),
    failed: brackets.filter(b => !b.acceptance.pass).map(b => b.key),
    brackets
  };

  const outPath = path.join(__dirname, 'bracket-acceptance-results.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`Passed: ${out.passed.join(', ') || '(none)'}`);
  console.log(`Failed: ${out.failed.join(', ') || '(none)'}`);
  process.exit(out.failed.length ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(2);
});
