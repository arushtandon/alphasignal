'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { rebaseExitsFromFill, alignFillToModel } = require('../lib/ibkr/fill-rebase');

test('SNDK open at 1600 scales TP1/SL off the fill, not the rec entry', () => {
  const rec = rebaseExitsFromFill({
    modelEntry: 1493.12, modelTp1: 1660.29, modelSl: 1373.67, fillPx: 1600
  });
  assert.ok(rec);
  assert.equal(+rec.scale.toFixed(6), +(1600 / 1493.12).toFixed(6));
  assert.equal(+rec.tp1.toFixed(2), 1779.14);
  assert.equal(+rec.sl.toFixed(2), 1472.00);
  const tp1Pct = (1660.29 - 1493.12) / 1493.12;
  const slPct = (1493.12 - 1373.67) / 1493.12;
  assert.equal(+((rec.tp1 - 1600) / 1600).toFixed(6), +tp1Pct.toFixed(6));
  assert.equal(+((1600 - rec.sl) / 1600).toFixed(6), +slPct.toFixed(6));
});

test('short percentages are preserved the same way', () => {
  const rec = rebaseExitsFromFill({
    modelEntry: 100, modelTp1: 90, modelSl: 108, fillPx: 95
  });
  assert.equal(+rec.tp1.toFixed(4), 85.5);
  assert.equal(+rec.sl.toFixed(4), 102.6);
});

test('missing entry or fill returns null', () => {
  assert.equal(rebaseExitsFromFill({ modelEntry: 0, fillPx: 1600, modelTp1: 1, modelSl: 1 }), null);
  assert.equal(rebaseExitsFromFill({ modelEntry: 1493, fillPx: 0, modelTp1: 1, modelSl: 1 }), null);
});

test('LSE pound avgCost is aligned to a pence model so TP1 is not 10.7', () => {
  assert.equal(+alignFillToModel(9.505997, 944.2).toFixed(4), 950.5997);
  const rec = rebaseExitsFromFill({
    modelEntry: 944.2, modelTp1: 1058, modelSl: 868.5, fillPx: 9.505997
  });
  assert.ok(rec.tp1 > 1000, 'TP1 stays in pence, not pounds');
  assert.ok(rec.sl > 800);
  assert.ok(rec.tp1 < 1200);
  assert.equal(alignFillToModel(870.4, 869.6), 870.4, 'MNDI pence fill is unchanged');
});
