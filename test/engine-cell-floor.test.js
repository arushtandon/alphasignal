'use strict';

process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCurrentEnginePlan, levelsMeetMinRR } = require('../server');
const { SETUPS } = require('../lib/strategy/evidence-setup-book');

function engineRow(confidence) {
  return {
    ticker: '4042.T',
    longAction: 'Buy',
    longRating: 'Buy',
    longScore: 72,
    longConf: confidence,
    longEntry: '100',
    longTarget1: '112',
    longStopLoss: '90',
  };
}

test('engine confidence 65 with cell win rate 39.5 and R:R at least 1.1 publishes', () => {
  const row = engineRow(65);
  applyCurrentEnginePlan(row, SETUPS.JAPAN_LONG_ENGINE);
  assert.equal(row.cellWinRate, 39.5);
  assert.equal(row.longConf, 65);
  assert.equal(row.longAction, 'Buy');
  assert.equal(row.action, 'Buy');
  assert.equal(row.longRating, 'Strong Buy');
  assert.equal(levelsMeetMinRR(row.longEntry, row.longTarget1, row.longStopLoss, false, 1.1), true);
});

test('engine confidence 58 does not publish even when the cell win rate is what used to be written into Conf', () => {
  const row = engineRow(58);
  applyCurrentEnginePlan(row, SETUPS.JAPAN_LONG_ENGINE);
  assert.equal(row.cellWinRate, 39.5);
  assert.equal(row.longConf, 58);
  assert.equal(row.longAction, 'Hold');
  assert.notEqual(row.action, 'Buy');
  assert.equal(row.longGateReason, 'Conf 58% < 62%');
});
