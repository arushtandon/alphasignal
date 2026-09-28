'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bridge = fs.readFileSync(
  path.join(__dirname, '..', 'ibkr-bridge', 'bridge.js'),
  'utf8',
);

test('runner TP2 is GTC and OCA-linked with its post-TP1 stop', () => {
  assert.match(bridge, /function runnerOcaGroupForKey\(key, row\)/);
  assert.match(bridge, /function runnerStopOrder\(row, key, fields\)/);
  assert.match(bridge, /order\.ocaGroup = runnerOcaGroupForKey\(key, row\)/);
  assert.match(bridge, /order\.ocaType = 2/);
  assert.match(bridge, /tif: 'GTC'[\s\S]{0,320}ocaType: 2/);
});

test('runner reconciliation adopts live TP2 before placing and repairs OCA in place', () => {
  assert.match(bridge, /RECONCILE: adopted working TP2/);
  assert.match(bridge, /runner stop OCA repair/);
  assert.match(bridge, /runner TP2 OCA repair/);
  assert.match(bridge, /ensureWorkingTp2Children\(null, \{ onlyKey: key \}\)/);
  assert.match(bridge, /stop\.ocaGroup !== group \|\| existing\.ocaGroup !== group/);
  assert.match(bridge, /row\.runnerOcaStopId !== stop\.orderId/);
});

test('runner quantities are attributed per row and partial TP2 fills retain protection', () => {
  assert.match(bridge, /function attributedRunnerQty\(key, row, posInDir\)/);
  assert.match(bridge, /skip TP2 — runner attribution ambiguous/);
  assert.match(bridge, /row\.tp2FilledQty = Math\.min\(total, Math\.max/);
  assert.match(bridge, /runner stop partial-TP2 resize/);
  assert.match(bridge, /TP2 partial fill/);
  assert.match(bridge, /if \(!\(remaining > 0\)\) \{\s*onTp2Filled\(key, row\)/);
});

test('partial TP2 reconciliation preserves the unfilled remainder', () => {
  assert.match(bridge, /const tp2FilledQty = Math\.max\(0, Number\(row\.tp2FilledQty\) \|\| 0\)/);
  assert.match(bridge, /const tp2TotalQty = tp2FilledQty \+ runnerQty/);
  assert.match(bridge, /const existingUnfilledQty = Math\.max\(0, Number\(existing\.qty\) - tp2FilledQty\)/);
  assert.match(bridge, /existingUnfilledQty !== runnerQty/);
  assert.match(bridge, /totalQuantity: tp2TotalQty/);
});

test('acknowledged LSE runner stop can park one TP2 when omitted from open orders', () => {
  assert.match(bridge, /function runnerStopRecentlyAcknowledged\(row\)/);
  assert.match(bridge, /const stopAcknowledged = !stop && row\.stopId != null && runnerStopRecentlyAcknowledged\(row\)/);
  assert.match(bridge, /if \(!stop && !stopAcknowledged\)/);
  assert.match(bridge, /runner stop acknowledged but absent from open-order snapshot/);
});

test('LSE acknowledgement belongs to the current stop and is cleared on external cancellation', () => {
  assert.match(bridge, /row\.stopAcknowledgedId = Number\(orderId\)/);
  assert.match(bridge, /Number\(row\.stopAcknowledgedId\) === Number\(row\.stopId\)/);
  assert.match(bridge, /const ownCancel = \(st === 'Cancelled' \|\| st === 'ApiCancelled'\) && bridgeRequestedCancel\(orderId\)/);
  assert.match(bridge, /external stop cancellation — clearing acknowledgement/);
  assert.match(bridge, /row\.stopId = null/);
});
