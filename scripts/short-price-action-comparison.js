#!/usr/bin/env node
'use strict';

process.env.PORT = process.env.PORT || '3995';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-price-action-'));

const { DEFAULT_POLICY } = require('../lib/strategy/decision-engine');
const { summarizeReturns, summarizeDatedPortfolio } = require('../lib/research/performance');
const {
  backtestSignal,
  fetchOHLCV,
  dailyToWeeklyBars,
  buildMarketRegime
} = require('../server');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const windowBars = Math.max(252, Number(args.window) || 756);
const entryStep = Math.max(1, Number(args.entryStep) || 2);
const maxPerMarket = Math.max(5, Number(args.perMarket) || 20);
const notionalPerTrade = Math.max(1000, Number(args.notional) || 10000);
const SCORE_POLICY = Object.freeze({
  ...DEFAULT_POLICY,
  version: 'price-action-research-v1',
  minConfidence: 0
});

const UNIVERSES = {
  US: {
    benchmark: 'SPY',
    tickers: [
      'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'MA',
      'UNH', 'HD', 'AVGO', 'LLY', 'XOM', 'CVX', 'COST', 'WMT', 'AMD', 'CRM',
      'ORCL', 'GS', 'BAC', 'MCD', 'QCOM', 'CAT', 'GE', 'DIS', 'NKE', 'SBUX'
    ]
  },
  UK: {
    benchmark: '^FTSE',
    tickers: [
      'AZN.L', 'SHEL.L', 'HSBA.L', 'ULVR.L', 'BP.L', 'GSK.L', 'REL.L', 'DGE.L',
      'BATS.L', 'RIO.L', 'LSEG.L', 'NG.L', 'RR.L', 'BA.L', 'LLOY.L', 'BARC.L',
      'VOD.L', 'PRU.L', 'GLEN.L', 'AAL.L', 'SGRO.L', 'III.L', 'EXPN.L', 'CPG.L'
    ]
  }
};

const VARIANTS = [
  {
    id: 'current',
    label: 'Current short-horizon policy',
    opts: { stopFirst: true }
  },
  {
    id: 'score_baseline',
    label: 'Old score logic without current Anglo pause/Strong-only gate',
    opts: {
      stopFirst: true,
      researchAngloScoreOnly: true,
      decisionPolicy: SCORE_POLICY
    }
  },
  {
    id: 'price_action',
    label: 'Old score + price-action setup + structural bracket',
    opts: {
      stopFirst: true,
      priceActionShort: true,
      researchAngloScoreOnly: true,
      rel20Min: 0,
      decisionPolicy: SCORE_POLICY
    }
  }
];

async function loadBars(symbol, range) {
  const daily = await fetchOHLCV(symbol, range, '1d').catch(() => null);
  if (!daily || daily.length < 280) return null;
  return { daily, weekly: dailyToWeeklyBars(daily) };
}

function summarize(rows) {
  const returnSummary = summarizeReturns(rows.map(row => row.ret));
  const portfolio = summarizeDatedPortfolio(rows);
  return {
    trades: returnSummary.trades,
    wins: rows.filter(row => row.ret > 0).length,
    losses: rows.filter(row => row.ret <= 0).length,
    winRate: returnSummary.winRate,
    avgReturnPct: returnSummary.avgReturnPct,
    profitFactor: returnSummary.profitFactor,
    netPnlUsdAtFixedNotional: +rows.reduce((sum, row) =>
      sum + row.ret * notionalPerTrade, 0).toFixed(2),
    compoundedReturnPct: portfolio.compoundedReturnPct,
    maxDrawdownPct: portfolio.maxDrawdownPct,
    sharpe: portfolio.sharpe
  };
}

async function main() {
  const range = windowBars >= 500 ? '5y' : '2y';
  const results = [];
  for (const [market, config] of Object.entries(UNIVERSES)) {
    const benchmark = await loadBars(config.benchmark, range);
    if (!benchmark) throw new Error('Could not load benchmark ' + config.benchmark);
    const marketSeries = buildMarketRegime(benchmark.daily);
    const tickers = config.tickers.slice(0, maxPerMarket);
    const cache = new Map();
    for (const symbol of tickers) {
      process.stdout.write(`Loading ${market} ${symbol}... `);
      const bars = await loadBars(symbol, range);
      cache.set(symbol, bars);
      console.log(bars ? bars.daily.length + ' bars' : 'skipped');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    for (const side of ['buy', 'sell']) {
      for (const variant of VARIANTS) {
        const trades = [];
        const rejects = {};
        for (const symbol of tickers) {
          const bars = cache.get(symbol);
          if (!bars) continue;
          const bt = await backtestSignal(bars.daily, 'short', bars.weekly, null, {
            symbol,
            market,
            side,
            windowBars,
            entryStep,
            closedOnly: true,
            decisionPolicy: DEFAULT_POLICY,
            marketSeries,
            spyBars: benchmark.daily,
            ...variant.opts
          });
          if (!bt) continue;
          trades.push(...(bt.tradeResults || []).map(row => ({ ...row, symbol, market })));
          for (const [reason, count] of Object.entries(bt.rejectionCounts || {})) {
            rejects[reason] = (rejects[reason] || 0) + Number(count || 0);
          }
        }
        const metrics = summarize(trades);
        results.push({ market, side, variant: variant.id, label: variant.label, metrics, rejects });
        console.log(`${market} ${side} ${variant.id}: trades=${metrics.trades} WR=${metrics.winRate ?? '—'}% net=$${metrics.netPnlUsdAtFixedNotional} PF=${metrics.profitFactor ?? '—'}`);
      }
    }
  }

  const combined = [];
  for (const side of ['buy', 'sell', 'both']) {
    for (const variant of VARIANTS) {
      const selected = results.filter(row => row.variant === variant.id
        && (side === 'both' || row.side === side));
      const metrics = summarize(selected.flatMap(row => {
        // Per-market metrics cannot reconstruct trade paths; combined fixed-notional
        // PnL and weighted WR are therefore reported directly below.
        return [];
      }));
      const trades = selected.reduce((sum, row) => sum + row.metrics.trades, 0);
      const wins = selected.reduce((sum, row) => sum + row.metrics.wins, 0);
      combined.push({
        side,
        variant: variant.id,
        trades,
        winRate: trades ? +(wins / trades * 100).toFixed(1) : null,
        netPnlUsdAtFixedNotional: +selected.reduce((sum, row) =>
          sum + row.metrics.netPnlUsdAtFixedNotional, 0).toFixed(2),
        avgReturnPct: trades ? +(selected.reduce((sum, row) =>
          sum + row.metrics.avgReturnPct * row.metrics.trades, 0) / trades).toFixed(3) : null,
        _unused: metrics.trades
      });
    }
  }
  combined.forEach(row => { delete row._unused; });

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      markets: ['US', 'UK'],
      horizon: 'short',
      windowBars,
      entryStep,
      nextOpenEntry: true,
      stopFirst: true,
      gapAwareStructuralStops: true,
      currentFundamentals: false,
      costs: true,
      notionalPerTrade
    },
    results,
    combined
  };
  const out = path.join(__dirname, 'short-price-action-comparison-results.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('Wrote ' + out);
  console.log(JSON.stringify(combined, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
