'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { futuresDueForRoll, planFuturesRoll } = require('../lib/ibkr/futures-roll');

const bzOct = {
  secType: 'FUT',
  lastTradeDateOrContractMonth: '20260828 14:30:00 US/Eastern',
  localSymbol: 'BZV6',
  conId: 339981281
};

test('October Brent is due to roll on and after last trade day', () => {
  assert.equal(futuresDueForRoll(bzOct, new Date('2026-08-27T12:00:00Z')), false);
  assert.equal(futuresDueForRoll(bzOct, new Date('2026-08-28T12:00:00Z')), true);
  assert.equal(futuresDueForRoll(bzOct, new Date('2026-08-31T06:00:00Z')), true);
  assert.equal(futuresDueForRoll({ secType: 'STK' }, new Date('2026-08-31T06:00:00Z')), false);
});

test('BZ roll keeps rec percentages off the new front fill', () => {
  const planned = planFuturesRoll({
    entry: 86.56, tp1Px: 91.85, originalSl: 81.86, tp2Px: 94.20
  }, 89.31);
  assert.ok(planned);
  assert.equal(+planned.tp1.toFixed(2), 94.77);
  assert.equal(+planned.sl.toFixed(2), 84.46);
  assert.equal(+planned.tp2.toFixed(2), 97.19);
  const tp1Pct = (91.85 - 86.56) / 86.56;
  assert.equal(+((planned.tp1 - 89.31) / 89.31).toFixed(6), +tp1Pct.toFixed(6));
});

test('roll settle + opener restore onto the model key so Oct PnL is not Error', () => {
  const { rebuildFuturesRollFills } = require('../lib/ibkr/futures-roll');
  const { fifoLotEconomics } = require('../lib/ibkr/fifo-lots');
  const live = 'BZ=F|short|Thu Aug 27 2026';
  const err = live + '|cursor-err';
  const { rows, changed } = rebuildFuturesRollFills([
    { key: live, role: 'entry', qty: 1, price: 91.25, recon: 'futures-roll',
      execId: '0000e1a7.6a971cd6.01.01', time: '2026-08-31T10:05:30.255Z', ticker: 'BZ=F', side: 'buy' },
    { key: err, role: 'entry', qty: 1, price: 87.442, recon: 'qty-pad', errorTrade: true,
      execId: 'recon-entry-' + live + '-p', time: '2026-08-27T00:00:00.000Z', ticker: 'BZ=F', side: 'buy' },
    { key: err, role: 'entry', qty: 1, price: 91.25236, recon: 'avg-correct', errorTrade: true,
      execId: '0000e1a7.6a939e15.01.01', time: '2026-08-27T04:47:34.990Z', ticker: 'BZ=F', side: 'buy' },
    { key: err, role: 'flatten', qty: 1, price: 87.07, recon: 'bridge-missed-exit', errorTrade: true,
      execId: 'synth-' + live + '-x', time: '2026-08-27T04:47:39.134Z', ticker: 'BZ=F', side: 'buy' },
    { key: err, role: 'flatten', qty: 1, price: 88.9598, recon: 'futures-roll', errorTrade: true,
      execId: 'roll-settle-' + live + '-339981281', time: '2026-08-31T10:05:29.179Z', ticker: 'BZ=F', side: 'buy' }
  ], { officialSettlePx: () => 89.31 });
  assert.equal(changed, 1);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.key === live && r.errorTrade === false));
  const fifo = fifoLotEconomics(rows, { dir: 1, futMult: 1000 });
  assert.equal(fifo.openQty, 1);
  assert.equal(+fifo.avgEntry.toFixed(2), 91.25);
  assert.equal(+fifo.realizedLocal.toFixed(2), 1868);
});

test('mint official settle flatten when roll-settle never landed, restore opener from priceCorrectedFrom', () => {
  const { rebuildFuturesRollFills } = require('../lib/ibkr/futures-roll');
  const { fifoLotEconomics } = require('../lib/ibkr/fifo-lots');
  const live = 'BZ=F|short|Thu Aug 27 2026';
  const err = live + '|cursor-err';
  const { rows, changed } = rebuildFuturesRollFills([
    { key: live, role: 'entry', qty: 1, price: 91.25, recon: 'futures-roll',
      execId: '0000e1a7.6a971cd6.01.01', time: '2026-08-31T10:05:30.255Z', ticker: 'BZ=F', side: 'buy' },
    { key: err, role: 'entry', qty: 1, price: 91.25236, recon: 'avg-correct', errorTrade: true,
      execId: '0000e1a7.6a939e15.01.01', time: '2026-08-27T04:47:34.990Z', ticker: 'BZ=F', side: 'buy',
      priceCorrectedFrom: 87.442 }
  ], { officialSettlePx: () => 89.31 });
  assert.equal(changed, 1);
  const flat = rows.find(r => r.role === 'flatten');
  assert.ok(flat);
  assert.equal(flat.price, 89.31);
  assert.equal(flat.key, live);
  assert.equal(flat.errorTrade, false);
  const fifo = fifoLotEconomics(rows, { dir: 1, futMult: 1000 });
  assert.equal(fifo.openQty, 1);
  assert.equal(+fifo.avgEntry.toFixed(2), 91.25);
  assert.equal(+fifo.realizedLocal.toFixed(2), 1868);
});

test('calendar bias is next-month fill minus official settle times multiplier', () => {
  const { rebuildFuturesRollFills, futuresRollCalendarBias } = require('../lib/ibkr/futures-roll');
  const live = 'BZ=F|short|Thu Aug 27 2026';
  const { rows } = rebuildFuturesRollFills([
    { key: live, role: 'entry', qty: 1, price: 91.25, recon: 'futures-roll',
      execId: '0000e1a7.6a971cd6.01.01', time: '2026-08-31T10:05:30.255Z', ticker: 'BZ=F', side: 'buy',
      multiplier: 1000 },
    { key: live, role: 'entry', qty: 1, price: 87.442, recon: 'qty-pad',
      execId: 'recon-entry-' + live + '-p', time: '2026-08-27T00:00:00.000Z', ticker: 'BZ=F', side: 'buy',
      multiplier: 1000 }
  ], { officialSettlePx: () => 89.31 });
  const bias = futuresRollCalendarBias(rows, {
    officialSettlePx: () => 89.31,
    officialSettleDate: () => '2026-08-28',
    futMult: (_t, m) => Number(m) || 1000
  });
  assert.equal(bias.usd, 1940);
  assert.equal(bias.fromDate, '2026-08-28');
});
