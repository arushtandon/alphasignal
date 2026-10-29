'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRiskSize } = require('../lib/risk/sizing');
const { setupBookPnlViews, stampLateEntryDeviation } = require('../lib/strategy/setup-book-runtime');
const { parentEntrySpec, toContract } = require('../ibkr-bridge/bridge');

test('ALAB spread-limit does not reject a setup-book ticket', () => {
  const input = {
    nlv: 457089,
    entry: 257.16,
    stop: 207.27,
    fxToUsd: 1,
    lot: 1,
    spreadBps: 80,
    drawdownPct: 0.12,
    capitalScale: 0,
    ticketNotionalUsd: 30000,
    allowMinLot: true,
  };
  const blocked = calculateRiskSize(input);
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, 'spread-limit');
  const setup = calculateRiskSize({ ...input, setupBook: true });
  assert.equal(setup.eligible, true);
  assert.equal(setup.reason, 'setup-ticket');
  assert.ok(setup.quantity >= 1);
  assert.ok(setup.notionalUsd <= 30000);
});

test('a setup-book US entry is not rejected by the RTH chase cap', () => {
  const wide = { side: 'sell', entryPx: 200, quotePx: 170, phaseOverride: 'rth' };
  const legacy = parentEntrySpec(toContract('ALAB'), 'SELL', 10, wide);
  const setup = parentEntrySpec(toContract('ALAB'), 'SELL', 10, { ...wide, setupId: 'US_SHORT_MR' });
  assert.equal(legacy.entryStyle, 'SKIP-CHASE');
  assert.equal(setup.entryStyle, 'MKT');
});

test('setup-book P&L defaults to IBKR fills and keeps model trades labelled beside them', () => {
  const history = [
    { setupId: 'US_SHORT_MR', hz: 'short', shortStatus: 'sl_hit', shortPnlPct: -4, ticker: 'ALAB', entryDate: '2026-10-13' },
    { setupId: 'US_SHORT_MR', hz: 'short', shortStatus: 'time_limit', shortPnlPct: 1.5, ticker: 'CSCO', entryDate: '2026-10-19', ibkrFilled: true },
  ];
  const fills = [
    { key: 'CSCO|short|2026-10-19', ticker: 'CSCO', setupId: 'US_SHORT_MR', role: 'entry' },
  ];
  const view = setupBookPnlViews(history, { fills }).US_SHORT_MR;
  assert.equal(view.label, 'IBKR-filled trades');
  assert.equal(view.trades, 1);
  assert.equal(view.filled.label, 'IBKR-filled trades');
  assert.equal(view.filled.trades, 1);
  assert.equal(view.model.label, 'Model (board) trades');
  assert.equal(view.model.trades, 1);
});

test('2503.T on 29 Oct is tagged and kept out of the comparable setup-book P&L', () => {
  const trade = {
    setupId: 'JAPAN_MEDIUM_MR',
    hz: 'medium',
    mediumStatus: 'sl_hit',
    mediumPnlPct: 1.2,
    ticker: '2503.T',
    entryDate: '2026-10-29T04:15:47.743Z',
    ibkrFilled: true,
  };
  assert.equal(stampLateEntryDeviation(trade), true);
  assert.equal(trade.lateEntryDeviation, true);
  assert.equal(trade.lateEntryOpen, 2817.5);
  assert.equal(trade.lateEntryLimit, 2885);
  const other = { ticker: '7203.T', entryDate: '2026-10-29', setupId: 'JAPAN_MEDIUM_MR', hz: 'medium', mediumStatus: 'sl_hit', mediumPnlPct: -1, ibkrFilled: true };
  assert.equal(stampLateEntryDeviation(other), false);
  const view = setupBookPnlViews([trade, other]).JAPAN_MEDIUM_MR;
  assert.equal(view.filled.trades, 2);
  assert.equal(view.filledExcludingLateEntry.trades, 1);
  assert.equal(view.lateEntryDeviation.trades, 1);
});
