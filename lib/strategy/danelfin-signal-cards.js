'use strict';

const { sma, atr, williamsR } = require('../research/mean-reversion');
const { marketOf } = require('./ticker-view');

function rowFromBars(bars, extras = {}) {
  if (!Array.isArray(bars) || bars.length < 200) return { hasPrice: false };
  const index = bars.length - 1;
  const close = Number(bars[index].c);
  const ma200 = sma(bars, index, 200);
  const ma200Prev = sma(bars, index - 21, 200);
  const monthAgo = index >= 21 ? Number(bars[index - 21].c) : null;
  const yearAgo = index >= 252 ? Number(bars[index - 252].c) : null;
  return {
    hasPrice: close > 0,
    ai: 10,
    close,
    ma200,
    ma200Rising: ma200 != null && ma200Prev != null && ma200 > ma200Prev,
    williams: williamsR(bars, index, 10),
    volOk: extras.volOk === true,
    ret12_1: monthAgo > 0 && yearAgo > 0 ? monthAgo / yearAgo - 1 : null,
    engineMedium: extras.engineMedium,
    rsTop30: extras.rsTop30 === true,
    atr: atr(bars, index, 14),
    piotroski: extras.piotroski,
  };
}

const BOOKS = [
  {
    id: 'S-BUY',
    horizon: 'short',
    side: 'buy',
    test(row) {
      return row.ai === 10 && row.williams != null && row.williams < -95 && row.close > row.ma200 && row.volOk === true;
    },
  },
  {
    id: 'M-BUY',
    horizon: 'medium',
    side: 'buy',
    test(row) {
      return row.ai === 10 && row.close > row.ma200 && row.ma200Rising === true && row.ret12_1 > 0 && (row.engineMedium >= 62 || row.rsTop30 === true);
    },
  },
  {
    id: 'L-BUY',
    horizon: 'long',
    side: 'buy',
    test(row) {
      return row.ai === 10 && Number(row.piotroski) >= 6 && row.ret12_1 > 0;
    },
  },
];

function reasonsFor(book, row) {
  if (book.id === 'S-BUY') return ['AI 10', 'Williams %R(10) < -95', 'close > MA200', 'vol filter'];
  if (book.id === 'M-BUY') {
    return ['AI 10', 'close > MA200', 'MA200 rising', '12-1 > 0', row.engineMedium >= 62 ? 'engine medium >= 62' : '6m RS top 30%'];
  }
  return ['AI 10', 'Piotroski >= 6', '12-1 > 0'];
}

function informationalLevels(row) {
  const entry = Number(row.close);
  const atr = Number(row.atr);
  if (!(entry > 0) || !(atr > 0)) return { entry: null, stop: null, target: null };
  return {
    entry,
    stop: Math.round((entry - 2.5 * atr) * 100) / 100,
    target: Math.round((entry + atr) * 100) / 100,
  };
}

function buildWatchCards(input) {
  const cards = [];
  const missingPrice = [];
  const reused = new Set(input.reusedTickers || []);
  for (const name of input.names || []) {
    const ticker = String(name).toUpperCase();
    const row = (input.rows && input.rows[ticker]) || null;
    const inU1 = input.u1 && input.u1.has(ticker);
    const liquid = input.u2 && input.u2[ticker];
    const inU2 = liquid && liquid.pass === true;
    if (!row || row.hasPrice === false) {
      if (inU1 || liquid) missingPrice.push({ ticker, universe: inU1 ? 'U1' : 'U2' });
      continue;
    }
    if (!inU1 && !inU2) continue;
    for (const book of BOOKS) {
      if (!book.test(row)) continue;
      const levels = informationalLevels(row);
      cards.push({
        ticker,
        horizon: book.horizon,
        side: book.side,
        book: book.id,
        ai: 10,
        universes: [inU1 ? 'U1' : null, inU2 ? 'U2' : null].filter(Boolean),
        reasons: reasonsFor(book, row),
        entry: levels.entry,
        stop: levels.stop,
        target: levels.target,
        reusedTicker: reused.has(ticker),
        label: 'Danelfin + AlphaSignal — not validated',
        orders: false,
      });
    }
  }
  return { cards, missingPrice, orders: false };
}

function dueForLiveRanking(now, storedDates) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const minutes = Number(value('hour')) * 60 + Number(value('minute'));
  const weekday = value('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return { due: false, date };
  if (minutes < 16 * 60 + 10) return { due: false, date };
  if (storedDates && storedDates.has(date)) return { due: false, date };
  return { due: true, date };
}

module.exports = { buildWatchCards, dueForLiveRanking, rowFromBars, marketOf };
