'use strict';

/**
 * Match exits against entries in fill order so a futures roll (close old month,
 * open next) realises the closed leg against its own entry — not a VWAP of
 * both months.
 */
function fifoLotEconomics(fills, opts) {
  opts = opts || {};
  const dir = Number(opts.dir) === -1 ? -1 : 1;
  const unitPx = typeof opts.unitPx === 'function' ? opts.unitPx : (px) => Number(px);
  const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
  const futMult = Number(opts.futMult) > 0 ? Number(opts.futMult) : 1;
  const ordered = (fills || []).slice().sort((a, b) =>
    String(a && a.time || '').localeCompare(String(b && b.time || '')));
  const inventory = [];
  const exitMatches = [];
  let entryQty = 0;
  let entryNotional = 0;
  for (const f of ordered) {
    if (!f) continue;
    const qty = Number(f.qty) || 0;
    const px = unitPx(f.price);
    if (!(qty > 0) || !(px > 0)) continue;
    if (f.role === 'entry') {
      inventory.push({ qty, price: px });
      entryQty += qty;
      entryNotional += px * qty;
      continue;
    }
    let left = qty;
    let matchedQty = 0;
    let matchedNotional = 0;
    let realized = 0;
    for (const lot of inventory) {
      if (!(left > 0)) break;
      if (!(lot.qty > 0)) continue;
      const take = Math.min(lot.qty, left);
      realized += (px - lot.price) * take * dir;
      matchedNotional += lot.price * take;
      matchedQty += take;
      lot.qty -= take;
      left -= take;
    }
    exitMatches.push({
      qty,
      price: px,
      time: f.time,
      unmatched: left,
      matchedAvg: matchedQty > 0 ? matchedNotional / matchedQty : 0,
      realizedLocal: realized / scale * futMult
    });
  }
  const openLots = inventory.filter(l => l.qty > 0);
  const openQty = openLots.reduce((s, l) => s + l.qty, 0);
  const avgOpen = openQty > 0
    ? openLots.reduce((s, l) => s + l.price * l.qty, 0) / openQty
    : 0;
  const avgAllEntries = entryQty > 0 ? entryNotional / entryQty : 0;
  return {
    entryQty,
    openQty,
    avgEntry: openQty > 0 ? avgOpen : avgAllEntries,
    realizedLocal: exitMatches.reduce((s, x) => s + x.realizedLocal, 0),
    exitMatches
  };
}

module.exports = { fifoLotEconomics };
