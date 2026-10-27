#!/usr/bin/env node
'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = process.env.PORT || '0';

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { backtestSignal, buildMarketRegime, dailyToWeeklyBars } = require('../server');
const { scoreAtDecision } = require('../lib/research/pit-quality');

const ROOT = process.cwd();
const LISTING = {
  US: { currency: 'USD', scale: 1 },
  Japan: { currency: 'JPY', scale: 1 },
  'Hong Kong': { currency: 'HKD', scale: 1 },
  UK: { currency: 'GBP', scale: 0.01 },
  Germany: { currency: 'EUR', scale: 1 },
  France: { currency: 'EUR', scale: 1 },
};

function dateOf(bar) {
  const value = Number(bar?.t);
  return value ? new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10) : null;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fxAt(currency, date) {
  if (currency === 'USD') return 1;
  const names = { GBP: 'GBPUSD_X', EUR: 'EURUSD_X', HKD: 'HKDUSD_X', JPY: 'JPYUSD_X' };
  const file = names[currency] && path.join(ROOT, 'data', 'research', 'fx', `${names[currency]}.json`);
  if (!file || !fs.existsSync(file)) return null;
  const cached = readJson(file);
  const row = (cached.bars || []).find(bar => dateOf(bar) === date);
  return Number(row?.c) > 0 ? Number(row.c) : null;
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
function normalize(row, context) {
  return {
    ...row,
    symbol: context.symbol,
    market: context.market,
    signalDate: dateOf(context.bars[row.signalIndex]),
    entryDate: dateOf(context.bars[row.entryIndex]),
    exitDate: dateOf(context.bars[row.exitIndex]),
  };
}
async function run(task) {
  const { context, sectorBars, variants } = task;
  const provider = providerFor(context, context.market);
  const series = {
    off: buildMarketRegime(context.benchmarkBars),
    on: buildMarketRegime(sectorBars),
  };
  const output = {};
  for (const variant of variants) {
    const result = await backtestSignal(
      context.bars,
      variant.horizon,
      dailyToWeeklyBars(context.bars),
      null,
      {
        symbol: context.symbol,
        market: context.market,
        marketSeries: series[variant.sector ? 'on' : 'off'],
        windowBars: context.bars.length,
        entryStep: 2,
        allowOverlapping: true,
        closedOnly: true,
        stopFirst: true,
        ...(provider ? { fundamentalsAt: provider } : {}),
      },
    );
    output[variant.id] = (result?.tradeResults || [])
      .filter(row => row.side === 'buy')
      .map(row => normalize(row, context));
  }
  return output;
}

process.on('message', async message => {
  if (message?.type === 'shutdown') {
    process.exit(0);
    return;
  }
  if (message?.type !== 'task') return;
  try {
    const output = await run(message.task);
    process.send?.({ type: 'result', taskId: message.taskId, output });
  } catch (error) {
    process.send?.({ type: 'error', taskId: message.taskId, error: error.stack || String(error) });
  }
});
process.send?.({ type: 'ready' });
