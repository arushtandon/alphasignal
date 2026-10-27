'use strict';

// Signals-only forward log. No orders, no backtest, not attached to the
// live loop. Review the two named crypto shorts on 2027-04-07.
const fs = require('fs');
const path = require('path');
const { sellSignalAt, simulateSellTrade, confirmedDowntrend } = require('../lib/research/regime-sell-hedge');

const ROOT = path.join(__dirname, '..');
const PRICE = path.join(ROOT, 'data', 'research', 'exit-amendment-prices');
const LOG = path.join(ROOT, 'data', 'research', 'crypto-sell-forward-log.jsonl');
const STATE = path.join(ROOT, 'data', 'research', 'crypto-sell-forward-state.json');
const REVIEW = '2027-04-07';
const UNIVERSE = ['BTC-USD', 'ETH-USD'];
const VARIANTS = [
  {
    id: 'SELL__Crypto__short__close_above_upper_bb20_2__none__sl2__t10__partial',
    trigger: 'close_above_upper_bb20_2',
    stopAtr: 2,
    timeStopBars: 10,
    partial: true,
  },
  {
    id: 'SELL__Crypto__short__williams_r10_gt_minus_5__none__sl2__t10__partial',
    trigger: 'williams_r10_gt_minus_5',
    stopAtr: 2,
    timeStopBars: 10,
    partial: true,
  },
];

function dateOf(bar) {
  const value = Number(bar?.t);
  if (!(value > 0)) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString().slice(0, 10);
}
function load(symbol) {
  const file = path.join(PRICE, `${symbol}.json`);
  const bars = JSON.parse(fs.readFileSync(file, 'utf8')).bars || [];
  return bars.filter(bar => dateOf(bar));
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (_) { return { open: [], logged: [] }; }
}

function main() {
  const benchmark = load('BTC-USD');
  const books = new Map(UNIVERSE.map(symbol => [symbol, load(symbol)]));
  const benchIndex = new Map(benchmark.map((bar, index) => [dateOf(bar), index]));
  const lastDate = dateOf(benchmark[benchmark.length - 1]);
  const state = readState();
  const seen = new Set(state.logged || []);
  const rows = [];
  if (!state.started) {
    rows.push({
      type: 'start',
      at: new Date().toISOString(),
      reviewAfter: REVIEW,
      note: 'Would-be trades only. No order is sent. History before this log is not scored.',
      variants: VARIANTS.map(row => row.id),
    });
    state.started = true;
  }
  for (const variant of VARIANTS) {
    for (const symbol of UNIVERSE) {
      const bars = books.get(symbol);
      const index = bars.length - 1;
      const date = dateOf(bars[index]);
      const benchAt = benchIndex.get(date);
      const signal = benchAt == null
        ? false
        : sellSignalAt(bars, index, variant, benchmark, benchAt);
      const key = `${variant.id}|${symbol}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const down = benchAt == null ? false : confirmedDowntrend(benchmark, benchAt);
      rows.push({
        type: 'daily',
        variant: variant.id,
        symbol,
        signalDate: date,
        benchmarkDate: lastDate,
        confirmedDowntrend: down,
        signal,
        entry: signal ? 'next session open' : null,
        orders: false,
      });
      if (signal && index + 1 < bars.length) {
        const trade = simulateSellTrade(bars, index, variant, { market: 'Crypto', symbol });
        if (trade) {
          rows.push({
            type: 'would-be-trade',
            variant: variant.id,
            symbol,
            signalDate: date,
            entryDate: dateOf(bars[trade.entryIndex]),
            exitDate: dateOf(bars[trade.exitIndex]),
            status: trade.status,
            ret: trade.ret,
            orders: false,
          });
        }
      }
    }
  }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (rows.length) fs.appendFileSync(LOG, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  state.logged = [...seen];
  state.lastRun = new Date().toISOString();
  state.reviewAfter = REVIEW;
  fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`logged ${rows.length} rows through ${lastDate}; review ${REVIEW}`);
}

main();
