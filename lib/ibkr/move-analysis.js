'use strict';

const MOVE_UNREAL_USD = 250;
const MOVE_REAL_USD = 100;

function slimName(t) {
  if (!t) return null;
  return {
    key: String(t.key || ''),
    ticker: String(t.ticker || ''),
    side: t.side === 'sell' ? 'sell' : 'buy',
    hz: t.hz || null,
    openQty: Number(t.openQty) || 0,
    avgEntry: t.avgEntry != null ? Number(t.avgEntry) : null,
    mark: t.mark != null ? Number(t.mark) : null,
    markSrc: t.markSrc || null,
    unrealizedUsd: t.unrealizedUsd != null ? Number(t.unrealizedUsd) : 0,
    realizedUsd: t.realizedUsd != null ? Number(t.realizedUsd) : 0,
    notionalUsd: t.notionalUsd != null ? Number(t.notionalUsd) : null
  };
}

function slimBook(trades, totals, extra) {
  const tt = totals || {};
  const names = (trades || [])
    .filter((t) => t && !t.errorTrade)
    .map(slimName)
    .filter((n) => n && n.ticker && (n.openQty > 0 || n.realizedUsd));
  return {
    at: (extra && extra.at) || new Date().toISOString(),
    book: (extra && extra.book) || 'paper',
    accountId: (extra && extra.accountId) || null,
    totals: {
      unrealizedUsd: Number(tt.unrealizedUsd) || 0,
      realizedUsd: Number(tt.realizedUsd) || 0,
      openCount: Number(tt.openCount) || names.filter((n) => n.openQty > 0).length
    },
    ibUnrealizedUsd: extra && extra.ibUnrealizedUsd != null ? Number(extra.ibUnrealizedUsd) : null,
    names
  };
}

function byTicker(names) {
  const map = new Map();
  for (const n of names || []) {
    const t = String(n.ticker || '').toUpperCase();
    if (!t) continue;
    const cur = map.get(t) || {
      ticker: t,
      keys: [],
      openQty: 0,
      unrealizedUsd: 0,
      realizedUsd: 0,
      notionalUsd: 0,
      mark: null,
      markSrc: null,
      avgEntry: null,
      side: n.side
    };
    cur.keys.push(n.key);
    cur.openQty += Number(n.openQty) || 0;
    cur.unrealizedUsd += Number(n.unrealizedUsd) || 0;
    cur.realizedUsd += Number(n.realizedUsd) || 0;
    cur.notionalUsd += Number(n.notionalUsd) || 0;
    if (n.mark != null) cur.mark = n.mark;
    if (n.markSrc) cur.markSrc = n.markSrc;
    if (n.avgEntry != null) cur.avgEntry = n.avgEntry;
    map.set(t, cur);
  }
  return map;
}

function reasonFor(prev, curr) {
  if (!prev && curr && curr.openQty > 0) return 'new';
  if (prev && (!curr || !(curr.openQty > 0)) && prev.openQty > 0) return 'closed';
  if (prev && curr && prev.openQty !== curr.openQty) return 'qty';
  if (prev && curr && Number(prev.mark) !== Number(curr.mark)) return 'mark';
  if (prev && curr && Number(prev.realizedUsd).toFixed(2) !== Number(curr.realizedUsd).toFixed(2)) return 'realized';
  return 'mark';
}

function attributeMove(prevBook, currBook) {
  const prev = byTicker(prevBook && prevBook.names);
  const curr = byTicker(currBook && currBook.names);
  const tickers = new Set([...prev.keys(), ...curr.keys()]);
  const rows = [];
  for (const ticker of tickers) {
    const a = prev.get(ticker);
    const b = curr.get(ticker);
    const dUnreal = (b ? b.unrealizedUsd : 0) - (a ? a.unrealizedUsd : 0);
    const dReal = (b ? b.realizedUsd : 0) - (a ? a.realizedUsd : 0);
    if (Math.abs(dUnreal) < 0.5 && Math.abs(dReal) < 0.5) continue;
    rows.push({
      ticker,
      dUnrealUsd: +dUnreal.toFixed(2),
      dRealUsd: +dReal.toFixed(2),
      unrealizedUsd: b ? +b.unrealizedUsd.toFixed(2) : 0,
      realizedUsd: b ? +b.realizedUsd.toFixed(2) : (a ? +a.realizedUsd.toFixed(2) : 0),
      openQty: b ? b.openQty : 0,
      mark: b ? b.mark : null,
      prevMark: a ? a.mark : null,
      avgEntry: b ? b.avgEntry : (a ? a.avgEntry : null),
      notionalUsd: b ? +b.notionalUsd.toFixed(2) : 0,
      reason: reasonFor(a, b)
    });
  }
  rows.sort((x, y) => Math.abs(y.dUnrealUsd) + Math.abs(y.dRealUsd) - (Math.abs(x.dUnrealUsd) + Math.abs(x.dRealUsd)));
  const dUnreal = ((currBook && currBook.totals && currBook.totals.unrealizedUsd) || 0)
    - ((prevBook && prevBook.totals && prevBook.totals.unrealizedUsd) || 0);
  const dReal = ((currBook && currBook.totals && currBook.totals.realizedUsd) || 0)
    - ((prevBook && prevBook.totals && prevBook.totals.realizedUsd) || 0);
  const top = rows[0];
  const topShare = top && Math.abs(dUnreal) > 1
    ? Math.round((Math.abs(top.dUnrealUsd) / Math.abs(dUnreal)) * 100)
    : 0;
  let headline = 'No large move since the last snapshot.';
  if (Math.abs(dUnreal) >= MOVE_UNREAL_USD || Math.abs(dReal) >= MOVE_REAL_USD) {
    const bits = [];
    if (Math.abs(dUnreal) >= 0.5) bits.push(`Unrealised ${dUnreal >= 0 ? '+' : ''}${dUnreal.toFixed(0)}`);
    if (Math.abs(dReal) >= 0.5) bits.push(`realised ${dReal >= 0 ? '+' : ''}${dReal.toFixed(0)}`);
    headline = bits.join(' · ');
    if (top) {
      headline += ` — ${top.ticker} ${top.dUnrealUsd >= 0 ? '+' : ''}${top.dUnrealUsd.toFixed(0)}`;
      if (topShare >= 20) headline += ` (${topShare}% of the unrealised swing)`;
      if (top.reason === 'new') headline += ', new position';
      else if (top.reason === 'closed') headline += ', closed / flattened';
      else if (top.reason === 'qty') headline += ', size changed';
      else headline += ', mark move';
    }
  }
  return {
    headline,
    large: Math.abs(dUnreal) >= MOVE_UNREAL_USD || Math.abs(dReal) >= MOVE_REAL_USD,
    dUnrealUsd: +dUnreal.toFixed(2),
    dRealUsd: +dReal.toFixed(2),
    fromAt: prevBook && prevBook.at || null,
    toAt: currBook && currBook.at || null,
    rows: rows.slice(0, 12)
  };
}

function currentAttribution(currBook) {
  const rows = [...byTicker(currBook && currBook.names).values()]
    .filter((n) => n.openQty > 0)
    .map((n) => ({
      ticker: n.ticker,
      unrealizedUsd: +n.unrealizedUsd.toFixed(2),
      realizedUsd: +n.realizedUsd.toFixed(2),
      openQty: n.openQty,
      mark: n.mark,
      avgEntry: n.avgEntry,
      notionalUsd: +n.notionalUsd.toFixed(2),
      markSrc: n.markSrc
    }))
    .sort((a, b) => a.unrealizedUsd - b.unrealizedUsd);
  const total = Number(currBook && currBook.totals && currBook.totals.unrealizedUsd) || 0;
  const drags = rows.filter((r) => r.unrealizedUsd < 0).slice(0, 8);
  const lifts = rows.filter((r) => r.unrealizedUsd > 0).sort((a, b) => b.unrealizedUsd - a.unrealizedUsd).slice(0, 5);
  const top = drags[0];
  const share = top && total < 0 && Math.abs(total) > 1
    ? Math.round((Math.abs(top.unrealizedUsd) / Math.abs(total)) * 100)
    : 0;
  let headline = `Open book unrealised ${total >= 0 ? '+' : ''}${total.toFixed(0)}.`;
  if (top && top.unrealizedUsd < -50) {
    headline += ` Largest drag: ${top.ticker} ${top.unrealizedUsd.toFixed(0)}`;
    if (share >= 15) headline += ` (${share}% of the hole)`;
    headline += '.';
  }
  return { headline, totalUnrealUsd: +total.toFixed(2), drags, lifts };
}

function shouldRecordSnapshot(prev, curr, minMs) {
  if (!curr) return false;
  if (!prev) return true;
  const elapsed = Date.parse(curr.at) - Date.parse(prev.at);
  if (!(elapsed >= (minMs || 60000))) return false;
  const dU = Math.abs((curr.totals.unrealizedUsd || 0) - (prev.totals.unrealizedUsd || 0));
  const dR = Math.abs((curr.totals.realizedUsd || 0) - (prev.totals.realizedUsd || 0));
  return dU >= 25 || dR >= 10;
}

module.exports = {
  MOVE_UNREAL_USD,
  MOVE_REAL_USD,
  slimBook,
  attributeMove,
  currentAttribution,
  shouldRecordSnapshot
};
