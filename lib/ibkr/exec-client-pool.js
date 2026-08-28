'use strict';

/**
 * IB allows one socket per client id. Order ids are unique per client, not
 * globally — cancel/modify must go back on the socket that placed the order.
 *
 * One-shots reserve 18 (flatten-all), 19 (list/flatten), 25–26 / 28–29
 * (6098 / 0883 / DHL / probes). The live manager (usually 27) is always slot 0.
 */

const RESERVED_CLIENT_IDS = Object.freeze([18, 19, 25, 26, 28, 29]);

function buildExecPoolIds(managerId, size, start) {
  const n = Math.max(1, Math.min(25, Math.floor(Number(size) || 20)));
  const mgr = Number(managerId);
  const begin = Math.max(1, Math.floor(Number(start) || 30));
  const skip = new Set(RESERVED_CLIENT_IDS);
  const ids = [mgr];
  let cand = begin;
  while (ids.length < n && cand < begin + 400) {
    if (!skip.has(cand) && cand !== mgr) ids.push(cand);
    cand++;
  }
  return ids;
}

function orderIdFloor(clientId, ibNext, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const timeFloor = Math.floor((now - Date.UTC(2025, 0, 1)) / 1000);
  const spread = timeFloor + Number(clientId) * 100000;
  return Math.max(Number(ibNext) || 1, spread);
}

function pickLeastBusy(slots, rrIndex) {
  const ready = (Array.isArray(slots) ? slots : []).filter(s => s && s.ready && s.api);
  if (!ready.length) return null;
  let bestLoad = Infinity;
  for (const s of ready) {
    const load = Number(s.inflight) || 0;
    if (load < bestLoad) bestLoad = load;
  }
  const tied = ready.filter(s => (Number(s.inflight) || 0) === bestLoad);
  const i = Math.abs(Number(rrIndex) || 0) % tied.length;
  return tied[i];
}

function rememberOrderClient(orderClients, orderId, clientId) {
  const map = orderClients && typeof orderClients === 'object' ? orderClients : {};
  const oid = Number(orderId);
  const cid = Number(clientId);
  if (oid > 0 && cid > 0) map[oid] = cid;
  return map;
}

function clientForOrder(orderId, opts) {
  const oid = Number(orderId);
  const managerId = Number(opts && opts.managerId) || 0;
  const orderClients = (opts && opts.orderClients) || {};
  if (oid > 0) {
    const mapped = orderClients[oid] != null ? orderClients[oid] : orderClients[String(oid)];
    if (Number(mapped) > 0) return Number(mapped);
  }
  const row = opts && opts.row;
  if (row && oid > 0) {
    if (row.parentId === oid && Number(row.parentClientId) > 0) return Number(row.parentClientId);
    if (row.stopId === oid && Number(row.stopClientId) > 0) return Number(row.stopClientId);
    if (row.tp1Id === oid && Number(row.tp1ClientId) > 0) return Number(row.tp1ClientId);
    if (Array.isArray(row.closeIds) && row.closeIds.includes(oid) && Number(row.placeClientId) > 0) {
      return Number(row.placeClientId);
    }
    if (Number(row.placeClientId) > 0) return Number(row.placeClientId);
  }
  return managerId;
}

function rowOwningOrder(byKey, orderId) {
  const oid = Number(orderId);
  if (!(oid > 0) || !byKey) return null;
  for (const row of Object.values(byKey)) {
    if (!row) continue;
    if (row.parentId === oid || row.stopId === oid || row.tp1Id === oid) return row;
    if (Array.isArray(row.closeIds) && row.closeIds.includes(oid)) return row;
  }
  return null;
}

async function runWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const n = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length));
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const item = list[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
}

module.exports = {
  RESERVED_CLIENT_IDS,
  buildExecPoolIds,
  orderIdFloor,
  pickLeastBusy,
  rememberOrderClient,
  clientForOrder,
  rowOwningOrder,
  runWithConcurrency
};
