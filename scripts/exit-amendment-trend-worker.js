#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = '0';

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const {
  backtestSignal, buildMarketRegime, dailyToWeeklyBars, fetchOHLCV,
  sectorEtfForSymbol, simulateHybridExit,
} = require('../server');
const { scoreAtDecision } = require('../lib/research/pit-quality');
const { applyCosts } = require('../lib/research/cost-model');
const { positionSize } = require('../lib/research/exit-amendment');

const ROOT = process.cwd();
const PRICE_CACHE = path.join(ROOT, 'data', 'research', 'exit-amendment-prices');
const LISTING = {
  US: { currency: 'USD', scale: 1 },
  Japan: { currency: 'JPY', scale: 1 },
  'Hong Kong': { currency: 'HKD', scale: 1 },
  UK: { currency: 'GBP', scale: 0.01 },
  Germany: { currency: 'EUR', scale: 1 },
  France: { currency: 'EUR', scale: 1 },
  India: { currency: 'INR', scale: 1 },
  Commodities: { currency: 'USD', scale: 1 },
};

function dateOf(bar) {
  const value = Number(bar?.t);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const fxCache = new Map();
function fxAt(currency, date) {
  if (!currency || currency === 'USD') return 1;
  if (!fxCache.has(currency)) {
    const names = { GBP: 'GBPUSD_X', EUR: 'EURUSD_X', HKD: 'HKDUSD_X', JPY: 'JPYUSD_X', INR: 'INRUSD_X' };
    const file = names[currency] && path.join(ROOT, 'data', 'research', 'fx', `${names[currency]}.json`);
    const bars = file && fs.existsSync(file) ? readJson(file).bars || [] : [];
    fxCache.set(currency, new Map(bars.map(bar => [dateOf(bar), Number(bar.c)])));
  }
  const value = fxCache.get(currency).get(date);
  return value > 0 ? value : 1;
}
async function loadPrice(symbol) {
  const safe = `${symbol}`.replace(/[^\w.=-]/g, '_');
  const file = path.join(PRICE_CACHE, `${safe}.json`);
  if (fs.existsSync(file)) {
    const cached = readJson(file);
    if (Array.isArray(cached) && cached.length >= 250) return cached;
  }
  const bars = await fetchOHLCV(symbol, '10y', '1d');
  if (Array.isArray(bars) && bars.length >= 15) {
    fs.mkdirSync(PRICE_CACHE, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bars));
  }
  return bars;
}
function providerFor(context, market) {
  const listing = LISTING[market];
  if (!listing || !context.arrays) return null;
  return ({ bar }) => {
    const quality = scoreAtDecision(context.arrays, {
      market,
      decisionDate: dateOf(bar),
      close: bar.c,
      listingCurrency: listing.currency,
      listingPriceScale: listing.scale,
      fxAt,
    });
    return { fmp: quality.usable ? quality : null };
  };
}

async function run(task) {
  const context = task.file ? readJson(task.file).result.context : {
    symbol: task.symbol,
    bars: await loadPrice(task.symbol),
    arrays: null,
  };
  if (!context?.bars || context.bars.length < 300) return [];
  const benchmarkBars = context.benchmarkBars || await loadPrice(task.benchmark);
  const sectorSymbol = sectorEtfForSymbol(context.symbol);
  const sectorBars = !sectorSymbol || sectorSymbol === task.benchmark
    ? benchmarkBars
    : (await loadPrice(sectorSymbol)) || benchmarkBars;
  const provider = providerFor(context, task.market);
  const weekly = dailyToWeeklyBars(context.bars);
  const result = await backtestSignal(context.bars, task.horizon, weekly, null, {
    symbol: context.symbol,
    market: task.market,
    marketSeries: buildMarketRegime(sectorBars),
    windowBars: context.bars.length,
    entryStep: 2,
    allowOverlapping: true,
    closedOnly: true,
    stopFirst: true,
    ...(provider ? { fundamentalsAt: provider } : {}),
  });
  const trades = [];
  for (const row of result?.tradeResults || []) {
    if (row.side !== 'buy') continue;
    const entryDate = dateOf(context.bars[row.entryIndex]);
    const entry = Number(context.bars[row.entryIndex]?.o);
    const sized = positionSize({
      symbol: context.symbol,
      market: task.market,
      price: entry,
      fx: fxAt(LISTING[task.market]?.currency, entryDate),
    });
    const amended = await simulateHybridExit(
      context.bars,
      row.entryIndex,
      entry,
      task.horizon,
      false,
      weekly,
      null,
      null,
      false,
      sized?.oneLot ? 0 : 0.5,
      {
        disablePreTp1SignalExit: true,
        stopFirst: true,
        researchExitVariant: { timeBars: context.bars.length + 5 },
      },
    );
    const closed = amended && amended.status !== 'open' && amended.status !== 'tp1_open';
    const holdBars = closed ? Math.max(0, amended.exitIdx - row.entryIndex) : null;
    const net = closed ? applyCosts(amended.ret, {
      market: task.market,
      symbol: context.symbol,
      side: 'buy',
      holdDays: holdBars,
    }) : null;
    trades.push({
      symbol: context.symbol,
      signalDate: dateOf(context.bars[row.signalIndex]),
      entryDate,
      exitDate: dateOf(context.bars[row.exitIndex]),
      ret: row.ret,
      holdBars: Math.max(0, row.exitIndex - row.entryIndex),
      status: row.status,
      oneLot: sized?.oneLot === true,
      variant: closed ? {
        exitDate: dateOf(context.bars[amended.exitIdx]),
        ret: net.netReturn,
        holdBars,
        status: amended.status,
        closed: true,
      } : { closed: false, status: amended?.status || 'open' },
    });
  }
  return trades;
}

process.on('message', async message => {
  if (message?.type === 'shutdown') process.exit(0);
  if (message?.type !== 'task') return;
  try {
    process.send?.({ type: 'result', taskId: message.taskId, output: await run(message.task) });
  } catch (error) {
    process.send?.({ type: 'error', taskId: message.taskId, error: error.stack || String(error) });
  }
});
process.send?.({ type: 'ready' });
