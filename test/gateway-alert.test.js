'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  gatewayDownDecision,
  gatewayRecoverDecision,
  formatGatewayDownAlert,
  formatGatewayRecoveredAlert
} = require('../lib/ibkr/gateway-alert');

const ALERT = 5 * 60 * 1000;
const REMIND = 30 * 60 * 1000;
const opts = { alertAfterMs: ALERT, remindAfterMs: REMIND };

test('first refused connect only starts the down clock', () => {
  const d = gatewayDownDecision({}, 1_000, opts);
  assert.equal(d.send, false);
  assert.equal(d.reason, 'clock-start');
  assert.equal(d.meta.gatewayDownSince, 1_000);
});

test('does not page before 5 minutes', () => {
  const d = gatewayDownDecision({ gatewayDownSince: 1_000 }, 1_000 + ALERT - 1, opts);
  assert.equal(d.send, false);
  assert.equal(d.reason, 'waiting');
});

test('pages once at 5 minutes', () => {
  const d = gatewayDownDecision({ gatewayDownSince: 1_000 }, 1_000 + ALERT, opts);
  assert.equal(d.send, true);
  assert.equal(d.remind, false);
  assert.equal(d.meta.gatewayAlerted, true);
  assert.equal(d.meta.gatewayAlertAt, 1_000 + ALERT);
});

test('throttles identical pages until the remind window', () => {
  const first = gatewayDownDecision({ gatewayDownSince: 1_000 }, 1_000 + ALERT, opts);
  const again = gatewayDownDecision(first.meta, 1_000 + ALERT + REMIND - 1, opts);
  assert.equal(again.send, false);
  assert.equal(again.reason, 'throttled');
});

test('reminds after 30 minutes still down', () => {
  const first = gatewayDownDecision({ gatewayDownSince: 1_000 }, 1_000 + ALERT, opts);
  const remind = gatewayDownDecision(first.meta, first.meta.gatewayAlertAt + REMIND, opts);
  assert.equal(remind.send, true);
  assert.equal(remind.remind, true);
});

test('recover is silent if we never paged', () => {
  const d = gatewayRecoverDecision({ gatewayDownSince: 1_000 }, 2_000);
  assert.equal(d.send, false);
  assert.equal(d.meta.gatewayDownSince, 0);
  assert.equal(d.meta.gatewayAlerted, false);
});

test('recover pages all-clear only after a down alert', () => {
  const d = gatewayRecoverDecision({
    gatewayDownSince: 1_000,
    gatewayAlerted: true,
    gatewayAlertAt: 1_000 + ALERT
  }, 1_000 + ALERT + 60_000);
  assert.equal(d.send, true);
  assert.equal(d.downMs, ALERT + 60_000);
  assert.equal(d.meta.gatewayAlerted, false);
  assert.equal(d.meta.gatewayDownSince, 0);
});

test('alert text names Gateway and the port', () => {
  const text = formatGatewayDownAlert({
    host: '127.0.0.1', port: 4002, account: 'DU1764495',
    downMs: 7 * 60 * 1000, reason: 'connect ECONNREFUSED', nowMs: Date.UTC(2026, 7, 31, 3, 45)
  });
  assert.match(text, /Gateway down/);
  assert.match(text, /4002/);
  assert.match(text, /7 min/);
  assert.match(text, /ECONNREFUSED/);
});

test('recovered text is an all-clear', () => {
  const text = formatGatewayRecoveredAlert({
    host: '127.0.0.1', port: 4002, account: 'DU1764495',
    downMs: 7 * 60 * 1000, nowMs: Date.UTC(2026, 7, 31, 3, 46)
  });
  assert.match(text, /Gateway back/);
  assert.match(text, /7 min/);
});
