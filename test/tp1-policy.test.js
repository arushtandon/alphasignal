'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  tp1SoldQty,
  tp1OrderQty,
  isFullQtyTp1,
  synthesizeTp1Px,
  maybeTwoLotTotal,
  openIfAboveSpec,
  passiveCloseLimit,
  fillHonorsTp1Limit,
  isMarketLikeExit,
  isLimitTp1Fill
} = require('../lib/ibkr/tp1-policy');

test('TP1 half is lot-rounded and zero on a single board lot', () => {
  assert.equal(tp1SoldQty(6000, 1000), 3000);
  assert.equal(tp1SoldQty(1600, 100), 800);
  assert.equal(tp1SoldQty(2000, 2000), 0);
  assert.equal(tp1SoldQty(100, 100), 0);
  assert.equal(tp1SoldQty(400, 400), 0);
});

test('unsplittable 1-lot / 1-contract sells the full qty at TP1', () => {
  assert.equal(tp1OrderQty(6000, 1000), 3000);
  assert.equal(tp1OrderQty(1, 1), 1);
  assert.equal(tp1OrderQty(2000, 2000), 2000);
  assert.equal(isFullQtyTp1(1, 1), true);
  assert.equal(isFullQtyTp1(82, 1), false);
  assert.equal(isFullQtyTp1(2000, 2000), true);
});

test('synthesize TP1 uses horizon percentages', () => {
  assert.equal(+synthesizeTp1Px(23.19, 'medium', false).toFixed(4), 24.8133);
  assert.ok(synthesizeTp1Px(29.34, 'short', false) > 29.34);
  assert.ok(synthesizeTp1Px(18760, 'short', false) > 18760);
});

test('1-lot names bump to 2 lots when notional cap allows', () => {
  const bumped = maybeTwoLotTotal({
    total: 2000, lot: 2000, nlv: 1_000_000, entry: 29.34,
    fxToUsd: 1 / 7.8, maxPositionPct: 0.025, secType: 'STK'
  });
  assert.equal(bumped, 4000);
  const tooBig = maybeTwoLotTotal({
    total: 1, lot: 1, nlv: 10_000, entry: 400,
    fxToUsd: 1, maxPositionPct: 0.025, secType: 'STK'
  });
  assert.equal(tooBig, 1);
});

test('0883 keeps an open-if-above TP1 spec', () => {
  const spec = openIfAboveSpec('0883.HK');
  assert.equal(spec.qty, 3000);
  assert.equal(spec.minPx, 25);
  assert.equal(spec.tif, 'GTC');
});

test('through-market TP1 parks at last so IB HK does not 201 it as a short', () => {
  assert.equal(passiveCloseLimit(25, 25.25, false), 25.25);
  assert.equal(passiveCloseLimit(25, 24.80, false), 25);
  assert.equal(passiveCloseLimit(50, 48.5, false), 50);
  assert.equal(passiveCloseLimit(115, 114, true), 114);
  assert.equal(passiveCloseLimit(115, 116, true), 115);
});

test('TP1 is only a limit fill at/through the TP1 price, never a flatten', () => {
  assert.equal(fillHonorsTp1Limit(25.40, 25, false), true);
  assert.equal(fillHonorsTp1Limit(24.50, 25, false), false);
  assert.equal(fillHonorsTp1Limit(114.8, 115, true), true);
  assert.equal(fillHonorsTp1Limit(116, 115, true), false);
  assert.equal(isMarketLikeExit('MKT'), true);
  assert.equal(isMarketLikeExit('LMT'), false);
  assert.equal(isLimitTp1Fill({
    fillPx: 25.4, tp1Px: 25, isSellPosition: false, orderType: 'LMT'
  }), true);
  assert.equal(isLimitTp1Fill({
    fillPx: 25.4, tp1Px: 25, isSellPosition: false, orderType: 'MKT'
  }), false);
  assert.equal(isLimitTp1Fill({
    fillPx: 23.2, tp1Px: 25, isSellPosition: false, orderType: 'LMT', isFlattenOrder: true
  }), false);
});

test('false tp1Done with a reduced IB lot infers qtySold; a full lot unlatches', () => {
  const { reconcileTp1LatchFromPosition } = require('../lib/ibkr/tp1-policy');
  const half = { tp1Done: true, qtySold: 0, qtyTotal: 600, qtyRunner: 600 };
  const a = reconcileTp1LatchFromPosition(half, 300, 100);
  assert.equal(a.reason, 'infer-from-reduced-qty');
  assert.equal(half.qtySold, 300);
  assert.equal(half.qtyRunner, 300);
  assert.equal(half.tp1Done, true);
  const full = { tp1Done: true, qtySold: 0, qtyTotal: 600, qtyRunner: 600 };
  const b = reconcileTp1LatchFromPosition(full, 600, 100);
  assert.equal(b.reason, 'unlatch-full-lot');
  assert.equal(full.tp1Done, false);
});

