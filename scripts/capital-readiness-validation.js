#!/usr/bin/env node
'use strict';

process.env.PORT = process.env.PORT || '3998';
process.env.AUTH_TEST_BYPASS = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RESEARCH_MODE = '1';
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-research-'));
const {
  runBracketAcceptance,
  ACCEPTANCE_DEFAULT_TICKERS
} = require('../server');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const windows = String(args.windows || '252,504,1260').split(',').map(Number).filter(Number.isFinite);
const maxTickers = Math.max(10, Number(args.tickers) || 40);
const tickers = ACCEPTANCE_DEFAULT_TICKERS.slice(0, maxTickers);

function readBaseline() {
  const file = path.join(__dirname, 'capital-readiness-baseline.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function compareMetric(candidate, baseline, field) {
  const a = Number(candidate && candidate[field]);
  const b = Number(baseline && baseline[field]);
  return Number.isFinite(a) && Number.isFinite(b) ? +(a - b).toFixed(3) : null;
}

async function main() {
  const baseline = readBaseline();
  const runs = [];
  for (const window of windows) {
    for (const side of ['buy', 'sell']) {
      for (const hz of ['short', 'medium', 'long']) {
        const key = `${side}:${hz}:${window}`;
        process.stdout.write(`Validating ${key}... `);
        const result = await runBracketAcceptance({
          hz,
          side,
          window,
          tickers,
          maxTickers,
          entryStep: 3
        });
        const rejectionCounts = {};
        for (const ticker of result.perTicker || []) {
          for (const [reason, count] of Object.entries(ticker.rejectionCounts || {})) {
            rejectionCounts[reason] = (rejectionCounts[reason] || 0) + Number(count || 0);
          }
        }
        const prior = baseline && baseline.runs && baseline.runs.find(x => x.key === key);
        const row = {
          key,
          windowBars: window,
          side,
          horizon: hz,
          metrics: result.aggregate,
          promotion: result.acceptance,
          diagnostics: {
            tickersTested: result.tickersTested,
            tickersWithTrades: (result.perTicker || []).filter(x => Number(x.trades) > 0).length,
            rejectionCounts
          },
          policyVersions: result.policyVersions,
          deltaVsBaseline: prior ? {
            winRate: compareMetric(result.aggregate, prior.metrics, 'winRate'),
            avgReturnPct: compareMetric(result.aggregate, prior.metrics, 'avgReturnPct'),
            profitFactor: compareMetric(result.aggregate, prior.metrics, 'meanProfitFactor'),
            sharpe: compareMetric(result.aggregate, prior.metrics, 'sharpe'),
            maxDrawdownPct: compareMetric(result.aggregate, prior.metrics, 'maxDrawdownPct')
          } : null
        };
        runs.push(row);
        console.log(result.acceptance.pass ? 'PASS' : 'FAIL', JSON.stringify(result.aggregate));
      }
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      pointInTimeBars: true,
      nextBarEntry: true,
      modeledCosts: true,
      exactDecisionPolicy: true,
      windows,
      tickers
    },
    passed: runs.filter(r => r.promotion.pass).map(r => r.key),
    failed: runs.filter(r => !r.promotion.pass).map(r => r.key),
    runs
  };
  const out = path.join(__dirname, 'capital-readiness-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Wrote ${out}`);
  if (args['save-baseline'] === '1') {
    fs.writeFileSync(path.join(__dirname, 'capital-readiness-baseline.json'), JSON.stringify(report, null, 2));
    console.log('Saved baseline');
  }
  process.exit(report.failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
