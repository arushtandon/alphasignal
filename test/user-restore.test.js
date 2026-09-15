'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyUserRestoreLedger,
  fifoFillsForRestoredKey,
  fillsKeepOriginalRestoreAvg,
  isGhostFlatFill
} = require('../lib/ibkr/user-restore');
const { fifoLotEconomics } = require('../lib/ibkr/fifo-lots');

const LIVE = '6758.T|short|Mon Sep 07 2026';
const ERR = LIVE + '|cursor-err';

test('ghost flatten is dropped and genuine fills return to the model key', () => {
  const { rows, dropped, moved, unstamped } = applyUserRestoreLedger([
    { key: ERR, role: 'entry', qty: 700, price: 3760.7, time: '2026-09-07T03:50:56Z', errorTrade: true },
    { key: ERR, role: 'flatten', qty: 700, price: 3615, recon: 'ghost-flat', execId: 'recon-flat-sony', errorTrade: true, synthetic: true, time: '2026-09-10T02:22:37Z' },
    { key: LIVE, role: 'entry', qty: 700, price: 3585, userReentry: true, time: '2026-09-11T00:00:00Z' }
  ]);
  assert.equal(dropped, 1);
  assert.equal(moved, 1);
  assert.equal(unstamped, 1);
  assert.equal(rows.length, 2);
  assert.ok(!rows.some(isGhostFlatFill));
  assert.equal(rows[0].key, LIVE);
  assert.equal(rows[0].errorTrade, false);
  assert.equal(rows[0].userRestoreKept, true);
  assert.equal(rows[1].userReentry, true);
});

test('FIFO keeps the original runner avg and ignores the re-buy', () => {
  const fills = fifoFillsForRestoredKey([
    { key: LIVE, role: 'entry', qty: 700, price: 3760.7, time: '2026-09-07T03:50:56Z' },
    { key: LIVE, role: 'flatten', qty: 700, price: 3615, recon: 'ghost-flat', time: '2026-09-10T02:22:37Z' },
    { key: LIVE, role: 'entry', qty: 700, price: 3585, userReentry: true, time: '2026-09-11T00:00:00Z' }
  ]);
  const fifo = fifoLotEconomics(fills, { dir: 1 });
  assert.equal(fifo.openQty, 700);
  assert.equal(+fifo.avgEntry.toFixed(1), 3760.7);
  assert.equal(fifo.realizedLocal, 0);
  assert.equal(fillsKeepOriginalRestoreAvg([
    { userReentry: true, role: 'entry' }
  ]), true);
});

test('keys without a user restore are unchanged', () => {
  const input = [
    { key: 'FDS|short|Wed Sep 09 2026', role: 'entry', qty: 120, price: 288, errorTrade: true }
  ];
  const { rows, dropped, moved } = applyUserRestoreLedger(input);
  assert.equal(dropped, 0);
  assert.equal(moved, 0);
  assert.equal(rows[0].errorTrade, true);
});
