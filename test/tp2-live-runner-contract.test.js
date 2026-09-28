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
