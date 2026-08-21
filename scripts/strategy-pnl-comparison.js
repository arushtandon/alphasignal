#!/usr/bin/env node
'use strict';

/**
 * Leakage-safer baseline vs candidate comparison for win rate and net PnL.
 *
 * Usage:
 *   node scripts/strategy-pnl-comparison.js
 *   node scripts/strategy-pnl-comparison.js --tickers=15 --window=252
 */

process.env.PORT = process.env.PORT || '3997';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-strategy-'));

const { DEFAULT_POLICY } = require('../lib/strategy/decision-engine');
const { summarizeReturns, summarizeDatedPortfolio } = require('../lib/research/performance');
const {
  backtestSignal,
  fetchOHLCV,
  ACCEPTANCE_DEFAULT_TICKERS,
  dailyToWeeklyBars,
  buildMarketRegime,
} = require('../server');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));

const SCORE_POLICY = Object.freeze({
  ...DEFAULT_POLICY,
  version: 'research-score-v1',
  minConfidence: 0,
});

const maxTickers = Math.max(8, Number(args.tickers) || 20);
const windowBars = Math.max(120, Number(args.window) || 252);
const entryStep = Math.max(1, Number(args.entryStep) || 3);
const tickers = ACCEPTANCE_DEFAULT_TICKERS.slice(0, maxTickers);

const VARIANTS = [
  {
    id: 'production',
    label: 'Current live policy (score + confidence ≥62)',
    opts: { decisionPolicy: DEFAULT_POLICY, closedOnly: true }
  },
  {
    id: 'score_baseline',
    label: 'Score ≥62 only (research baseline, no confidence overlay)',
    opts: { decisionPolicy: SCORE_POLICY, closedOnly: true }
  },
  {
    id: 'candidate',
    label: 'Strategy candidate: short stretch + medium/long patience + RS',
    optsFor(side, hz) {
      const opts = { decisionPolicy: SCORE_POLICY, closedOnly: true, stopFirst: true };
      if (side === 'buy' && hz === 'short') opts.shortStretchMinAtr = 1.2;
      if (hz === 'medium' || hz === 'long') {
        opts.disablePreTp1SignalExit = true;
        opts.rel20Min = 0;
      }
      if (side === 'sell' && hz === 'short') opts.rel20Min = 0;
      return opts;
    }
  }
];

function variantOpts(variant, side, hz, shared) {
  const extra = typeof variant.optsFor === 'function' ? variant.optsFor(side, hz) : (variant.opts || {});
  return { ...shared, ...extra, side, windowBars, entryStep, closedOnly: true };
}

function emptyAgg() {
  return {
    totalTrades: 0,
    winRate: null,
    avgReturnPct: null,
    meanProfitFactor: null,
    sharpe: null,
    maxDrawdownPct: null,
    compoundedReturnPct: null
  };
}

function aggregateTrades(tradeResults) {
  const summary = summarizeReturns((tradeResults || []).map(t => t.ret));
  const portfolio = summarizeDatedPortfolio(tradeResults || []);
  if (!summary.trades) return emptyAgg();
  return {
    totalTrades: summary.trades,
    winRate: summary.winRate,
    avgReturnPct: summary.avgReturnPct,
    meanProfitFactor: summary.profitFactor,
    sharpe: portfolio.sharpe,
    maxDrawdownPct: portfolio.maxDrawdownPct,
    compoundedReturnPct: portfolio.compoundedReturnPct,
    portfolioDays: portfolio.days
  };
}

function delta(candidate, baseline, field) {
  const a = Number(candidate && candidate[field]);
  const b = Number(baseline && baseline[field]);
  return Number.isFinite(a) && Number.isFinite(b) ? +(a - b).toFixed(3) : null;
}

async function loadBars(sym, range) {
  const daily = await fetchOHLCV(sym, range, '1d').catch(() => null);
  if (!daily || daily.length < 150) return null;
  return { daily, weekly: dailyToWeeklyBars(daily) };
}

async function main() {
  const range = windowBars >= 1000 ? '5y' : '2y';
  console.log(`Strategy PnL comparison | tickers=${tickers.length} window=${windowBars} entryStep=${entryStep}`);
  console.log('Leakage controls: completed weekly bars, signal-bar stops, next-open entry, closed trades only, no current fundamentals.\n');

  const spy = await loadBars('SPY', range);
  if (!spy) throw new Error('Could not load SPY history');
  const spySeries = buildMarketRegime(spy.daily);
  const cache = new Map();
  for (const sym of tickers) {
    process.stdout.write(`Loading ${sym}... `);
    const row = await loadBars(sym, range);
    cache.set(sym, row);
    console.log(row ? `${row.daily.length} bars` : 'skipped');
    await new Promise(r => setTimeout(r, 120));
  }

  const runs = [];
  for (const side of ['buy', 'sell']) {
    for (const hz of ['short', 'medium', 'long']) {
      const byVariant = {};
      for (const variant of VARIANTS) {
        const tradeResults = [];
        const rejectionCounts = {};
        let tickersWithTrades = 0;
        for (const sym of tickers) {
          const row = cache.get(sym);
          if (!row) continue;
          const bt = await backtestSignal(row.daily, hz, row.weekly, null, variantOpts(variant, side, hz, {
            symbol: sym,
            marketSeries: spySeries,
            spyBars: spy.daily
          }));
          if (bt && bt.rejectionCounts) {
            for (const [reason, count] of Object.entries(bt.rejectionCounts)) {
              rejectionCounts[reason] = (rejectionCounts[reason] || 0) + Number(count || 0);
            }
          }
          if (bt && bt.trades && Array.isArray(bt.tradeResults)) {
            tickersWithTrades++;
            tradeResults.push(...bt.tradeResults);
          }
        }
        const aggregate = aggregateTrades(tradeResults);
        byVariant[variant.id] = {
          label: variant.label,
          aggregate,
          tickersWithTrades,
          rejectionCounts
        };
        const a = aggregate;
        console.log(
          `${variant.id.padEnd(16)} ${side}:${hz.padEnd(6)} trades=${String(a.totalTrades).padStart(4)} WR=${String(a.winRate ?? '—')}% avg=${String(a.avgReturnPct ?? '—')}% PF=${a.meanProfitFactor ?? '—'}`
        );
      }
      const baseline = byVariant.score_baseline.aggregate;
      const candidate = byVariant.candidate.aggregate;
      runs.push({
        key: `${side}:${hz}`,
        side,
        horizon: hz,
        variants: byVariant,
        vsScoreBaseline: {
          winRate: delta(candidate, baseline, 'winRate'),
          avgReturnPct: delta(candidate, baseline, 'avgReturnPct'),
          profitFactor: delta(candidate, byVariant.score_baseline.aggregate, 'meanProfitFactor'),
          compoundedReturnPct: delta(candidate, baseline, 'compoundedReturnPct')
        }
      });
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      tickers,
      windowBars,
      entryStep,
      nextOpenEntry: true,
      completedWeeklyBars: true,
      signalBarStops: true,
      closedTradesOnly: true,
      currentFundamentals: false,
      costs: true
    },
    variants: VARIANTS.map(v => ({ id: v.id, label: v.label })),
    runs
  };
  const out = path.join(__dirname, 'strategy-pnl-comparison-results.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);

  console.log('\nCandidate vs score baseline');
  for (const run of runs) {
    const d = run.vsScoreBaseline;
    console.log(
      `${run.key.padEnd(12)} ΔWR=${d.winRate ?? '—'} pp  Δavg=${d.avgReturnPct ?? '—'}%  ΔPF=${d.profitFactor ?? '—'}  Δcompounded=${d.compoundedReturnPct ?? '—'}%`
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
