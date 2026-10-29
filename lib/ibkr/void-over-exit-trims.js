'use strict';

/**
 * Drop synthetic qty-trim exits that closed inventory later covered by real
 * IB fills (SHEL.L 13 Oct runner trim vs 29 Oct TP2; SU.PA 19 Oct trim vs stop).
 *
 * Pure: returns { rows, dropped } without mutating the input array.
 */

function isQtyTrimFill(r) {
  if (!r) return false;
  const recon = String(r.recon || '');
  const exec = String(r.execId || '');
  return recon === 'qty-trim' || exec.startsWith('recon-trim-');
}

function isGenuineExitFill(r, isGenuineIbExecFill) {
  if (!r || r.role === 'entry') return false;
  if (typeof isGenuineIbExecFill === 'function') return isGenuineIbExecFill(r);
  if (r.synthetic === true) return false;
  if (isQtyTrimFill(r)) return false;
  const exec = String(r.execId || '');
  if (!exec) return false;
  return !/^(recon-|recover-entry-|repair-ibflat-|cursor-err-|ibhist-|synth-)/.test(exec);
}

function voidOverExitQtyTrims(rows, opts) {
  opts = opts || {};
  const isGenuine = opts.isGenuineIbExecFill;
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || !r.key) continue;
    const key = String(r.key);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ r, i });
  }

  const dropIdx = new Set();
  for (const [, items] of byKey) {
    let entryQty = 0;
    let genuineExitQty = 0;
    const trims = [];
    for (const item of items) {
      const q = Number(item.r.qty) || 0;
      if (!(q > 0)) continue;
      if (item.r.role === 'entry') entryQty += q;
      else if (isQtyTrimFill(item.r)) trims.push(item);
      else if (isGenuineExitFill(item.r, isGenuine)) genuineExitQty += q;
    }
    if (!trims.length || !(entryQty > 0)) continue;
    // Real broker exits already cover the lot — any qty-trim is phantom.
    if (genuineExitQty + 1e-9 >= entryQty) {
      for (const t of trims) dropIdx.add(t.i);
      continue;
    }
    // Partial: drop newest trims until exit qty no longer exceeds entry.
    let exitQty = genuineExitQty;
    for (const t of trims) exitQty += Number(t.r.qty) || 0;
    if (!(exitQty > entryQty + 1e-9)) continue;
    const ordered = trims.slice().sort((a, b) =>
      String(b.r.time || '').localeCompare(String(a.r.time || '')));
    let excess = exitQty - entryQty;
    for (const t of ordered) {
      if (!(excess > 1e-9)) break;
      dropIdx.add(t.i);
      excess -= Number(t.r.qty) || 0;
    }
  }

  if (!dropIdx.size) return { rows: list, dropped: [] };
  const dropped = [];
  const next = [];
  for (let i = 0; i < list.length; i++) {
    if (dropIdx.has(i)) {
      dropped.push(list[i]);
      continue;
    }
    next.push(list[i]);
  }
  return { rows: next, dropped };
}

module.exports = {
  isQtyTrimFill,
  voidOverExitQtyTrims
};
