'use strict';

const { fifoLotEconomics } = require('./fifo-lots');

const MOVE_UNREAL_USD = 250;
const MOVE_REAL_USD = 100;
const MOVER_MIN_USD = 5;
const FX_TO_USD = Object.freeze({
  USD: 1, HKD: 1 / 7.8, JPY: 1 / 150, EUR: 1.1, GBP: 1.27, CHF: 1.15, CNH: 0.14
});

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

function sgtYmd(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(ms));
}

function sgtStartMs(ymd) {
  return Date.parse(String(ymd) + 'T00:00:00+08:00');
}

function fmtSgt(iso) {
  const ms = Date.parse(iso || 0);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(ms));
}

function moneyUsd(n) {
  const x = Math.round(Number(n) || 0);
  if (x === 0) return '$0';
  return (x > 0 ? '+' : '−') + '$' + Math.abs(x).toLocaleString('en-US');
}

function periodStarts(nowMs = Date.now()) {
  const ymd = sgtYmd(nowMs);
  const [y, m] = ymd.split('-');
  const dayStart = sgtStartMs(ymd);
  const dow = new Date(ymd + 'T12:00:00+08:00').getUTCDay();
  const mondayBack = dow === 0 ? 6 : dow - 1;
  const weekFrom = dayStart - mondayBack * 86400000;
  const weekYmd = sgtYmd(weekFrom);
  const monthFrom = sgtStartMs(y + '-' + m + '-01');
  const prevMonth = Number(m) === 1
    ? { y: String(Number(y) - 1), m: '12' }
    : { y, m: String(Number(m) - 1).padStart(2, '0') };
  return {
    day: {
      key: 'day', label: 'Today', fromMs: dayStart, toMs: nowMs,
      lastFromMs: dayStart - 86400000, lastToMs: dayStart, lastLabel: 'yesterday'
    },
    week: {
      key: 'week', label: 'This week', fromMs: sgtStartMs(weekYmd), toMs: nowMs,
      lastFromMs: weekFrom - 7 * 86400000, lastToMs: weekFrom, lastLabel: 'last week'
    },
    month: {
      key: 'month', label: 'This month', fromMs: monthFrom, toMs: nowMs,
      lastFromMs: sgtStartMs(prevMonth.y + '-' + prevMonth.m + '-01'),
      lastToMs: monthFrom, lastLabel: 'last month'
    }
  };
}

function pickBaseline(snaps, fromMs) {
  const list = (snaps || []).filter((s) => s && s.at);
  if (!list.length) return { snap: null, partial: true };
  let before = null;
  let firstIn = null;
  for (const s of list) {
    const t = Date.parse(s.at);
    if (!Number.isFinite(t)) continue;
    if (t < fromMs) before = s;
    else if (!firstIn) firstIn = s;
  }
  if (before) return { snap: before, partial: false };
  return { snap: firstIn || list[0], partial: true };
}

function pickSnapAtOrBefore(snaps, ms) {
  let hit = null;
  for (const s of snaps || []) {
    const t = Date.parse(s && s.at || 0);
    if (Number.isFinite(t) && t <= ms) hit = s;
  }
  return hit;
}

function moverSentence(row) {
  const u = Number(row && row.dUnrealUsd) || 0;
  const r = Number(row && row.dRealUsd) || 0;
  const tk = String((row && row.ticker) || '');
  if (row.reason === 'closed') {
    if (Math.abs(r) >= 0.5) return tk + ' closed and booked ' + moneyUsd(r);
    return tk + ' closed' + (Math.abs(u) >= 0.5 ? ' (' + moneyUsd(u) + ' came off open MTM)' : '');
  }
  if (row.reason === 'new') {
    return tk + ' opened' + (Math.abs(u) >= 0.5 ? ' and is ' + moneyUsd(u) + ' vs entry' : '');
  }
  if (row.reason === 'qty') {
    const bits = [tk + ' size changed'];
    if (Math.abs(r) >= 0.5) bits.push('booked ' + moneyUsd(r));
    if (Math.abs(u) >= 0.5) bits.push('MTM ' + moneyUsd(u));
    return bits.join(', ');
  }
  if (Math.abs(r) >= 0.5 && Math.abs(u) < 0.5) return tk + ' booked ' + moneyUsd(r);
  if (Math.abs(r) >= 0.5) return tk + ' marked ' + moneyUsd(u) + ' and booked ' + moneyUsd(r);
  return tk + ' marked ' + moneyUsd(u);
}

function splitContributors(rows, minUsd = MOVER_MIN_USD) {
  const realisedHelped = [];
  const realisedHurt = [];
  const unrealisedHelped = [];
  const unrealisedHurt = [];
  for (const r of rows || []) {
    const dR = Number(r.dRealUsd) || 0;
    const dU = Number(r.dUnrealUsd) || 0;
    const tk = String(r.ticker || '');
    if (dR >= minUsd) realisedHelped.push({ ticker: tk, usd: +dR.toFixed(2), text: tk + ' booked ' + moneyUsd(dR) });
    if (dR <= -minUsd) realisedHurt.push({ ticker: tk, usd: +dR.toFixed(2), text: tk + ' booked ' + moneyUsd(dR) });
    if (dU >= minUsd) unrealisedHelped.push({ ticker: tk, usd: +dU.toFixed(2), text: tk + ' marked ' + moneyUsd(dU) });
    if (dU <= -minUsd) unrealisedHurt.push({ ticker: tk, usd: +dU.toFixed(2), text: tk + ' marked ' + moneyUsd(dU) });
  }
  const byAbs = (a, b) => Math.abs(b.usd) - Math.abs(a.usd);
  return {
    realisedHelped: realisedHelped.sort(byAbs).slice(0, 6),
    realisedHurt: realisedHurt.sort(byAbs).slice(0, 6),
    unrealisedHelped: unrealisedHelped.sort(byAbs).slice(0, 6),
    unrealisedHurt: unrealisedHurt.sort(byAbs).slice(0, 6)
  };
}

function realisedFromFills(fills, fromMs, toMs) {
  const byKey = new Map();
  for (const f of fills || []) {
    if (!f || f.errorTrade) continue;
    const key = String(f.key || '');
    const ticker = String(f.ticker || key.split('|')[0] || '').toUpperCase();
    if (!key || !ticker) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }
  const byTicker = new Map();
  for (const rows of byKey.values()) {
    const sample = rows[0] || {};
    const ticker = String(sample.ticker || '').toUpperCase();
    const ccy = String(sample.currency || 'USD').toUpperCase();
    const fx = FX_TO_USD[ccy] || 1;
    const scale = Number(sample.ccyScale) || 1;
    const dir = sample.side === 'sell' ? -1 : 1;
    let usd = 0;
    try {
      const fifo = fifoLotEconomics(rows, { dir, scale });
      for (const m of fifo.exitMatches || []) {
        const t = Date.parse(m.time || 0);
        if (!Number.isFinite(t) || t < fromMs || t >= toMs) continue;
        usd += (Number(m.realizedLocal) || 0) * fx;
      }
    } catch (_) {
      continue;
    }
    if (Math.abs(usd) < 0.5) continue;
    const cur = byTicker.get(ticker) || { ticker, dRealUsd: 0 };
    cur.dRealUsd += usd;
    byTicker.set(ticker, cur);
  }
  const rows = [...byTicker.values()]
    .map((r) => ({
      ticker: r.ticker,
      dRealUsd: +r.dRealUsd.toFixed(2),
      dUnrealUsd: 0,
      reason: 'realized'
    }))
    .sort((a, b) => Math.abs(b.dRealUsd) - Math.abs(a.dRealUsd));
  const dReal = rows.reduce((s, r) => s + r.dRealUsd, 0);
  return {
    dRealUsd: +dReal.toFixed(2),
    dUnrealUsd: 0,
    rows,
    fromFills: true,
    missingUnreal: true,
    fromAt: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
    toAt: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null
  };
}

function emptyMove(fromAt, toAt) {
  return {
    headline: '', large: false, dUnrealUsd: 0, dRealUsd: 0,
    fromAt: fromAt || null, toAt: toAt || null, rows: []
  };
}

function lastPeriodMove(snaps, spec, fills) {
  const endSnap = pickSnapAtOrBefore(snaps, spec.lastToMs);
  const start = pickBaseline(snaps, spec.lastFromMs);
  if (start.snap && endSnap && start.snap.at !== endSnap.at) {
    return Object.assign({ missing: false }, attributeMove(start.snap, endSnap));
  }
  if (fills && fills.length && spec.lastToMs > spec.lastFromMs) {
    const fromFills = realisedFromFills(fills, spec.lastFromMs, spec.lastToMs);
    if (Math.abs(fromFills.dRealUsd) >= 0.5 || fromFills.rows.length) {
      return Object.assign({ missing: false, missingUnreal: true }, fromFills);
    }
  }
  return { missing: true, dUnrealUsd: 0, dRealUsd: 0, rows: [], fromAt: null, toAt: null };
}

function mergeThisPeriod(snapMove, fillReal, hasFillLedger) {
  const snap = snapMove || emptyMove(null, null);
  const fills = fillReal || emptyMove(null, null);
  // Prefer the fill ledger for this-period realised whenever it exists.
  // Snapshot book totals start at the first snap (Mon 7 Sep), so day/week/month
  // would otherwise copy the same realised delta.
  const useFills = hasFillLedger !== false && !!fills.fromFills;
  const byTicker = new Map();
  for (const r of snap.rows || []) {
    byTicker.set(r.ticker, {
      ticker: r.ticker,
      dUnrealUsd: Number(r.dUnrealUsd) || 0,
      dRealUsd: useFills ? 0 : (Number(r.dRealUsd) || 0),
      reason: r.reason,
      mark: r.mark,
      prevMark: r.prevMark
    });
  }
  if (useFills) {
    for (const r of fills.rows || []) {
      const cur = byTicker.get(r.ticker) || {
        ticker: r.ticker, dUnrealUsd: 0, dRealUsd: 0, reason: 'realized'
      };
      cur.dRealUsd = Number(r.dRealUsd) || 0;
      if (!cur.reason || cur.reason === 'mark') cur.reason = 'realized';
      byTicker.set(r.ticker, cur);
    }
  }
  const rows = [...byTicker.values()]
    .filter((r) => Math.abs(r.dRealUsd) >= 0.5 || Math.abs(r.dUnrealUsd) >= 0.5)
    .sort((a, b) => (Math.abs(b.dRealUsd) + Math.abs(b.dUnrealUsd))
      - (Math.abs(a.dRealUsd) + Math.abs(a.dUnrealUsd)));
  return {
    headline: snap.headline,
    large: snap.large,
    dUnrealUsd: Number(snap.dUnrealUsd) || 0,
    dRealUsd: useFills ? (Number(fills.dRealUsd) || 0) : (Number(snap.dRealUsd) || 0),
    fromAt: snap.fromAt,
    toAt: snap.toAt,
    rows,
    realisedFromFills: useFills,
    realisedFromAt: useFills ? fills.fromAt : snap.fromAt,
    realisedToAt: useFills ? fills.toAt : snap.toAt,
    unrealFromAt: snap.fromAt
  };
}

function snapUnreal(snap) {
  if (!snap || !snap.totals) return null;
  const n = Number(snap.totals.unrealizedUsd);
  return Number.isFinite(n) ? +n.toFixed(2) : null;
}

function thisPeriodMove(snaps, spec, curr, fills, nowMs) {
  const base = pickBaseline(snaps, spec.fromMs);
  const snapMove = (curr && base.snap && base.snap.at !== curr.at)
    ? attributeMove(base.snap, curr)
    : emptyMove(base.snap && base.snap.at, curr && curr.at);
  const fillReal = realisedFromFills(fills, spec.fromMs, spec.toMs || nowMs);
  const hasFillLedger = Array.isArray(fills) && fills.length > 0;
  const move = mergeThisPeriod(snapMove, fillReal, hasFillLedger);
  move.unrealStartUsd = snapUnreal(base.snap);
  move.unrealNowUsd = snapUnreal(curr);
  return { move, base };
}

function periodReason(split, hideReal, hideUnreal) {
  const bits = [];
  const helpU = !hideUnreal && split.unrealisedHelped && split.unrealisedHelped[0];
  const hurtU = !hideUnreal && split.unrealisedHurt && split.unrealisedHurt[0];
  if (helpU && hurtU) {
    bits.push(helpU.ticker + ' marked ' + moneyUsd(helpU.usd)
      + ' on the open book, while ' + hurtU.ticker + ' marked ' + moneyUsd(hurtU.usd));
  } else if (hurtU) {
    bits.push(hurtU.ticker + ' marked down ' + moneyUsd(hurtU.usd) + ' on the open book');
  } else if (helpU) {
    bits.push(helpU.ticker + ' marked up ' + moneyUsd(helpU.usd) + ' on the open book');
  }
  const helpR = !hideReal && split.realisedHelped && split.realisedHelped[0];
  const hurtR = !hideReal && split.realisedHurt && split.realisedHurt[0];
  if (hurtR) bits.push(hurtR.ticker + ' booked a cash loss of ' + moneyUsd(hurtR.usd));
  if (helpR) bits.push(helpR.ticker + ' booked a cash gain of ' + moneyUsd(helpR.usd));
  if (!bits.length) return 'No single name moved the book by a material amount.';
  return bits.join('. ') + '.';
}

function vsLastSentence(thisMove, lastMove, lastLabel) {
  if (!lastMove || lastMove.missing) {
    return 'No full book snapshot for ' + lastLabel + ' yet — only this window can be scored.';
  }
  const tR = Number(thisMove && thisMove.dRealUsd) || 0;
  const lR = Number(lastMove.dRealUsd) || 0;
  const tU = Number(thisMove && thisMove.dUnrealUsd) || 0;
  const lU = Number(lastMove.dUnrealUsd) || 0;
  let s = 'Cash booked ' + lastLabel + ' was ' + moneyUsd(lR)
    + '; this window is ' + moneyUsd(tR) + ' (' + moneyUsd(tR - lR) + ').';
  if (lastMove.missingUnreal) {
    s += ' Open-book marks for ' + lastLabel + ' are not on file.';
  } else {
    s += ' Open-book marks moved ' + moneyUsd(lU) + ' ' + lastLabel
      + ' vs ' + moneyUsd(tU) + ' this window.';
  }
  return s;
}

function writePeriodNote(move, meta) {
  const label = (meta && meta.label) || 'Period';
  const partial = !!(meta && meta.partial);
  const lastMove = meta && meta.lastMove;
  const lastLabel = (meta && meta.lastLabel) || 'the prior period';
  const dU = Number(move && move.dUnrealUsd) || 0;
  const dR = Number(move && move.dRealUsd) || 0;
  const split = splitContributors((move && move.rows) || []);
  const hideUnreal = meta && meta.hideUnreal === true;
  const hideReal = meta && meta.hideReal === true;
  if (hideUnreal) {
    split.unrealisedHelped = [];
    split.unrealisedHurt = [];
  }
  if (hideReal) {
    split.realisedHelped = [];
    split.realisedHurt = [];
  }
  const movers = ((move && move.rows) || [])
    .filter((r) => Math.abs(Number(r.dUnrealUsd) || 0) >= MOVER_MIN_USD
      || Math.abs(Number(r.dRealUsd) || 0) >= MOVER_MIN_USD)
    .slice(0, 10)
    .map((r) => ({
      ticker: r.ticker,
      text: moverSentence(r),
      dUnrealUsd: r.dUnrealUsd,
      dRealUsd: r.dRealUsd,
      reason: r.reason
    }));
  const realisedSince = move && move.realisedFromAt ? fmtSgt(move.realisedFromAt) : '';
  const unrealSince = move && move.unrealFromAt ? fmtSgt(move.unrealFromAt) : (move && move.fromAt ? fmtSgt(move.fromAt) : '');
  const vsLast = vsLastSentence(move, lastMove, lastLabel);
  const windows = [];
  if (hideReal && meta && meta.realSameAs) {
    windows.push('realised fills match ' + meta.realSameAs + ' (same calendar window)');
  } else if (realisedSince) {
    windows.push('realised fills since ' + realisedSince);
  }
  if (!hideUnreal && unrealSince) {
    windows.push((partial || (move && move.realisedFromFills) ? 'unrealised marks since ' : 'unrealised since ') + unrealSince);
  } else if (hideUnreal && meta && meta.unrealSameAs) {
    windows.push('unrealised marks match ' + meta.unrealSameAs + ' (no earlier snapshot)');
  }
  const since = windows.length ? windows.join('; ') : '';
  const reason = periodReason(split, hideReal, hideUnreal);
  const startUsd = move && move.unrealStartUsd != null ? Number(move.unrealStartUsd) : null;
  const nowUsd = move && move.unrealNowUsd != null ? Number(move.unrealNowUsd) : null;
  const key = (meta && meta.key) || 'period';
  const startCaption = key === 'day'
    ? (partial ? 'First mark we have today' : 'Open-book mark at the start of today')
    : key === 'week'
      ? (partial ? 'First mark we have this week' : 'Open-book mark at Monday')
      : (partial ? 'First mark we have this month' : 'Open-book mark at month start');
  let summary;
  if (hideReal && hideUnreal) {
    summary = label + ' is the same window as ' + ((meta && meta.realSameAs) || 'the shorter period')
      + ' (week starts Monday SGT). ' + vsLast;
  } else if (!move || (Math.abs(dU) < 1 && Math.abs(dR) < 1 && !since)) {
    summary = label + ': no material PnL change. ' + vsLast;
  } else {
    const bits = [];
    if (!hideUnreal && startUsd != null && nowUsd != null) {
      bits.push('open book was ' + moneyUsd(startUsd) + ', now ' + moneyUsd(nowUsd)
        + ' (' + moneyUsd(nowUsd - startUsd) + ')');
    } else if (!hideUnreal && Math.abs(dU) >= 0.5) {
      bits.push('unrealised ' + moneyUsd(dU));
    }
    if (!hideReal && Math.abs(dR) >= 0.5) bits.push('cash booked ' + moneyUsd(dR));
    summary = label + (bits.length ? ': ' + bits.join('. ') : ': no material PnL change')
      + (since ? ' (' + since + ')' : '') + '. Why: ' + reason + ' ' + vsLast;
  }
  return {
    key,
    label,
    summary,
    reason,
    startCaption,
    nowCaption: 'Open-book mark now',
    prevCaption: lastLabel,
    unrealStartUsd: startUsd,
    unrealNowUsd: nowUsd,
    vsLast,
    partial,
    hideUnreal: hideUnreal,
    hideReal: hideReal,
    unrealSameAs: (meta && meta.unrealSameAs) || null,
    realSameAs: (meta && meta.realSameAs) || null,
    fromAt: move && move.fromAt || null,
    toAt: move && move.toAt || null,
    realisedFromAt: move && move.realisedFromAt || null,
    unrealFromAt: move && move.unrealFromAt || null,
    dUnrealUsd: +dU.toFixed(2),
    dRealUsd: +dR.toFixed(2),
    last: lastMove && !lastMove.missing ? {
      label: lastLabel,
      dUnrealUsd: lastMove.dUnrealUsd,
      dRealUsd: lastMove.dRealUsd,
      missingUnreal: !!lastMove.missingUnreal,
      fromFills: !!lastMove.fromFills
    } : { label: lastLabel, missing: true },
    movers,
    realisedHelped: split.realisedHelped,
    realisedHurt: split.realisedHurt,
    unrealisedHelped: split.unrealisedHelped,
    unrealisedHurt: split.unrealisedHurt
  };
}

function buildMoveNotes(snaps, nowMs = Date.now(), opts = {}) {
  const list = (snaps || []).filter((s) => s && s.at);
  const curr = list[list.length - 1] || null;
  const fills = (opts && opts.fills) || [];
  const starts = periodStarts(nowMs);
  const built = {};
  for (const spec of [starts.day, starts.week, starts.month]) {
    const lastMove = lastPeriodMove(list, spec, fills);
    if (!curr) {
      built[spec.key] = { spec, move: null, base: { partial: true }, lastMove };
      continue;
    }
    const { move, base } = thisPeriodMove(list, spec, curr, fills, nowMs);
    built[spec.key] = { spec, move, base, lastMove };
  }
  const unrealKey = (item) => item && item.move && item.move.unrealFromAt
    || (item && item.move && item.move.fromAt) || '';
  const dayUnreal = unrealKey(built.day);
  const weekUnreal = unrealKey(built.week);
  const monthUnreal = unrealKey(built.month);
  const dayFrom = built.day && built.day.spec && built.day.spec.fromMs;
  const weekFrom = built.week && built.week.spec && built.week.spec.fromMs;
  const periods = {};
  for (const spec of [starts.day, starts.week, starts.month]) {
    const item = built[spec.key];
    let hideUnreal = false;
    let unrealSameAs = null;
    let hideReal = false;
    let realSameAs = null;
    if (spec.key === 'week' && dayFrom != null && dayFrom === weekFrom) {
      hideReal = true;
      realSameAs = 'Today';
    }
    if (spec.key === 'week' && dayUnreal && weekUnreal === dayUnreal) {
      hideUnreal = true;
      unrealSameAs = 'Today';
    }
    if (spec.key === 'month' && monthUnreal && (monthUnreal === weekUnreal || monthUnreal === dayUnreal)) {
      hideUnreal = true;
      unrealSameAs = weekUnreal === dayUnreal ? 'Today / This week' : 'This week';
    }
    periods[spec.key] = writePeriodNote(item.move, {
      key: spec.key,
      label: spec.label,
      lastLabel: spec.lastLabel,
      partial: !!(item.base && item.base.partial),
      lastMove: item.lastMove,
      hideUnreal,
      unrealSameAs,
      hideReal,
      realSameAs
    });
  }
  const lifetime = curr ? currentAttribution(curr) : {
    headline: 'No IBKR book snapshot yet.',
    totalUnrealUsd: 0,
    drags: [],
    lifts: []
  };
  const day = periods.day;
  const week = periods.week;
  const month = periods.month;
  const topBits = [];
  if (day && day.reason) topBits.push('Daily — ' + day.reason);
  else if (day && day.summary) topBits.push(day.summary);
  if (week && !week.hideReal && week.reason) topBits.push('Weekly — ' + week.reason);
  else if (week && week.vsLast) topBits.push('Weekly — ' + week.vsLast);
  if (month && month.reason) topBits.push('Monthly — ' + month.reason);
  if (month && month.vsLast) topBits.push(month.vsLast);
  const hole = Number(lifetime.totalUnrealUsd) || 0;
  let life = 'Still-open names are ' + moneyUsd(hole) + ' vs their entry (lifetime, not today only).';
  const drag = lifetime.drags && lifetime.drags[0];
  if (drag && drag.unrealizedUsd < -50) {
    const share = hole < 0 && Math.abs(hole) > 1
      ? Math.round((Math.abs(drag.unrealizedUsd) / Math.abs(hole)) * 100)
      : 0;
    life += ' Biggest open drag: ' + drag.ticker + ' ' + moneyUsd(drag.unrealizedUsd);
    if (share >= 15) life += ' (' + share + '% of the hole)';
    life += '.';
  }
  topBits.push(life);
  return {
    summary: topBits.join(' '),
    lifetime,
    day: periods.day,
    week: periods.week,
    month: periods.month
  };
}

module.exports = {
  MOVE_UNREAL_USD,
  MOVE_REAL_USD,
  slimBook,
  attributeMove,
  currentAttribution,
  shouldRecordSnapshot,
  periodStarts,
  pickBaseline,
  writePeriodNote,
  moverSentence,
  moneyUsd,
  splitContributors,
  realisedFromFills,
  vsLastSentence,
  periodReason,
  buildMoveNotes
};
