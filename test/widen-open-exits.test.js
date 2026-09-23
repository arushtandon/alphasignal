'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  recDayOnOrBeforeWidenCutoff,
  widenOpenExits
} = require('../lib/ibkr/widen-open-exits');

test('cutoff includes 15 Sep lots and skips the next board day', () => {
  assert.equal(recDayOnOrBeforeWidenCutoff('0267.HK|short|Tue Sep 15 2026'), true);
  assert.equal(recDayOnOrBeforeWidenCutoff('BRK-B|short|Fri Aug 14 2026'), true);
  assert.equal(recDayOnOrBeforeWidenCutoff('NVDA|long|Wed Sep 16 2026'), false);
});

test('tight short SL lifts to the 4% floor and TP keeps ≥1.1 R:R', () => {
  const w = widenOpenExits({
    entry: 505.69, sl: 493.4, tp1: 524, hz: 'short', isSell: false
  });
  assert.ok(w);
  assert.ok(Math.abs(w.slPct - 0.04) < 1e-9);
  assert.ok(w.sl < 493.4);
  assert.ok(w.tp1 > 524);
  assert.ok(w.tp1Pct + 1e-9 >= w.slPct * 1.1);
});

test('already-wide long stop still gets +1.5pts and scaled TP', () => {
  const w = widenOpenExits({
    entry: 224.1, sl: 173.2, tp1: 284.5, hz: 'long', isSell: false
  });
  const oldSl = (224.1 - 173.2) / 224.1;
  assert.ok(Math.abs(w.slPct - (oldSl + 0.015)) < 1e-9);
  assert.ok(w.sl < 173.2);
  assert.ok(w.tp1 > 284.5);
});

test('inverted Sony SL (stop above a buy fill) is repaired to the 4% floor', () => {
  const w = widenOpenExits({
    entry: 3587.57, sl: 3625, tp1: 3935, tp2: 3810, hz: 'short', isSell: false
  });
  assert.ok(w.sl < 3587.57);
  assert.ok(Math.abs(w.slPct - 0.04) < 1e-9);
  assert.ok(w.tp1 >= 3935);
});

test('sell stop moves higher and TP lower', () => {
  const w = widenOpenExits({
    entry: 44.026, sl: 47.43, tp1: 40.21, hz: 'medium', isSell: true
  });
  assert.ok(w.sl > 47.43);
  assert.ok(w.tp1 < 40.21);
});

test('TP inside the stop is lifted to 1.1 R:R after the widen', () => {
  const w = widenOpenExits({
    entry: 160, sl: 153.1, tp1: 163.3, hz: 'short', isSell: false
  });
  assert.ok(w.sl < 153.1);
  assert.ok(w.tp1Pct + 1e-9 >= w.slPct * 1.1);
  assert.ok(w.tp1 > 163.3);
});

test('post-cutoff lot gets bracket floors without another 1.5pt stop widening', () => {
  const w = widenOpenExits({
    entry: 1605,
    sl: 1525,
    tp1: 1665,
    tp2: 1720,
    hz: 'short',
    isSell: false,
    addLegacyWiden: false
  });
  assert.ok(Math.abs(w.sl - 1525) < 1e-9);
  assert.ok(w.tp1Pct + 1e-9 >= w.slPct * 1.1);
  assert.ok(w.tp1 > 1665);
});
