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
  assert.match(bridge, /const runnerOca = \{ ocaGroup: runnerOcaGroupForKey\(key, row\), ocaType: 1 \}/);
  assert.match(bridge, /orderType: 'STP', auxPrice: runnerStop,[\s\S]{0,180}tif: 'GTC',[\s\S]{0,120}\.\.\.runnerOca/);
  assert.match(bridge, /orderType: 'LMT',[\s\S]{0,180}tif: 'GTC',[\s\S]{0,120}\.\.\.runnerOca/);
});

test('runner reconciliation adopts live TP2 before placing and repairs OCA in place', () => {
  assert.match(bridge, /RECONCILE: adopted working TP2/);
  assert.match(bridge, /runner stop OCA repair/);
  assert.match(bridge, /runner TP2 OCA repair/);
  assert.match(bridge, /ensureWorkingTp2Children\(null, \{ onlyKey: key \}\)/);
});
