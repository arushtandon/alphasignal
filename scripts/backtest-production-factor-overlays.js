#!/usr/bin/env node
'use strict';

/**
 * Geography x horizon x side factor study on production-eligible signals.
 *
 * This runner does not alter live rules. It captures all opportunities admitted
 * by the production scoring/decision/bracket/exit path, then evaluates causal
 * confirmation overlays with candidate-specific non-overlap.
 */
process.env.PORT = process.env.PORT || '3994';
process.env.AUTH_TEST_BYPASS = '1';
process.env.RESEARCH_MODE = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.DATA_DIR = process.env.RESEARCH_DATA_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-production-overlay-'));

const {
  backtestSignal,
  buildMarketRegime,
  dailyToWeeklyBars,
  fetchOHLCV,
  sectorEtfForSymbol,
} = require('../server');
const { US_CORE, STATIC_GROUPS } = require('../universe');
const {
  dateKey,
  indexByDate,
  returnAt,
  buildCrossSectionalSnapshots,
  snapshotAt,
} = require('../lib/research/factor-snapshot');
const {
  aggregateByCount,
  aggregateByWeek,
  evaluateMtf,
} = require('../lib/research/mtf-supertrend');
const {
  CANDIDATES,
  optimizeCell,
  applyMultiplicity,
} = require('../lib/research/production-overlay-study');
const {
  buildDateAlignedFolds,
  assertFoldIsolation,
} = require('../lib/research/walk-forward-optimizer');

const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--')).map(raw => {
  const [key, value] = raw.slice(2).split('=');
  return [key, value == null ? '1' : value];
}));
const PER_MARKET = Math.max(5, Number(args.perMarket) || 80);
const RANGE = String(args.range || '10y');
const NOTIONAL = Math.max(1000, Number(args.notional) || 10000);
const OUTPUT = String(args.output || 'backtest-production-factor-overlays-results.json');
const FOLDS = 4;
const TRAIN_BARS = Math.max(378, Number(args.trainBars) || 504);
const VALIDATION_BARS = Math.max(63, Number(args.validationBars) || 126);
const TEST_BARS = Math.max(63, Number(args.testBars) || 126);
const HORIZON_EMBARGO = { short: 20, medium: 63, long: 180 };
const MTF_PARAMS = {
  short: { period: 7, multiplier: 2 },
  medium: { period: 10, multiplier: 3 },
  long: { period: 14, multiplier: 4 },
};

const US_EXTRA = [
  'PFE','BMY','AMGN','MDLZ','CL','MO','PM','LOW','TJX','HON','UPS','RTX','LMT','DE',
  'MMM','UNP','SHW','FCX','NEM','NUE','NEE','DUK','SO','D','AEP','PLD','AMT','EQIX',
  'SPG','CVS','CI','MDT','SYK','ZTS','ADP','CB','MMC','ICE','CME','SCHW','AXP','BLK',
];
const UNIVERSES = {
  US: [...new Set([...US_CORE, ...US_EXTRA])],
  HK: [...new Set(STATIC_GROUPS.HSI)],
  Japan: [...new Set(STATIC_GROUPS.NIKKEI225)],
  UK: [...new Set(STATIC_GROUPS.FTSE100)],
  Germany: [...new Set(STATIC_GROUPS.DAX)],
  France: [...new Set(STATIC_GROUPS.CAC40)],
  Commodities: [...new Set(STATIC_GROUPS.COMMODITIES)],
};
const MARKETS = Object.keys(UNIVERSES);
const INDEX = {
  US: 'SPY',
  HK: 'EWH',
  Japan: 'EWJ',
  UK: 'EWU',
  Germany: 'EWG',
  France: 'EWQ',
  Commodities: 'DBC',
};
const PROXY_SYMBOLS = [...new Set([
  ...Object.values(INDEX), 'USO', 'BNO', 'CL=F', 'BZ=F',
])];

function alignedIndex(context, proxy, index) {
  if (!proxy?.bars) return null;
  return proxy.index.get(dateKey(context.bars[index])) ?? null;
}

function alignedReturn(context, proxy, index, lookback = 20) {
  const cursor = alignedIndex(context, proxy, index);
  return cursor == null ? null : returnAt(proxy.bars, cursor, lookback);
}

function directional(value, sell) {
  return Number.isFinite(value) && (sell ? value < 0 : value > 0);
}

function framesAt(bars, index, horizon) {
  const daily = bars.slice(0, index + 1);
  if (horizon === 'short') {
    // A Yahoo daily OHLC bar is one 6.5-hour cash session, used as the causal
    // 8H cash-session frame; the higher frame is the corresponding 1D series.
    return { primary: daily, higher: daily, daily };
  }
  if (horizon === 'medium') {
    return { primary: daily, higher: aggregateByCount(daily, 3), daily };
  }
  return {
    primary: aggregateByCount(daily, 3),
    higher: aggregateByWeek(daily),
    daily,
  };
}

function featureSnapshot(context, signalIndex, side, horizon, crossSectional, proxies) {
  const point = snapshotAt(context, signalIndex, side, horizon, crossSectional, proxies, {
    execution: {
      minDollarVolume: context.market === 'US' ? 5e7
        : context.market === 'Commodities' ? 5e6
          : context.market === 'HK' || context.market === 'Japan' ? 1e8 : 1e7,
      maxGapAtr: 1,
      maxSpreadProxy: 0.08,
    },
  });
  const sell = side === 'sell';
  const marketProxy = proxies.get(INDEX[context.market]);
  const sectorProxy = context.sectorProxy || marketProxy;
  const stock20 = returnAt(context.bars, signalIndex, 20);
  const market20 = alignedReturn(context, marketProxy, signalIndex, 20);
  const sector20 = alignedReturn(context, sectorProxy, signalIndex, 20);
  const max20 = horizon === 'short' ? 0.06 : horizon === 'medium' ? 0.10 : 0.20;
  const max50 = horizon === 'short' ? 0.10 : horizon === 'medium' ? 0.15 : 0.25;
  const frames = framesAt(context.bars, signalIndex, horizon);
  const mtf = evaluateMtf(
    frames.primary,
    frames.higher,
    horizon,
    side,
    frames.daily,
    MTF_PARAMS[horizon],
  );
  return {
    rsPercentile: point.rsPercentile,
    mtf: Boolean(mtf?.dualSupertrend && mtf.score >= 55),
    mtfScore: mtf?.score ?? null,
    alignment: directional(stock20, sell)
      && directional(market20, sell)
      && directional(sector20, sell),
    breadth: sell
      ? point.breadth50 <= 0.45 && point.breadth200 <= 0.50
      : point.breadth50 >= 0.55 && point.breadth200 >= 0.50,
    adxVol: point.adx != null && point.atrPercentile != null
      && (horizon === 'short' ? point.adx >= 15 && point.adx <= 40 : point.adx >= 20)
      && point.atrPercentile >= 0.15 && point.atrPercentile <= 0.90,
    retest: point.retest.pass,
    maDistance: Number.isFinite(point.ma20Distance)
      && Number.isFinite(point.ma50Distance)
      && Math.abs(point.ma20Distance) <= max20
      && Math.abs(point.ma50Distance) <= max50,
    execution: point.execution.pass,
    commodity: point.commodity.pass,
    diagnostics: {
      market20,
      sector20,
      stock20,
      breadth50: point.breadth50,
      breadth200: point.breadth200,
      adx: point.adx,
      atrPercentile: point.atrPercentile,
    },
  };
}

function resultEvent(context, trade, horizon, crossSectional, proxies) {
  return {
    symbol: context.symbol,
    market: context.market,
    horizon,
    side: trade.side,
    signalIndex: trade.signalIndex,
    signalDate: dateKey(context.bars[trade.signalIndex]),
    entryDate: new Date(trade.entryTs).toISOString().slice(0, 10),
    exitDate: new Date(trade.exitTs).toISOString().slice(0, 10),
    entryTs: trade.entryTs,
    exitTs: trade.exitTs,
    ret: trade.ret,
    grossRet: trade.grossRet,
    status: trade.status,
    production: {
      buyScore: trade.buyScore,
      sellScore: trade.sellScore,
      rating: trade.candidateRating,
    },
    features: featureSnapshot(
      context,
      trade.signalIndex,
      trade.side,
      horizon,
      crossSectional,
      proxies,
    ),
  };
}

async function mapLimit(values, limit, operation) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

function metricsDelta(candidate, baseline) {
  return {
    winRatePctPoints: candidate.winRate == null || baseline.winRate == null
      ? null : +(candidate.winRate - baseline.winRate).toFixed(1),
    pnlUsd: +(candidate.pnlUsd - baseline.pnlUsd).toFixed(2),
    trades: candidate.trades - baseline.trades,
    profitFactor: candidate.profitFactor == null || baseline.profitFactor == null
      ? null : +(candidate.profitFactor - baseline.profitFactor).toFixed(3),
  };
}

async function main() {
  const rawCache = new Map();
  async function load(symbol) {
    if (!rawCache.has(symbol)) {
      rawCache.set(symbol, fetchOHLCV(symbol, RANGE, '1d').catch(() => null));
    }
    return rawCache.get(symbol);
  }

  const proxies = new Map();
  const loadedProxies = await mapLimit(PROXY_SYMBOLS, 5, async symbol => {
    const bars = await load(symbol);
    return [symbol, Array.isArray(bars) ? { bars, index: indexByDate(bars) } : null];
  });
  loadedProxies.forEach(([symbol, proxy]) => {
    if (proxy) proxies.set(symbol, proxy);
  });

  const contexts = Object.fromEntries(MARKETS.map(market => [market, []]));
  for (const market of MARKETS) {
    for (let start = 0; start < UNIVERSES[market].length
      && contexts[market].length < PER_MARKET; start += 5) {
      const batch = UNIVERSES[market].slice(start, start + 5);
      const loaded = await mapLimit(batch, 5, async symbol => {
        process.stdout.write(`\rLoading ${market} ${symbol}`.padEnd(58));
        const bars = await load(symbol);
        if (!Array.isArray(bars) || bars.length < 1500) return null;
        const sectorSymbol = sectorEtfForSymbol(symbol);
        const sectorBars = await load(sectorSymbol);
        return {
          market,
          symbol,
          bars,
          sectorSymbol,
          sectorProxy: Array.isArray(sectorBars)
            ? { bars: sectorBars, index: indexByDate(sectorBars) }
            : proxies.get(INDEX[market]),
        };
      });
      contexts[market].push(...loaded.filter(Boolean));
    }
    contexts[market] = contexts[market].slice(0, PER_MARKET);
  }
  console.log(`\nLoaded ${MARKETS.map(market => `${market}=${contexts[market].length}`).join(', ')}`);

  const cells = [];
  for (const market of MARKETS) {
    const marketContexts = contexts[market];
    const benchmark = proxies.get(INDEX[market]);
    if (!marketContexts.length || !benchmark) continue;
    const crossSectional = buildCrossSectionalSnapshots(marketContexts);
    const marketSeries = buildMarketRegime(benchmark.bars);
    const eventsByHorizon = { short: [], medium: [], long: [] };

    for (const [contextIndex, context] of marketContexts.entries()) {
      for (const horizon of ['short', 'medium', 'long']) {
        process.stdout.write(
          `\rReplaying ${market} ${contextIndex + 1}/${marketContexts.length} ${horizon}`.padEnd(70),
        );
        const replay = await backtestSignal(
          context.bars,
          horizon,
          dailyToWeeklyBars(context.bars),
          null,
          {
            symbol: context.symbol,
            market,
            marketSeries,
            windowBars: context.bars.length,
            entryStep: 2,
            allowOverlapping: true,
            closedOnly: true,
            stopFirst: true,
          },
        );
        for (const trade of replay?.tradeResults || []) {
          eventsByHorizon[horizon].push(
            resultEvent(context, trade, horizon, crossSectional, proxies),
          );
        }
      }
    }

    for (const horizon of ['short', 'medium', 'long']) {
      const timeline = benchmark.bars.map(dateKey).filter(Boolean);
      const folds = buildDateAlignedFolds(timeline, {
        folds: FOLDS,
        trainBars: TRAIN_BARS,
        validationBars: VALIDATION_BARS,
        testBars: TEST_BARS,
        embargoBars: HORIZON_EMBARGO[horizon],
      });
      if (folds.length !== FOLDS) continue;
      assertFoldIsolation(folds);
      for (const side of ['buy', 'sell']) {
        const events = eventsByHorizon[horizon].filter(event => event.side === side);
        const result = optimizeCell(events, folds, { market, notional: NOTIONAL });
        cells.push({
          market,
          horizon,
          side,
          eventOpportunities: events.length,
          ...result,
          developmentDelta: metricsDelta(result.development, result.baselineDevelopment),
          holdoutDelta: metricsDelta(result.holdout, result.baselineHoldout),
        });
      }
    }
  }
  console.log('');
  applyMultiplicity(cells);

  const report = {
    generatedAt: new Date().toISOString(),
    study: 'production-factor-overlays-v1',
    methodology: {
      productionBaseline: 'server.backtestSignal + computeQuantSignal + canonical decision/levels/hybrid exit',
      markets: MARKETS,
      loadedPerMarket: Object.fromEntries(MARKETS.map(market => [market, contexts[market].length])),
      requestedPerMarket: PER_MARKET,
      range: RANGE,
      folds: FOLDS,
      trainBars: TRAIN_BARS,
      validationBars: VALIDATION_BARS,
      testBars: TEST_BARS,
      horizonEmbargoBars: HORIZON_EMBARGO,
      nextOpen: true,
      productionHybridExit: true,
      productionTpSlUnchanged: true,
      costsAndBorrow: true,
      pointInTimeFundamentals: false,
      currentFundamentalsUsed: false,
      shortPrimaryFrame: 'daily OHLC cash-session proxy for 8H',
      minProfitFactor: 1.3,
      minDevelopmentTrades: 30,
      minHoldoutTrades: 30,
      winRateTargetPct: [65, 70],
      promotionRule: 'strictly improves both win rate and PnL in development OOS and untouched holdout',
    },
    candidates: CANDIDATES,
    cells,
  };
  const outputPath = path.join(__dirname, OUTPUT);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${outputPath}`);
  for (const cell of cells) {
    const baseline = cell.baselineHoldout;
    const improved = cell.holdout;
    console.log(
      `${cell.market.padEnd(11)} ${cell.horizon.padEnd(6)} ${cell.side.padEnd(4)} `
      + `${cell.frozenModel.padEnd(22)} `
      + `base n=${String(baseline.trades).padStart(3)} WR=${String(baseline.winRate ?? '—').padStart(5)} `
      + `PnL=$${String(baseline.pnlUsd).padStart(9)} | `
      + `new n=${String(improved.trades).padStart(3)} WR=${String(improved.winRate ?? '—').padStart(5)} `
      + `PnL=$${String(improved.pnlUsd).padStart(9)} ${cell.status}`,
    );
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
