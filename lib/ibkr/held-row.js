'use strict';

/**
 * Decisions for a row that already has a fill. The 6501.T bug was an OPG
 * "false fill" clear at the next Japan open (parent id not in this process's
 * orderFills) followed by stale-unfilled abandon, which cancelled the stop
 * while the shares were still at IB. A closed row is then skipped forever,
 * so a later disk repair is overwritten by the in-memory closed copy.
 */

function shouldClearFalseOpgFill({
  entryFilled, entryStyle, parentFilledQty, posInDir, ibAvgFill,
} = {}) {
  if (!entryFilled) return false;
  if (String(entryStyle || '') !== 'OPG') return false;
  if (Number(parentFilledQty) > 0) return false;
  if (Number(posInDir) > 0) return false;
  if (Number(ibAvgFill) > 0) return false;
  return true;
}

function shouldAbandonStaleUnfilled({
  posInDir, ibAvgFill, ageExceeded, userReentry, keepWorking, positionsReady,
} = {}) {
  if (userReentry || keepWorking) return false;
  if (positionsReady === false) return false;
  if (Number(posInDir) > 0) return false;
  if (Number(ibAvgFill) > 0) return false;
  return !!ageExceeded;
}

function otherOpenRowOwnsConId(byKey, conId, exceptKey) {
  const cid = Number(conId) || 0;
  if (!(cid > 0)) return false;
  for (const [key, row] of Object.entries(byKey || {})) {
    if (key === exceptKey || !row || row.closed) continue;
    if (Number(row.contract && row.contract.conId) === cid) return true;
  }
  return false;
}

/**
 * Reopen a stale-abandoned row when IB still holds the shares and no other
 * open row claims the contract. Attach the live protective orders; do not
 * cancel or replace them.
 */
function planReopenAbandonedRow({ row, posInDir, otherOpenOwns, orders, conId } = {}) {
  if (!row || row.closed !== true || row.staleUnfilledAbandoned !== true) {
    return { reopen: false };
  }
  if (!(Number(posInDir) > 0)) return { reopen: false };
  if (otherOpenOwns) return { reopen: false };
  const closeAction = row.side === 'sell' ? 'BUY' : 'SELL';
  const cid = Number(conId) || Number(row.contract && row.contract.conId) || 0;
  const mine = (orders || []).filter(o => {
    if (!o) return false;
    if (cid > 0 && Number(o.conId) !== cid) return false;
    if (String(o.action || '').toUpperCase() !== closeAction) return false;
    const st = String(o.status || '');
    return st !== 'Cancelled' && st !== 'Filled' && st !== 'Inactive';
  });
  const stops = mine.filter(o => String(o.type || '').toUpperCase().includes('STP'));
  const limits = mine.filter(o => String(o.type || '').toUpperCase() === 'LMT');
  stops.sort((a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0));
  const stop = stops[0] || null;
  const tp1 = limits[0] || null;
  return {
    reopen: true,
    stopId: stop ? Number(stop.orderId) : null,
    stopClientId: stop ? (Number(stop.clientId) || null) : null,
    tp1Id: tp1 ? Number(tp1.orderId) : null,
    tp1ClientId: tp1 ? (Number(tp1.clientId) || null) : null,
  };
}

module.exports = {
  shouldClearFalseOpgFill,
  shouldAbandonStaleUnfilled,
  otherOpenRowOwnsConId,
  planReopenAbandonedRow,
};
