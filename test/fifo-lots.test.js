'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fifoLotEconomics } = require('../lib/ibkr/fifo-lots');

test('single entry / exit is unchanged vs VWAP', () => {
  const fifo = fifoLotEconomics([
    { role: 'entry', qty: 1, price: 87.44, time: '2026-08-27T04:47:34Z' },
    { role: 'flatten', qty: 1, price: 89.31, time: '2026-08-31T09:30:00Z' }
  ], { dir: 1, futMult: 1000 });
  assert.equal(fifo.openQty, 0);
  assert.equal(+fifo.avgEntry.toFixed(2), 87.44);
  assert.equal(+fifo.realizedLocal.toFixed(2), 1870);
});

test('BZ roll realises October vs 87.44 and keeps November as the open basis', () => {
  const fifo = fifoLotEconomics([
    { role: 'entry', qty: 1, price: 87.44, time: '2026-08-27T04:47:34Z' },
    { role: 'flatten', qty: 1, price: 89.31, time: '2026-08-31T09:30:00Z' },
    { role: 'entry', qty: 1, price: 92.19, time: '2026-08-31T09:31:00Z' }
  ], { dir: 1, futMult: 1000 });
  assert.equal(fifo.openQty, 1);
  assert.equal(+fifo.avgEntry.toFixed(2), 92.19);
  assert.equal(+fifo.realizedLocal.toFixed(2), 1870);
  assert.equal(+fifo.exitMatches[0].realizedLocal.toFixed(2), 1870);
});
