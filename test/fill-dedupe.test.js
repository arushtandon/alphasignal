'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { preferIbkrFillRow, dedupeIbkrFillsByExecId } = require('../lib/ibkr/fill-dedupe');

test('duplicate recon-flat execIds collapse to one commission', () => {
  const id = 'recon-flat-SU.PA|long|Wed Aug 12 2026-q28';
  const rows = [];
  for (let i = 0; i < 11; i++) {
    rows.push({
      execId: id, key: 'SU.PA|long|Wed Aug 12 2026|cursor-err',
      ticker: 'SU.PA', role: 'flatten', qty: 28, price: 309.395215,
      commission: 4.3337, commissionCcy: 'EUR', errorTrade: true
    });
  }
  const out = dedupeIbkrFillsByExecId(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].commission, 4.3337);
});

test('commission-bearing copy wins over a bare duplicate', () => {
  const keep = preferIbkrFillRow(
    { execId: 'x', commission: 0, errorTrade: true },
    { execId: 'x', commission: 4.33, errorTrade: true }
  );
  assert.equal(keep.commission, 4.33);
});

test('model fill wins when the same execId was also stamped error', () => {
  const keep = preferIbkrFillRow(
    { execId: 'ib', commission: 4.33, errorTrade: true },
    { execId: 'ib', commission: 4.33, errorTrade: false }
  );
  assert.equal(keep.errorTrade, false);
});
