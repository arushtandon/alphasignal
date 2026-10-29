'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { voidOverExitQtyTrims } = require('../lib/ibkr/void-over-exit-trims');

function isGenuine(r) {
  if (!r || r.synthetic === true) return false;
  const exec = String(r.execId || '');
  return !!exec && !/^(recon-|recover-entry-|repair-ibflat-|cursor-err-|ibhist-|synth-)/.test(exec);
}

test('SHEL.L: voids pounds qty-trim so TP1+TP2 can book against the runner', () => {
  const key = 'SHEL.L|medium|Tue Sep 08 2026';
  const rows = [
    { key, ticker: 'SHEL.L', role: 'entry', qty: 744, price: 3523, time: '2026-09-08T09:01:46Z', execId: 'e1' },
    { key, ticker: 'SHEL.L', role: 'tp1', qty: 372, price: 3869, time: '2026-10-13T14:53:03Z', execId: 'tp1' },
    {
      key, ticker: 'SHEL.L', role: 'flatten', qty: 372, price: 38.68, time: '2026-10-13T14:53:44Z',
      execId: 'recon-trim-' + key + '-q372', synthetic: true, recon: 'qty-trim'
    },
    { key, ticker: 'SHEL.L', role: 'tp2', qty: 372, price: 4042, time: '2026-10-29T08:03:39Z', execId: 'tp2' }
  ];
  const { rows: next, dropped } = voidOverExitQtyTrims(rows, { isGenuineIbExecFill: isGenuine });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].recon, 'qty-trim');
  assert.equal(next.length, 3);
  assert.ok(next.every(r => r.recon !== 'qty-trim'));
});

test('SU.PA: voids phantom trim when the stop already covers the lot', () => {
  const key = 'SU.PA|long|Wed Aug 12 2026';
  const rows = [
    { key, ticker: 'SU.PA', role: 'entry', qty: 13, price: 309.75, time: '2026-08-12T07:05:00Z', execId: 'e1' },
    {
      key, ticker: 'SU.PA', role: 'flatten', qty: 14, price: 249.7, time: '2026-10-19T08:48:45Z',
      execId: 'recon-trim-' + key + '-q14', synthetic: true, recon: 'qty-trim'
    },
    { key, ticker: 'SU.PA', role: 'stop', qty: 13, price: 249.75, time: '2026-10-19T08:49:10Z', execId: 'stop' }
  ];
  const { rows: next, dropped } = voidOverExitQtyTrims(rows, { isGenuineIbExecFill: isGenuine });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].qty, 14);
  assert.equal(next.filter(r => r.role === 'stop').length, 1);
});

test('keeps a qty-trim that is the only exit covering inventory', () => {
  const key = 'XYZ|short|Mon Jan 01 2026';
  const rows = [
    { key, ticker: 'XYZ', role: 'entry', qty: 10, price: 100, time: '2026-01-01T10:00:00Z', execId: 'e1' },
    {
      key, ticker: 'XYZ', role: 'flatten', qty: 10, price: 90, time: '2026-01-02T10:00:00Z',
      execId: 'recon-trim-' + key + '-q10', synthetic: true, recon: 'qty-trim'
    }
  ];
  const { rows: next, dropped } = voidOverExitQtyTrims(rows, { isGenuineIbExecFill: isGenuine });
  assert.equal(dropped.length, 0);
  assert.equal(next.length, 2);
});
