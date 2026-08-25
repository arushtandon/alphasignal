'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseIbExecTime } = require('../lib/ibkr/ib-exec-time');

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
