'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isOcaRepairLabel,
  isModifyRejectCode,
  safeRepairStopQty,
  shouldSkipPairRepair,
  markRepairLocked,
} = require('../lib/ibkr/runner-oca-repair');

describe('runner-oca-repair', () => {
  it('detects OCA repair labels and 10327 modify rejects', () => {
    assert.equal(isOcaRepairLabel('runner stop OCA repair BRK-B|short|Fri Aug 14 2026'), true);
    assert.equal(isOcaRepairLabel('stop qty in-place NVDA'), false);
    assert.equal(isModifyRejectCode(10327), true);
    assert.equal(isModifyRejectCode(201), true);
    assert.equal(isModifyRejectCode(2104), false);
  });

  it('never reduces stop qty below position or current stop', () => {
    assert.equal(safeRepairStopQty({ runnerQty: 10, positionQty: 10, currentStopQty: 10 }), 10);
    assert.equal(safeRepairStopQty({ runnerQty: 5, positionQty: 10, currentStopQty: 10 }), 10);
    assert.equal(safeRepairStopQty({ runnerQty: 10, positionQty: 10, currentStopQty: 15 }), 15);
    assert.equal(safeRepairStopQty({ runnerQty: 500, positionQty: 500, currentStopQty: 0 }), 500);
  });

  it('locks a pair once and skips further repairs', () => {
    const row = {};
    assert.equal(shouldSkipPairRepair(row), false);
    assert.equal(markRepairLocked(row, { code: 10327, message: 'OCA group type revision is not allowed.', orderId: 61717133 }), true);
    assert.equal(row.repairLocked, true);
    assert.equal(shouldSkipPairRepair(row), true);
    assert.equal(markRepairLocked(row, { code: 10327, message: 'again' }), false);
  });
});
