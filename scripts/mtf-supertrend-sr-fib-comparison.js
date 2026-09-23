#!/usr/bin/env node
'use strict';

process.env.PORT = process.env.PORT || '3993';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-mtf-'));

const { DEFAULT_POLICY } = require('../lib/strategy/decision-engine');
const { summarizeReturns } = require('../lib/research/performance');
const {
  aggregateByCount,
  aggregateByWeek,
  evaluateMtf,
  blendSignal
} = require('../lib/research/mtf-supertrend');
const {
  backtestSignal,
  fetchOHLCV,
  dailyToWeeklyBars
} = require('../server');
const { US_CORE, STATIC_GROUPS } = require('../universe');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const maxPerMarket = Math.max(8, Number(args.perMarket) || 80);
const notional = Math.max(1000, Number(args.notional) || 10000);
const profile = String(args.profile || '103-all');
const GRID_PARAMETERS = [
  { period: 14, multiplier: 4 },
  { period: 14, multiplier: 3 },
  { period: 13, multiplier: 4 },
  { period: 13, multiplier: 3 },
  { period: 12, multiplier: 4 },
  { period: 12, multiplier: 3 },
  { period: 11, multiplier: 4 },
  { period: 11, multiplier: 3 },
  { period: 10, multiplier: 4 }
];
const parameterSets = profile === 'grid-targets'
  ? GRID_PARAMETERS
  : [profile === '144-targets'
    ? { period: 14, multiplier: 4 }
    : { period: 10, multiplier: 3 }];
const requestedScopes = profile === '144-targets' || profile === 'grid-targets'
  ? new Set(['medium:sell', 'long:buy', 'long:sell'])
  : null;
const SCORE_POLICY = Object.freeze({
  ...DEFAULT_POLICY,
  version: 'mtf-supertrend-momentum-hlc-sr-fib-research-v2',
  minConfidence: 0
});

const US_ADDITIONAL = [
  'MDT', 'PFE', 'AMGN', 'HON', 'LOW', 'SPGI', 'BLK', 'DE', 'AXP', 'C',
  'SCHW', 'CB', 'MMC', 'PGR', 'RTX', 'BA', 'NKE', 'PM', 'UPS', 'COP',
  'SLB', 'SO', 'DUK', 'NEE', 'PLD', 'AMT', 'EQIX', 'APD', 'ECL', 'ICE',
  'CME', 'ADP', 'MDLZ', 'SYK', 'CI', 'MO', 'TGT', 'USB', 'PNC', 'BK'
];

const UNIVERSES = {
  US: {
    zone: 'America/New_York',
    tickers: [...new Set([...US_CORE, ...US_ADDITIONAL])]
  },
  UK: {
    zone: 'Europe/London',
    tickers: STATIC_GROUPS.FTSE100
  }
};

function sessionKey(timestamp, zone) {
  const raw = Number(timestamp);
  if (!(raw > 0)) return '';
  const date = new Date(raw < 1e12 ? raw * 1000 : raw);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function aggregateCashSessions(hourly, zone) {
  const groups = new Map();
  for (const bar of hourly || []) {
    const key = sessionKey(bar.t, zone);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bar);
  }
  return [...groups.entries()].map(([key, bars]) => {
    const valid = bars.filter(bar => Number.isFinite(Number(bar.c)));
    return {
      session: key,
      t: valid[valid.length - 1].t,
      o: Number(valid[0].o ?? valid[0].c),
      h: Math.max(...valid.map(bar => Number(bar.h))),
      l: Math.min(...valid.map(bar => Number(bar.l))),
      c: Number(valid[valid.length - 1].c),
      v: valid.reduce((sum, bar) => sum + (Number(bar.v) || 0), 0)
    };
  }).filter(bar => Number.isFinite(bar.c));
}

function framesAt(data, index, horizon, intradaySessions, zone) {
  const daily = data.slice(0, index + 1);
  if (horizon === 'short') {
    const key = sessionKey(data[index].t, zone);
    const primary = (intradaySessions || []).filter(bar => bar.session <= key);
    return { primary, higher: daily, labels: ['8H cash session', '1D'] };
  }
  if (horizon === 'medium') {
    return { primary: daily, higher: aggregateByCount(daily, 3), labels: ['1D', '3D'] };
  }
  return {
    primary: aggregateByCount(daily, 3),
    higher: aggregateByWeek(daily),
    labels: ['3D', '1W']
  };
}

function selectedSymbols(config, cache) {
  return config.tickers.filter(symbol => cache.get(symbol)?.selected);
}

function summarize(rows) {
  const returns = summarizeReturns(rows.map(row => row.ret));
  return {
    trades: returns.trades,
    winRate: returns.winRate,
    avgReturnPct: returns.avgReturnPct,
    profitFactor: returns.profitFactor,
    netPnlUsdAtFixedNotional: +rows.reduce((sum, row) => sum + row.ret * notional, 0).toFixed(2),
    promotionEligible: false
  };
}

async function main() {
  const cache = new Map();
  for (const [market, config] of Object.entries(UNIVERSES)) {
    let selected = 0;
    for (const symbol of config.tickers) {
      if (selected >= maxPerMarket) break;
      process.stdout.write(`Loading ${market} ${symbol}... `);
      const [daily, hourly] = await Promise.all([
        fetchOHLCV(symbol, '5y', '1d').catch(() => null),
        fetchOHLCV(symbol, '2y', '1h').catch(() => null)
      ]);
      const sessions8h = aggregateCashSessions(hourly, config.zone);
      const usable = daily?.length >= 300 && sessions8h.length >= 80;
      cache.set(symbol, {
        daily,
        sessions8h,
        zone: config.zone,
        selected: usable
      });
      if (usable) selected++;
      console.log(`daily=${daily?.length || 0} 8H=${sessions8h.length} ${usable ? `selected=${selected}` : 'skipped'}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (selected < maxPerMarket) {
      throw new Error(`${market}: only ${selected}/${maxPerMarket} candidates had sufficient daily and hourly data`);
    }
  }

  const rows = [];
  for (let parameterIndex = 0; parameterIndex < parameterSets.length; parameterIndex++) {
    const supertrendParameters = parameterSets[parameterIndex];
    const parameterKey = `${supertrendParameters.period},${supertrendParameters.multiplier}`;
    for (const [market, config] of Object.entries(UNIVERSES)) {
      const symbols = selectedSymbols(config, cache);
      for (const horizon of ['short', 'medium', 'long']) {
        for (const side of ['buy', 'sell']) {
          if (requestedScopes && !requestedScopes.has(`${horizon}:${side}`)) continue;
          const variants = parameterIndex === 0 ? ['baseline', 'mtf'] : ['mtf'];
          for (const variant of variants) {
          const trades = [];
          const rejectionCounts = {};
          for (const symbol of symbols) {
            const item = cache.get(symbol);
            if (!item?.daily || item.daily.length < 300) continue;
            const windowBars = horizon === 'short' ? 504 : 756;
            const signalOverlay = variant === 'mtf'
              ? context => {
                const frames = framesAt(
                  context.data,
                  context.index,
                  context.horizon,
                  item.sessions8h,
                  item.zone
                );
                const daily = context.data.slice(0, context.index + 1);
                const mtf = evaluateMtf(
                  frames.primary,
                  frames.higher,
                  context.horizon,
                  side,
                  daily,
                  supertrendParameters
                );
                return blendSignal(context.signal, mtf, side, 0.6);
              }
              : undefined;
            const bt = await backtestSignal(item.daily, horizon, dailyToWeeklyBars(item.daily), null, {
              symbol,
              market,
              side,
              windowBars,
              entryStep: 2,
              closedOnly: true,
              stopFirst: true,
              decisionPolicy: SCORE_POLICY,
              researchAngloScoreOnly: true,
              signalOverlay
            });
            if (!bt) continue;
            trades.push(...(bt.tradeResults || []).map(trade => ({ ...trade, symbol, market })));
            for (const [reason, count] of Object.entries(bt.rejectionCounts || {})) {
              rejectionCounts[reason] = (rejectionCounts[reason] || 0) + Number(count || 0);
            }
          }
          const metrics = summarize(trades);
          rows.push({
            market,
            horizon,
            side,
            variant,
            parameterKey: variant === 'baseline' ? 'original' : parameterKey,
            supertrendParameters: variant === 'baseline' ? null : supertrendParameters,
            metrics,
            rejectionCounts
          });
          console.log(`${market} ${horizon} ${side} ${variant} ${variant === 'baseline' ? 'original' : parameterKey}: n=${metrics.trades} WR=${metrics.winRate ?? '—'}% PnL=$${metrics.netPnlUsdAtFixedNotional} PF=${metrics.profitFactor ?? '—'}`);
          }
        }
      }
    }
  }

  const comparisons = [];
  const comparisonVariants = [
    { variant: 'baseline', parameterKey: 'original' },
    ...parameterSets.map(parameters => ({
      variant: 'mtf',
      parameterKey: `${parameters.period},${parameters.multiplier}`
    }))
  ];
  for (const horizon of ['short', 'medium', 'long']) {
    for (const side of ['buy', 'sell']) {
      if (requestedScopes && !requestedScopes.has(`${horizon}:${side}`)) continue;
      for (const candidate of comparisonVariants) {
        const selected = rows.filter(row =>
          row.horizon === horizon && row.side === side
          && row.variant === candidate.variant && row.parameterKey === candidate.parameterKey);
        const totalTrades = selected.reduce((sum, row) => sum + row.metrics.trades, 0);
        const pnl = selected.reduce((sum, row) => sum + row.metrics.netPnlUsdAtFixedNotional, 0);
        const weightedWin = totalTrades
          ? selected.reduce((sum, row) => sum + row.metrics.winRate * row.metrics.trades, 0) / totalTrades
          : null;
        comparisons.push({
          horizon,
          side,
          variant: candidate.variant,
          parameterKey: candidate.parameterKey,
          trades: totalTrades,
          winRate: weightedWin == null ? null : +weightedWin.toFixed(1),
          netPnlUsdAtFixedNotional: +pnl.toFixed(2),
          promotionEligible: false
        });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      markets: ['US', 'UK'],
      namesPerMarket: maxPerMarket,
      shortWindow: '2 years (hourly provider retention)',
      mediumLongWindow: '3 years',
      frames: {
        short: ['8H cash-session aggregation', '1D'],
        medium: ['1D', '3D'],
        long: ['3D', '1W']
      },
      mtfWeight: 0.4,
      baseSignalWeight: 0.6,
      profile,
      supertrendParameters: parameterSets,
      structureBarsPerFrame: 40,
      fibonacciRatios: [0.236, 0.382, 0.5, 0.618, 0.786],
      fibonacciUsage: 'support/resistance level construction only; no standalone directional points',
      priceMomentum: ['5-bar ROC', '20-bar ROC', '10-bar normalized slope', '5-bar ROC acceleration'],
      dailyHlc: ['close position in daily range', 'higher-high/higher-low or lower-high/lower-low', 'prior-5-day close breakout'],
      nextOpenEntry: true,
      stopFirst: true,
      costsAndBorrow: true,
      currentFundamentals: false,
      promotionEligible: false,
      limitations: [
        'Static current-name universe has survivorship bias',
        'US 8H cash-session bars are effectively one regular-session bar and highly correlated with 1D',
        'No point-in-time constituent, delisting, borrow-availability, or fundamental data'
      ]
    },
    testedSymbols: Object.fromEntries(Object.entries(UNIVERSES).map(([market, config]) => [
      market,
      selectedSymbols(config, cache)
    ])),
    rows,
    comparisons
  };
  const outName = profile === 'grid-targets'
    ? 'mtf-supertrend-parameter-grid-results.json'
    : profile === '144-targets'
      ? 'mtf-supertrend-14-4-targets-results.json'
      : 'mtf-supertrend-sr-fib-comparison-results.json';
  const out = path.join(__dirname, outName);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('Wrote ' + out);
  console.log(JSON.stringify(comparisons, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
