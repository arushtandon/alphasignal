'use strict';

/**
 * Audit every history Buy/Sell against the current recommendation gates.
 * Does not flatten or emit IBKR. Read-only.
 *
 * Gates: Buy/Sell action, score ≥62, conf ≥62%, RR floor (1.4 US/UK, 1.1 else),
 * US/UK Strong only, no US/UK short-horizon buys.
 */
const fs = require('fs');
const path = require('path');
const {
  isAngloSymbol,
  angloPickAllowed,
  minRrForSymbol
} = require('../lib/strategy/market-tier');

const HIST = path.join(__dirname, '..', 'data', 'history_data.json');

function sgtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return String(iso).slice(0, 10);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function rr(entry, tp1, sl, isSell) {
  const e = parseFloat(entry);
  const t = parseFloat(tp1);
  const s = parseFloat(sl);
  if (!(e > 0) || !(t > 0) || !(s > 0)) return null;
  const risk = Math.abs(e - s);
  const reward = Math.abs(t - e);
  if (!(risk > 0)) return null;
  return reward / risk;
}

function statusOf(h) {
  const hz = h.hz || 'short';
  return String(h[hz + 'Status'] || h.status || 'open').toLowerCase() || 'open';
}

function closed(st) {
  return /sl_hit|tp2|closed|stopped|exit|flatten/.test(st);
}

(function main() {
  const recs = (JSON.parse(fs.readFileSync(HIST, 'utf8')).data || []).filter((h) => {
    const a = String(h.action || '').toLowerCase();
    return a === 'buy' || a === 'sell';
  });
  const rows = recs.map((h) => {
    const hz = h.hz || 'short';
    const side = String(h.action || '').toLowerCase();
    const isSell = side === 'sell';
    const rating = h[hz + 'Rating'] || h.rating || '';
    const score = isSell
      ? Number(h[hz + 'SellScore'] || h.sellScore || 0)
      : Number(h[hz + 'Score'] || (hz === 'short' ? h.shortScore : hz === 'medium' ? h.mediumScore : h.longScore) || 0);
    const conf = Number(h[hz + 'Conf'] || h.conf || 0);
    const entry = h[hz + 'Entry'] || h.entry;
    const tp1 = h[hz + 'Target1'] || h.target1;
    const sl = h[hz + 'StopLoss'] || h.stopLoss;
    const ratio = rr(entry, tp1, sl, isSell);
    const need = minRrForSymbol(h.ticker, 1.1);
    const anglo = angloPickAllowed(h.ticker, { hz, side, rating });
    const reasons = [];
    if (side !== 'buy' && side !== 'sell') reasons.push('not Buy/Sell');
    if (!(score >= 62)) reasons.push('score ' + score + ' < 62');
    if (!(conf >= 62)) reasons.push('conf ' + conf + ' < 62');
    if (!anglo.ok) reasons.push(anglo.reason);
    if (!(ratio != null && ratio + 1e-9 >= need)) {
      reasons.push('RR ' + (ratio != null ? ratio.toFixed(2) : 'n/a') + ' < ' + need);
    }
    const book = isAngloSymbol(h.ticker)
      ? (String(h.ticker).toUpperCase().endsWith('.L') ? 'UK' : 'US')
      : (h.market || 'other');
    return {
      ticker: h.ticker,
      book,
      hz,
      side,
      rating,
      score,
      conf,
      rr: ratio != null ? +ratio.toFixed(2) : null,
      status: statusOf(h),
      day: sgtDate(h.entryDate || h.timestamp),
      pass: reasons.length === 0,
      reasons,
      executed: !closed(statusOf(h)) || closed(statusOf(h))
    };
  });

  const pass = rows.filter((r) => r.pass);
  const fail = rows.filter((r) => !r.pass);
  const byBook = {};
  for (const r of rows) {
    byBook[r.book] = byBook[r.book] || { n: 0, pass: 0 };
    byBook[r.book].n++;
    if (r.pass) byBook[r.book].pass++;
  }

  console.log('History Buy/Sell records:', rows.length);
  console.log('Would still recommend under current gates:', pass.length);
  console.log('Would not recommend:', fail.length);
  console.log('By book:', JSON.stringify(byBook));
  console.log('\n=== PASSED ===');
  pass
    .sort((a, b) => a.day.localeCompare(b.day) || a.ticker.localeCompare(b.ticker))
    .forEach((r) => {
      console.log(
        [r.day, r.ticker, r.book, r.hz, r.side, r.rating, 'sc=' + r.score, 'conf=' + r.conf, 'RR=' + r.rr, r.status].join('\t')
      );
    });
  console.log('\n=== US/UK FAILED (with reason) ===');
  fail
    .filter((r) => r.book === 'US' || r.book === 'UK')
    .sort((a, b) => a.day.localeCompare(b.day) || a.ticker.localeCompare(b.ticker))
    .forEach((r) => {
      console.log(
        [r.day, r.ticker, r.hz, r.side, r.rating, 'sc=' + r.score, 'conf=' + r.conf, 'RR=' + r.rr, r.reasons.join(' | ')].join('\t')
      );
    });
})();
