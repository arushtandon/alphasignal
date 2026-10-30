'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldClearFalseOpgFill,
  shouldAbandonStaleUnfilled,
  otherOpenRowOwnsConId,
  planReopenAbandonedRow,
} = require('../lib/ibkr/held-row');

describe('held-row', () => {
  it('does not clear a real OPG fill that has an average or a live position', () => {
    const filled = {
      entryFilled: true, entryStyle: 'OPG', parentFilledQty: 0, posInDir: 0, ibAvgFill: 5241,
    };
    assert.equal(shouldClearFalseOpgFill(filled), false);
    assert.equal(shouldClearFalseOpgFill({ ...filled, ibAvgFill: 0, posInDir: 300 }), false);
    assert.equal(shouldClearFalseOpgFill({
      entryFilled: true, entryStyle: 'OPG', parentFilledQty: 0, posInDir: 0, ibAvgFill: 0,
    }), true);
  });

  it('does not abandon 6501 while the fill or the position is still on the row', () => {
    assert.equal(shouldAbandonStaleUnfilled({
      posInDir: 0, ibAvgFill: 5241, ageExceeded: true, positionsReady: true,
    }), false);
    assert.equal(shouldAbandonStaleUnfilled({
      posInDir: 300, ibAvgFill: 0, ageExceeded: true, positionsReady: true,
    }), false);
    assert.equal(shouldAbandonStaleUnfilled({
      posInDir: 0, ibAvgFill: 0, ageExceeded: true, positionsReady: false,
    }), false);
    assert.equal(shouldAbandonStaleUnfilled({
      posInDir: 0, ibAvgFill: 0, ageExceeded: true, positionsReady: true,
    }), true);
  });

  it('reopens a closed stale row onto its live stop and TP1 and does not invent ids', () => {
    const row = {
      closed: true,
      staleUnfilledAbandoned: true,
      side: 'buy',
      contract: { conId: 13905665 },
    };
    const orders = [
      { orderId: 1, clientId: 93, conId: 13905665, action: 'SELL', type: 'STP', qty: 300, status: 'PreSubmitted' },
      { orderId: 2, clientId: 93, conId: 13905665, action: 'SELL', type: 'LMT', qty: 100, status: 'Submitted' },
    ];
    const plan = planReopenAbandonedRow({
      row, posInDir: 300, otherOpenOwns: false, orders, conId: 13905665,
    });
    assert.equal(plan.reopen, true);
    assert.equal(plan.stopId, 1);
    assert.equal(plan.stopClientId, 93);
    assert.equal(plan.tp1Id, 2);
    assert.equal(plan.tp1ClientId, 93);
    assert.equal(planReopenAbandonedRow({
      row, posInDir: 0, otherOpenOwns: false, orders, conId: 13905665,
    }).reopen, false);
    const byKey = { 'other|long|x': { closed: false, contract: { conId: 13905665 } } };
    assert.equal(otherOpenRowOwnsConId(byKey, 13905665, '6501.T|short|Wed Aug 19 2026'), true);
  });
});
