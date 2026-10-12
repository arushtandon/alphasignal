'use strict';

const { rebaseSetupLevels } = require('./evidence-setup-book');
const { isUsSetupEntry, entryReleaseBlock } = require('../schedule/entry-release');

const NY = 'America/New_York';
const PRE_OPEN_MIN = 4 * 60;
const HANDOFF_MIN = 9 * 60 + 25;
const RTH_OPEN_MIN = 9 * 60 + 30;

/** Order the US cash open already uses: MKT + OPG, RTH only. */
const US_OPEN_ORDER = Object.freeze({
  orderType: 'MKT',
  tif: 'OPG',
  outsideRth: false,
  entryStyle: 'OPG',
});

function nyClock(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = type => (parts.find(part => part.type === type) || {}).value || '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const minute = Number(get('minute'));
  return {
    minutes: hour * 60 + minute,
    hour,
    minute,
    weekend: get('weekday') === 'Sat' || get('weekday') === 'Sun',
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function isUsSetupBookBuy(evt) {
  if (!isUsSetupEntry(evt)) return false;
  return String(evt.side || 'buy').toLowerCase() !== 'sell';
}

/** 'defer' before 04:00 NY, 'limit' until 09:25 NY, then 'open'. */
function usPremarketParentDecision(nowMs) {
  const clock = nyClock(nowMs);
  if (clock.weekend || clock.minutes < PRE_OPEN_MIN) return 'defer';
  if (clock.minutes < HANDOFF_MIN) return 'limit';
  return 'open';
}

function usSetupParentSpec(evt, qty, nowMs) {
  if (!isUsSetupBookBuy(evt)) return null;
  const decision = usPremarketParentDecision(nowMs);
  if (decision === 'defer') {
    return { defer: true, entryStyle: 'DEFER-US-UNTIL-PRE', action: 'BUY', totalQuantity: qty };
  }
  if (decision === 'limit') {
    return {
      orderType: 'LMT',
      action: 'BUY',
      totalQuantity: qty,
      lmtPrice: Number(evt.entry),
      tif: 'DAY',
      outsideRth: true,
      transmit: true,
      entryStyle: 'LMT-PRE',
    };
  }
  return null;
}

function childrenForFilledQty(setupId, filledQty, fillPx, atr, lot) {
  const { setupOrderShape } = require('./setup-book-execution');
  const levels = rebaseSetupLevels(setupId, fillPx, atr);
  const shape = setupOrderShape(setupId, filledQty, lot || 1);
  if (!levels || !shape || shape.executable === false) return null;
  return {
    qty: filledQty,
    levels,
    stop: {
      orderType: 'STP',
      auxPrice: levels.stop,
      totalQuantity: shape.initialStopQuantity,
      outsideRth: false,
      tif: 'GTC',
    },
    tp1: shape.targetQuantity > 0 ? {
      orderType: 'LMT',
      lmtPrice: levels.target1,
      totalQuantity: shape.targetQuantity,
    } : null,
    tp2: shape.runnerQuantity > 0 && levels.target2 != null ? {
      orderType: 'LMT',
      lmtPrice: levels.target2,
      totalQuantity: shape.runnerQuantity,
    } : null,
  };
}

function stopTriggered(stop, print) {
  if (!stop || !print) return false;
  if (print.outsideRth && stop.outsideRth === false) return false;
  const px = Number(print.px);
  const level = Number(stop.auxPrice);
  return px > 0 && level > 0 && px <= level;
}

function limitFillsBuy(limit, printPx) {
  const px = Number(printPx);
  return px > 0 && px <= Number(limit);
}

function fillVsOpen(fillPx, openPx) {
  const fill = Number(fillPx);
  const open = Number(openPx);
  if (!(fill > 0) || !(open > 0)) return null;
  return (fill - open) / open;
}

function premarketFillLog({ ticker, preFillPx, preFillAt, openPx, fillPx }) {
  const compared = Number(fillPx) > 0 ? Number(fillPx) : Number(preFillPx);
  const vs = fillVsOpen(compared, openPx);
  return 'US pre-market ' + (ticker || '')
    + ' preFill=' + (Number(preFillPx) > 0 ? preFillPx : 'none')
    + ' at=' + (preFillAt || 'none')
    + ' open=' + openPx
    + ' vsOpen=' + (vs == null ? 'n/a' : vs.toFixed(6));
}

function premarketStatusLine(samples) {
  const values = (samples || []).filter(value => Number.isFinite(value));
  if (!values.length) return 'US pre vs open avg=n/a n=0';
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return 'US pre vs open avg=' + avg.toFixed(6) + ' n=' + values.length;
}

function noteOfficialOpen(samples, row, openPx) {
  const open = Number(openPx);
  if (!row || !(open > 0) || Number(row.officialOpen) > 0) return null;
  row.officialOpen = open;
  const fill = Number(row.premarketFillPx) > 0 ? Number(row.premarketFillPx) : Number(row.ibAvgFill);
  const vs = fillVsOpen(fill, open);
  if (vs != null) samples.push(vs);
  return {
    entryLine: premarketFillLog({
      ticker: row.ticker,
      preFillPx: row.premarketFillPx,
      preFillAt: row.premarketFillAt,
      openPx: open,
      fillPx: fill,
    }),
    statusLine: premarketStatusLine(samples),
    vs,
  };
}

function usWorkingPendingNotional(row) {
  if (!row || row.closed === true) return null;
  const tracked = row.usPremarketEntry === true || row.entryStyle === 'LMT-PRE';
  if (!tracked || !isUsSetupBookBuy(row)) return null;
  const setup = Number(row.setupNotionalUsd);
  const sized = Number(row.riskSizing && row.riskSizing.notionalUsd);
  const amount = setup > 0 ? setup : (sized > 0 ? sized : 0);
  if (!(amount > 0) || row.parentId == null) return 0;
  const total = Number(row.qtyTotal) || 0;
  const filled = Number(row.qtyFilled) || 0;
  if (!(total > 0)) return row.entryFilled === true ? 0 : amount;
  const remain = Math.max(0, total - filled);
  if (!(remain > 0)) return 0;
  return amount * (remain / total);
}

function openReplacement(qty) {
  return { ...US_OPEN_ORDER, action: 'BUY', totalQuantity: qty };
}

/**
 * Walk one US setup-book buy through pre-market prints and the 09:25 NY handoff.
 * opts.prints: [{ at, px, qty }]
 */
function simulateUsSetupBuy(evt, opts) {
  const qty = Number(opts.qty);
  const atr = Number(opts.atr);
  const lot = Number(opts.lot) || 1;
  const openPx = Number(opts.openPx);
  const order = usSetupParentSpec(evt, qty, opts.placeAt);
  const gateAt = opts.gateAt != null ? opts.gateAt : opts.handoffAt;
  if (gateAt != null) {
    const blocked = entryReleaseBlock(evt, gateAt);
    if (blocked) {
      return { blocked, order, filled: 0, children: null, openOrder: null };
    }
  }
  let filled = 0;
  let notional = 0;
  let preQty = 0;
  let preNotional = 0;
  let preFillAt = null;
  for (const print of opts.prints || []) {
    if (!order || order.entryStyle !== 'LMT-PRE') break;
    if (usPremarketParentDecision(print.at) !== 'limit') break;
    const room = qty - filled;
    const take = Math.min(room, Number(print.qty) > 0 ? Number(print.qty) : room);
    if (!(take > 0) || !limitFillsBuy(order.lmtPrice, print.px)) continue;
    filled += take;
    notional += take * Number(print.px);
    preQty += take;
    preNotional += take * Number(print.px);
    preFillAt = new Date(print.at).toISOString();
  }
  const preFillPx = preQty > 0 ? preNotional / preQty : null;
  const childrenAfterPartial = preQty > 0 && preQty < qty
    ? childrenForFilledQty(evt.setupId, preQty, preFillPx, atr, lot)
    : null;
  let openOrder = null;
  if (filled < qty && opts.handoffAt != null && usPremarketParentDecision(opts.handoffAt) === 'open') {
    const remainder = qty - filled;
    openOrder = openReplacement(remainder);
    if (openPx > 0) {
      filled += remainder;
      notional += remainder * openPx;
    }
  }
  const avg = filled > 0 ? notional / filled : null;
  const children = filled > 0 ? childrenForFilledQty(evt.setupId, filled, avg, atr, lot) : null;
  const vs = avg != null && openPx > 0 ? fillVsOpen(avg, openPx) : null;
  const outsideStopped = children ? stopTriggered(children.stop, opts.outsidePrint) : false;
  const rthStopped = children && opts.rthPrint ? stopTriggered(children.stop, opts.rthPrint) : false;
  return {
    blocked: null,
    order,
    openOrder,
    filled,
    preFillPx,
    preFillAt,
    avg,
    vsOpen: vs,
    childrenAfterPartial,
    children,
    outsideStopped,
    rthStopped,
    entryLine: premarketFillLog({
      ticker: evt.ticker,
      preFillPx,
      preFillAt,
      openPx,
      fillPx: avg,
    }),
  };
}

module.exports = {
  US_OPEN_ORDER,
  nyClock,
  isUsSetupBookBuy,
  usPremarketParentDecision,
  usSetupParentSpec,
  childrenForFilledQty,
  stopTriggered,
  fillVsOpen,
  premarketFillLog,
  premarketStatusLine,
  noteOfficialOpen,
  usWorkingPendingNotional,
  openReplacement,
  simulateUsSetupBuy,
};
