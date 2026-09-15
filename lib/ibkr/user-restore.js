'use strict';

/**
 * User-requested restore after an invented ghost-flatten (Sony 6758.T 10 Sep).
 * The re-buy is the same model lot — keep the original runner cost basis,
 * drop the ghost exit, and do not let errorTrade keep it on the Error book.
 */

function liveIbkrKey(key) {
  return String(key || '').replace(/\|cursor-err$/i, '');
}

function isCursorErrIbkrKey(key) {
  return /\|cursor-err(?:\||$)/i.test(String(key || ''));
}

function isGhostFlatFill(r) {
  if (!r || r.role === 'entry') return false;
  const recon = String(r.recon || '');
  const exec = String(r.execId || '');
  return recon === 'ghost-flat'
    || exec.startsWith('recon-flat-')
    || exec.startsWith('repair-ibflat-');
}

function restoredLiveKeys(rows) {
  const keys = new Set();
  for (const r of rows || []) {
    if (r && r.userReentry === true && r.role === 'entry' && r.key) {
      keys.add(liveIbkrKey(r.key));
    }
  }
  return keys;
}

function applyUserRestoreLedger(rows) {
  const restored = restoredLiveKeys(rows);
  const droppedExecIds = new Set();
  let dropped = 0;
  let moved = 0;
  let unstamped = 0;
  if (!restored.size) {
    return { rows: rows || [], dropped, moved, unstamped, droppedExecIds, restoredKeys: restored };
  }
  const next = [];
  for (const r of rows || []) {
    if (!r) continue;
    const live = liveIbkrKey(r.key);
    if (!restored.has(live)) {
      next.push(r);
      continue;
    }
    if (isGhostFlatFill(r)) {
      dropped++;
      if (r.execId) droppedExecIds.add(String(r.execId));
      continue;
    }
    const out = Object.assign({}, r, { userRestoreKept: true });
    if (isCursorErrIbkrKey(out.key)) {
      out.key = live;
      moved++;
    }
    if (out.errorTrade) {
      out.errorTrade = false;
      unstamped++;
    }
    next.push(out);
  }
  return { rows: next, dropped, moved, unstamped, droppedExecIds, restoredKeys: restored };
}

/**
 * Re-entry prints replace the ghosted runner; they are not a second buy.
 * Ghost flats are ignored so the original leftover lots stay open.
 */
function fifoFillsForRestoredKey(fills) {
  const list = fills || [];
  const hasReentry = list.some(f => f && f.userReentry === true && f.role === 'entry');
  const hasPrior = list.some(f => f && f.role === 'entry' && !f.userReentry);
  return list.filter(f => {
    if (!f) return false;
    if (isGhostFlatFill(f)) return false;
    if (hasReentry && hasPrior && f.userReentry === true && f.role === 'entry') return false;
    return true;
  });
}

function fillsKeepOriginalRestoreAvg(fills) {
  return (fills || []).some(f => f && (f.userReentry === true || f.userRestoreKept === true));
}

module.exports = {
  liveIbkrKey,
  isGhostFlatFill,
  restoredLiveKeys,
  applyUserRestoreLedger,
  fifoFillsForRestoredKey,
  fillsKeepOriginalRestoreAvg
};
