'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { selectMediumK1 } = require('../lib/strategy/danelfin-forward');
const BACKTEST = path.join(__dirname, '..', 'data', 'run-u1-backtest.js');

const ROOT = path.join(__dirname, '..', 'data', 'research');
const DATES = ['2024-11-01', '2025-08-15', '2026-05-22'];
const EXPECTED = { '2024-11-01': 'EME', '2025-08-15': 'ESLT', '2026-05-22': 'CGAU' };

function yahoo(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\./g, '-');
}

function lastIndex(dates, date) {
  let found = -1;
  for (let index = 0; index < dates.length; index += 1) {
    if (dates[index] <= date) found = index;
    else break;
  }
  return found;
}

function rowsFor(date) {
  const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'danelfin-history', 'lists.json'), 'utf8'));
  const list = saved.lists.find(row => row.date === date && row.ok === true);
  const names = [...new Set((list.names || []).map(yahoo))];
  const rows = [];
  for (const ticker of names) {
    const file = path.join(ROOT, 'fmp-ai10', `${ticker}.json`);
    if (!fs.existsSync(file)) continue;
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bars = book.bars || [];
    const dates = bars.map(bar => bar.date);
    const index = lastIndex(dates, date);
    if (index < 0 || index + 1 >= bars.length) continue;
    const gap = Math.round((Date.parse(date) - Date.parse(dates[index])) / 86400000);
    if (gap > 5) continue;
    const close = bars[index].c;
    const caps = book.mcap || [];
    const capIndex = lastIndex(caps.map(row => row.date), date);
    const capGap = capIndex < 0 ? 99 : Math.round((Date.parse(date) - Date.parse(caps[capIndex].date)) / 86400000);
    const cap = capGap <= 5 ? caps[capIndex].marketCap : null;
    if (index < 19) continue;
    let total = 0;
    let ok = true;
    for (let i = index - 19; i <= index; i += 1) {
      if (!(bars[i].c > 0) || !(bars[i].v > 0)) ok = false;
      total += bars[i].c * bars[i].v;
    }
    const adv = ok ? total / 20 : null;
    if (!(close >= 5) || !(cap >= 2e9) || !(adv >= 20e6)) continue;
    const year = index >= 252 ? bars[index - 252].c : null;
    const month = index >= 21 ? bars[index - 21].c : null;
    rows.push({
      ticker,
      ai: 10,
      close,
      marketCap: cap,
      dollarAdv: adv,
      ret12: year > 0 && month > 0 ? month / year - 1 : null,
      tradable: true,
    });
  }
  return rows;
}

test('live medium selector matches the U2 Danelfin k=1 backtest on three stored Fridays', () => {
  if (!fs.existsSync(BACKTEST) || !fs.existsSync(path.join(ROOT, 'danelfin-history', 'lists.json'))) {
    return;
  }
  const { select } = require(BACKTEST);
  for (const date of DATES) {
    const rows = rowsFor(date);
    const backtest = select(rows, 1)[0];
    const live = selectMediumK1(rows, []);
    assert.equal(live.ticker, backtest.ticker, date);
    assert.equal(live.ticker, EXPECTED[date], date);
    const nextBacktest = select(rows.filter(row => row.ticker !== live.ticker), 1)[0];
    const nextLive = selectMediumK1(rows, [live.ticker]);
    assert.equal(nextLive.ticker, nextBacktest.ticker, `${date} held`);
  }
});
