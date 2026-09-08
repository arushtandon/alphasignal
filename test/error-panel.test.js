'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  IBKR_ERROR_PANEL_START,
  isArchivedErrorPanelLot,
  dropArchivedErrorPanelLots
} = require('../lib/ibkr/error-panel');

test('error panel start is the 8 Sep 2026 reset', () => {
  assert.equal(IBKR_ERROR_PANEL_START, '2026-09-08');
});

test('pre-reset error lots are archived; model lots stay', () => {
  const oldErr = {
    errorTrade: true,
    key: 'AIR.PA|short|Thu Aug 06 2026|cursor-err',
    fills: [{ role: 'entry', time: '2026-08-07T05:00:00.000Z' }]
  };
  const todayErr = {
    errorTrade: true,
    key: 'FOO|short|Tue Sep 08 2026|cursor-err',
    fills: [{ role: 'entry', time: '2026-09-08T00:35:00.000Z' }]
  };
  const model = {
    errorTrade: false,
    key: '2914.T|short|Wed Aug 05 2026',
    fills: [{ role: 'tp1', time: '2026-08-07T05:03:39.000Z' }]
  };
  assert.equal(isArchivedErrorPanelLot(oldErr), true);
  assert.equal(isArchivedErrorPanelLot(todayErr), false);
  assert.equal(isArchivedErrorPanelLot(model), false);
  const { trades, dropped, start } = dropArchivedErrorPanelLots([oldErr, todayErr, model]);
  assert.equal(start, '2026-09-08');
  assert.equal(dropped, 1);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].key, todayErr.key);
  assert.equal(trades[1].key, model.key);
});

test('old error lot that prints again today is captured', () => {
  const revived = {
    errorTrade: true,
    key: 'AIR.DE|short|Thu Aug 06 2026|cursor-err',
    fills: [
      { role: 'entry', time: '2026-08-07T05:00:00.000Z' },
      { role: 'flatten', time: '2026-09-08T01:00:00.000Z' }
    ]
  };
  assert.equal(isArchivedErrorPanelLot(revived), false);
});
