'use strict';

/**
 * IB Gateway / TWS down-page. The bridge process exits on every refused
 * connect, so the 5-minute clock must live in persisted alertMeta and
 * survive run-forever restarts.
 */

const DEFAULT_ALERT_MS = 5 * 60 * 1000;
const DEFAULT_REMIND_MS = 30 * 60 * 1000;

function gatewayDownDecision(meta, nowMs, opts) {
  opts = opts || {};
  const alertAfterMs = Number(opts.alertAfterMs) > 0 ? Number(opts.alertAfterMs) : DEFAULT_ALERT_MS;
  const remindAfterMs = Number(opts.remindAfterMs) > 0 ? Number(opts.remindAfterMs) : DEFAULT_REMIND_MS;
  const now = Number(nowMs) || 0;
  const next = Object.assign({}, (meta && typeof meta === 'object') ? meta : {});
  const since = Number(next.gatewayDownSince) || 0;
  if (!since) {
    next.gatewayDownSince = now;
    return { meta: next, send: false, remind: false, reason: 'clock-start', downMs: 0 };
  }
  const downMs = now - since;
  if (downMs < alertAfterMs) {
    return { meta: next, send: false, remind: false, reason: 'waiting', downMs };
  }
  if (next.gatewayAlerted) {
    const last = Number(next.gatewayAlertAt) || 0;
    if (now - last < remindAfterMs) {
      return { meta: next, send: false, remind: false, reason: 'throttled', downMs };
    }
    next.gatewayAlertAt = now;
    return { meta: next, send: true, remind: true, reason: 'remind', downMs };
  }
  next.gatewayAlerted = true;
  next.gatewayAlertAt = now;
  return { meta: next, send: true, remind: false, reason: 'first', downMs };
}

function gatewayRecoverDecision(meta, nowMs) {
  const prev = (meta && typeof meta === 'object') ? meta : {};
  const since = Number(prev.gatewayDownSince) || 0;
  const alerted = !!prev.gatewayAlerted;
  if (!since && !alerted) {
    return { meta: prev, send: false, downMs: 0 };
  }
  const now = Number(nowMs) || 0;
  const next = Object.assign({}, prev, {
    gatewayDownSince: 0,
    gatewayAlerted: false,
    gatewayAlertAt: 0
  });
  return {
    meta: next,
    send: alerted,
    downMs: since ? Math.max(0, now - since) : 0
  };
}

function fmtDownMins(downMs) {
  return Math.max(1, Math.round((Number(downMs) || 0) / 60000));
}

function formatGatewayDownAlert(input) {
  const host = (input && input.host) || '127.0.0.1';
  const port = (input && input.port) || 4002;
  const account = (input && input.account) || 'paper';
  const mins = fmtDownMins(input && input.downMs);
  const reason = String((input && input.reason) || 'Cannot connect to IB Gateway / TWS.');
  const title = (input && input.remind)
    ? '🚨 AlphaSignal IBKR Gateway still down'
    : '🚨 AlphaSignal IBKR Gateway down';
  return [
    title,
    `Account: ${account}`,
    `IB: ${host}:${port}`,
    `Down for: ${mins} min`,
    `Time: ${new Date((input && input.nowMs) || Date.now()).toISOString()}`,
    '',
    reason,
    'Entries cannot place until IB Gateway is logged in with API enabled.',
    'Open IB Gateway (paper) on the trading PC — the bridge reconnects on its own.'
  ].join('\n');
}

function formatGatewayRecoveredAlert(input) {
  const host = (input && input.host) || '127.0.0.1';
  const port = (input && input.port) || 4002;
  const account = (input && input.account) || 'paper';
  const mins = fmtDownMins(input && input.downMs);
  return [
    '✅ AlphaSignal IBKR Gateway back',
    `Account: ${account}`,
    `IB: ${host}:${port}`,
    `Was down: ${mins} min`,
    `Time: ${new Date((input && input.nowMs) || Date.now()).toISOString()}`,
    '',
    'Bridge connected. Pending board entries will place on the next poll.'
  ].join('\n');
}

module.exports = {
  DEFAULT_ALERT_MS,
  DEFAULT_REMIND_MS,
  gatewayDownDecision,
  gatewayRecoverDecision,
  formatGatewayDownAlert,
  formatGatewayRecoveredAlert
};
