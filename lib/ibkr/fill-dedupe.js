'use strict';

/** Keep the fill that still has a real IB commission, then the non-error copy. */
function preferIbkrFillRow(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ac = Number(a.commission) > 0;
  const bc = Number(b.commission) > 0;
  if (ac !== bc) return ac ? a : b;
  if (!!a.errorTrade !== !!b.errorTrade) return a.errorTrade ? b : a;
  return a;
}

/** One ledger row per execId. Duplicate recon-flat/SU.PA rows were summing brokerage 100×. */
function dedupeIbkrFillsByExecId(rows) {
  const out = [];
  const byId = new Map();
  for (const r of rows || []) {
    const id = String((r && r.execId) || '');
    if (!id) {
      out.push(r);
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, r);
      out.push(r);
      continue;
    }
    const prev = byId.get(id);
    const keep = preferIbkrFillRow(prev, r);
    if (keep === prev) continue;
    const idx = out.indexOf(prev);
    if (idx >= 0) out[idx] = keep;
    byId.set(id, keep);
  }
  return out;
}

module.exports = { preferIbkrFillRow, dedupeIbkrFillsByExecId };
