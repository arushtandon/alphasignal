'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseIbExecTime, formatIbExecFilterTime } = require('../lib/ibkr/ib-exec-time');

test('US cash-open stamp in America/New_York is Market, not After hours', () => {
  const ms = parseIbExecTime('20260824  09:31:00', 'America/New_York');
  assert.ok(Number.isFinite(ms));
  const utcHour = new Date(ms).getUTCHours();
  // 09:31 EDT = 13:31 UTC
  assert.equal(utcHour, 13);
});

test('ISO timestamps stay absolute', () => {
  const ms = parseIbExecTime('2026-08-25T04:20:04.447Z');
  assert.equal(ms, Date.parse('2026-08-25T04:20:04.447Z'));
});

test('reqExecutions filter uses UTC dash, not the double-space exec stamp', () => {
  const ms = Date.UTC(2026, 7, 4, 5, 37, 38);
  assert.equal(formatIbExecFilterTime(ms), '20260804-05:37:38');
  assert.equal(formatIbExecFilterTime(ms).includes('  '), false);
  const local = formatIbExecFilterTime(ms, 'local');
  assert.match(local, /^\d{8} \d{2}:\d{2}:\d{2}$/);
  assert.equal(local.includes('  '), false);
});

test('exec history pulls this client by default, all clients when asked', () => {
  const { execHistoryFilter } = require('../lib/ibkr/ib-exec-time');
  const ms = Date.UTC(2026, 7, 4, 11, 18, 34);
  assert.deepEqual(execHistoryFilter({ fromMs: ms, account: 'DU1764495' }), {
    time: '20260804-11:18:34',
    acctCode: 'DU1764495'
  });
  assert.deepEqual(execHistoryFilter({ fromMs: ms, account: 'DU1764495', allClients: true }), {
    clientId: 0,
    time: '20260804-11:18:34',
    acctCode: 'DU1764495'
  });
  assert.deepEqual(execHistoryFilter({ account: 'DU1764495', allClients: true }), {
    clientId: 0,
    acctCode: 'DU1764495'
  });
});
