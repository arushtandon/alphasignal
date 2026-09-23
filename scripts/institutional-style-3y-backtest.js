#!/usr/bin/env node
'use strict';

process.env.PORT = process.env.PORT || '3994';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-institutional-'));

const { fetchOHLCV } = require('../server');
const { applyCosts } = require('../lib/research/cost-model');
const { summarizeReturns } = require('../lib/research/performance');

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const windowBars = Math.max(504, Math.min(756, Number(args.window) || 756));
const maxPerMarket = Math.max(10, Number(args.perMarket) || 20);
const notional = Math.max(1000, Number(args.notional) || 10000);

const UNIVERSES = {
  US: [
    'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'MA',
    'UNH', 'HD', 'AVGO', 'LLY', 'XOM', 'CVX', 'COST', 'WMT', 'AMD', 'CRM',
    'ORCL', 'GS', 'BAC', 'MCD', 'QCOM', 'CAT', 'GE', 'DIS', 'NKE', 'SBUX'
  ],
  UK: [
    'AZN.L', 'SHEL.L', 'HSBA.L', 'ULVR.L', 'BP.L', 'GSK.L', 'REL.L', 'DGE.L',
    'BATS.L', 'RIO.L', 'LSEG.L', 'NG.L', 'RR.L', 'BA.L', 'LLOY.L', 'BARC.L',
    'VOD.L', 'PRU.L', 'GLEN.L', 'AAL.L', 'SGRO.L', 'III.L', 'EXPN.L', 'CPG.L'
  ]
};

// Fixed before seeing this sample. These are simplified, auditable versions of
// publicly documented institutional trend/momentum families, not replicas of
// any manager's proprietary production model.
const STRATEGIES = {
  short: {
    label: 'Fast 20-day breakout + 50-day trend',
    warmup: 60,
    maxHold: 20,
    stopAtr: 2,
    trailAtr: 2.5
  },
  medium: {
    label: '55-day breakout + 50/200 trend alignment',
    warmup: 220,
    maxHold: 63,
    stopAtr: 2.5,
    trailAtr: 3.5
  },
  long: {
    label: '12-1 time-series momentum + 200-day regime',
    warmup: 275,
    maxHold: 180,
    stopAtr: 4,
    trailAtr: 5
  }
};

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function sma(bars, index, length) {
  if (index - length + 1 < 0) return null;
  return mean(bars.slice(index - length + 1, index + 1).map(bar => number(bar.c)));
}

function trueRange(bars, index) {
  const bar = bars[index];
  if (!bar) return null;
  const high = number(bar.h);
  const low = number(bar.l);
  const prev = number(bars[index - 1] && bars[index - 1].c);
  if (high == null || low == null) return null;
  return prev == null ? high - low : Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
}

function atr(bars, index, length = 20) {
  if (index - length + 1 < 1) return null;
  return mean(Array.from({ length }, (_, offset) => trueRange(bars, index - offset)));
}

function priorExtreme(bars, index, length, field, mode) {
  const values = bars.slice(index - length, index)
    .map(bar => number(bar[field])).filter(Number.isFinite);
  if (!values.length) return null;
  return mode === 'max' ? Math.max(...values) : Math.min(...values);
}

function signalAt(bars, index, horizon, side) {
  const sell = side === 'sell';
  const close = number(bars[index] && bars[index].c);
  if (!(close > 0)) return false;
  if (horizon === 'short') {
    const level = priorExtreme(bars, index, 20, sell ? 'l' : 'h', sell ? 'min' : 'max');
    const ma50 = sma(bars, index, 50);
    return sell ? close < level && close < ma50 : close > level && close > ma50;
  }
  if (horizon === 'medium') {
    const level = priorExtreme(bars, index, 55, sell ? 'l' : 'h', sell ? 'min' : 'max');
    const ma50 = sma(bars, index, 50);
    const ma200 = sma(bars, index, 200);
    return sell
      ? close < level && ma50 < ma200 && close < ma200
      : close > level && ma50 > ma200 && close > ma200;
  }
  const start = number(bars[index - 252] && bars[index - 252].c);
  const skipMonth = number(bars[index - 21] && bars[index - 21].c);
  const ma200 = sma(bars, index, 200);
  if (!(start > 0) || !(skipMonth > 0) || !(ma200 > 0)) return false;
  const momentum12to1 = skipMonth / start - 1;
  return sell
    ? momentum12to1 < 0 && close < ma200
    : momentum12to1 > 0 && close > ma200;
}

function barTimeMs(bar) {
  const raw = Number(bar && bar.t);
  return raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : null;
}

function simulateTrendTrade(bars, entryIndex, side, horizon) {
  const spec = STRATEGIES[horizon];
  const sell = side === 'sell';
  const entry = number(bars[entryIndex] && bars[entryIndex].o)
    || number(bars[entryIndex - 1] && bars[entryIndex - 1].c);
  const entryAtr = atr(bars, entryIndex - 1);
  if (!(entry > 0) || !(entryAtr > 0)) return null;
  let stop = sell ? entry + spec.stopAtr * entryAtr : entry - spec.stopAtr * entryAtr;
  let favorable = entry;
  const end = Math.min(entryIndex + spec.maxHold, bars.length - 1);

  for (let index = entryIndex; index <= end; index++) {
    const bar = bars[index];
    const open = number(bar.o) || number(bar.c);
    const high = number(bar.h);
    const low = number(bar.l);
    const close = number(bar.c);
    if (high == null || low == null || close == null) continue;

    const stopped = sell ? high >= stop : low <= stop;
    if (stopped) {
      const fill = sell ? (open > stop ? open : stop) : (open < stop ? open : stop);
      return { entry, exit: fill, exitIndex: index, status: 'stop' };
    }

    const currentAtr = atr(bars, index) || entryAtr;
    favorable = sell ? Math.min(favorable, low) : Math.max(favorable, high);
    const candidate = sell
      ? favorable + spec.trailAtr * currentAtr
      : favorable - spec.trailAtr * currentAtr;
    stop = sell ? Math.min(stop, candidate) : Math.max(stop, candidate);

    // Institutional trend models also exit when the defining trend reverses.
    const maExit = horizon === 'short' ? sma(bars, index, 20)
      : horizon === 'medium' ? sma(bars, index, 50) : sma(bars, index, 200);
    if (maExit > 0 && (sell ? close > maExit : close < maExit)) {
      return { entry, exit: close, exitIndex: index, status: 'trend_exit' };
    }
  }
  const exit = number(bars[end] && bars[end].c) || entry;
  return { entry, exit, exitIndex: end, status: 'time_exit' };
}

function backtestOne(bars, symbol, market, horizon, side) {
  const spec = STRATEGIES[horizon];
  const start = Math.max(spec.warmup, bars.length - windowBars);
  const rows = [];
  let index = start;
  while (index < bars.length - 2) {
    if (!signalAt(bars, index, horizon, side)) {
      index++;
      continue;
    }
    const entryIndex = index + 1;
    const trade = simulateTrendTrade(bars, entryIndex, side, horizon);
    if (!trade) {
      index++;
      continue;
    }
    const gross = side === 'sell'
      ? (trade.entry - trade.exit) / trade.entry
      : (trade.exit - trade.entry) / trade.entry;
    const entryTs = barTimeMs(bars[entryIndex]);
    const exitTs = barTimeMs(bars[trade.exitIndex]);
    const heldDays = entryTs && exitTs ? Math.max(0, (exitTs - entryTs) / 86400000) : 0;
    const costed = applyCosts(gross, { symbol, market, side, holdDays: heldDays });
    rows.push({
      symbol,
      market,
      horizon,
      side,
      ret: costed.netReturn,
      grossRet: gross,
      costPct: costed.costPct,
      entryTs,
      exitTs,
      heldDays,
      status: trade.status
    });
    index = Math.max(index + 1, trade.exitIndex + 1);
  }
  return rows;
}

function summarize(rows) {
  const returns = summarizeReturns(rows.map(row => row.ret));
  const pnl = rows.reduce((sum, row) => sum + row.ret * notional, 0);
  return {
    trades: returns.trades,
    wins: rows.filter(row => row.ret > 0).length,
    losses: rows.filter(row => row.ret <= 0).length,
    winRate: returns.winRate,
    avgReturnPct: returns.avgReturnPct,
    profitFactor: returns.profitFactor,
    netPnlUsdAtFixedNotional: +pnl.toFixed(2),
    exploratoryScreenPass: returns.trades >= 30 && pnl > 0
      && returns.winRate >= 50 && returns.profitFactor >= 1.2,
    promotionEligible: false
  };
}

async function main() {
  const cache = new Map();
  for (const [market, universe] of Object.entries(UNIVERSES)) {
    for (const symbol of universe.slice(0, maxPerMarket)) {
      process.stdout.write(`Loading ${market} ${symbol}... `);
      const bars = await fetchOHLCV(symbol, '5y', '1d').catch(() => null);
      cache.set(symbol, Array.isArray(bars) && bars.length >= 300 ? bars : null);
      console.log(cache.get(symbol) ? bars.length + ' bars' : 'skipped');
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  const results = [];
  const allTrades = [];
  for (const [market, universe] of Object.entries(UNIVERSES)) {
    for (const horizon of Object.keys(STRATEGIES)) {
      for (const side of ['buy', 'sell']) {
        const rows = [];
        for (const symbol of universe.slice(0, maxPerMarket)) {
          const bars = cache.get(symbol);
          if (bars) rows.push(...backtestOne(bars, symbol, market, horizon, side));
        }
        allTrades.push(...rows);
        const metrics = summarize(rows);
        results.push({ market, horizon, side, strategy: STRATEGIES[horizon].label, metrics });
        console.log(`${market} ${horizon} ${side}: n=${metrics.trades} WR=${metrics.winRate ?? '—'}% PnL=$${metrics.netPnlUsdAtFixedNotional} PF=${metrics.profitFactor ?? '—'} screen=${metrics.exploratoryScreenPass}`);
      }
    }
  }

  const combined = [];
  for (const horizon of Object.keys(STRATEGIES)) {
    for (const side of ['buy', 'sell', 'both']) {
      const rows = allTrades.filter(row => row.horizon === horizon
        && (side === 'both' || row.side === side));
      combined.push({ horizon, side, strategy: STRATEGIES[horizon].label, metrics: summarize(rows) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      markets: ['US', 'UK'],
      equitiesPerMarket: maxPerMarket,
      windowBars,
      approximateYears: +(windowBars / 252).toFixed(1),
      nextOpenEntry: true,
      gapAwareStops: true,
      costsAndShortBorrow: true,
      fixedNotionalPerTrade: notional,
      currentFundamentals: false,
      parameterSelection: 'fixed before sample; no optimization',
      promotionEligible: false,
      limitations: [
        'Static current US/UK universe creates survivorship and constituent-selection bias',
        'Yahoo bars do not provide a verified point-in-time delisting/corporate-action dataset',
        'Fixed-notional trade sums are not a daily marked portfolio with overlapping capital',
        'No point-in-time fundamentals, borrow availability, or historical liquidity membership'
      ],
      requiredPromotionStudy: [
        'Point-in-time S&P 500 and FTSE 350 constituents including delisted names',
        'Daily portfolio accounting with overlapping positions and inverse-volatility weights',
        'Stationary-block-bootstrap confidence interval above zero',
        'Positive net performance in US, UK, long, and short legs separately'
      ]
    },
    strategies: STRATEGIES,
    results,
    combined
  };
  const out = path.join(__dirname, 'institutional-style-3y-backtest-results.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('Wrote ' + out);
  console.log(JSON.stringify(combined, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
