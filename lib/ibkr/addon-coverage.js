'use strict';

/** One-shot client that placed the weekend addon stops. Not an exec-pool id. */
const ADDON_CLIENT_ID = 93;

function isAddonOrder(row, orderId) {
  const id = Number(orderId);
  if (!(id > 0) || !row) return false;
  return id === Number(row.addonStopId) || id === Number(row.addonTp1Id);
}

/**
 * Qty the primary stop is allowed to become. While an addon stop is working,
 * this is position minus addon — never the full position.
 */
function primaryStopTargetQty({ positionQty, addonStopQty } = {}) {
  const pos = Math.max(0, Number(positionQty) || 0);
  const addon = Math.max(0, Number(addonStopQty) || 0);
  if (!(addon > 0)) return pos;
  return Math.max(0, +(pos - addon).toFixed(8));
}

function refusePrimaryEnlarge({ currentQty, targetQty, addonStopQty } = {}) {
  return Number(addonStopQty) > 0
    && Number(targetQty) > Number(currentQty) + 1e-6;
}

/**
 * Remember a client-93 stop/target that is not already the primary child.
 * Does not cancel or resize anything.
 */
function adoptAddonIds(row, stops, targets) {
  const changed = { stop: false, tp1: false };
  if (!row) return changed;
  if (!(Number(row.addonStopId) > 0)) {
    const extra = (stops || []).find(o =>
      Number(o.clientId) === ADDON_CLIENT_ID
      && Number(o.orderId) !== Number(row.stopId)
      && Number(o.orderId) > 0);
    if (extra) {
      row.addonStopId = Number(extra.orderId);
      row.addonStopClientId = ADDON_CLIENT_ID;
      changed.stop = true;
    }
  }
  if (!(Number(row.addonTp1Id) > 0)) {
    const extra = (targets || []).find(o =>
      Number(o.clientId) === ADDON_CLIENT_ID
      && Number(o.orderId) !== Number(row.tp1Id)
      && Number(o.orderId) > 0);
    if (extra) {
      row.addonTp1Id = Number(extra.orderId);
      row.addonTp1ClientId = ADDON_CLIENT_ID;
      changed.tp1 = true;
    }
  }
  return changed;
}

/**
 * After a TP1 fill, drop the addon stop and size the runner stop to whatever
 * shares remain. The two must not both stay live.
 */
function foldAddonOnTp1({ positionRemaining, addonStopQty } = {}) {
  const remain = Math.max(0, Number(positionRemaining) || 0);
  const addon = Math.max(0, Number(addonStopQty) || 0);
  return {
    cancelAddon: addon > 0,
    primaryStopQty: remain,
  };
}

/** New pair only. Never revise ocaType on an order IB has already accepted. */
function addonOcaSpec(key) {
  const slug = String(key || 'row').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { ocaGroup: 'AS-addon-' + slug, ocaType: 2 };
}

function workingStopQty(stops) {
  return (stops || []).reduce((sum, o) => sum + (Number(o && o.qty) || 0), 0);
}

module.exports = {
  ADDON_CLIENT_ID,
  isAddonOrder,
  primaryStopTargetQty,
  refusePrimaryEnlarge,
  adoptAddonIds,
  foldAddonOnTp1,
  addonOcaSpec,
  workingStopQty,
};
