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
  const weekYmd = sgtYmd(dayStart - mondayBack * 86400000);
  return {
    day: { key: 'day', label: 'Today', fromMs: dayStart },
    week: { key: 'week', label: 'This week', fromMs: sgtStartMs(weekYmd) },
    month: { key: 'month', label: 'This month', fromMs: sgtStartMs(y + '-' + m + '-01') }
  };
}

function pickBaseline(snaps, fromMs) {
  const list = (snaps || []).filter((s) => s && s.at);
  if (!list.length) return { snap: null, partial: true };
  let before = null;
  for (const s of list) {
    const t = Date.parse(s.at);
    if (Number.isFinite(t) && t < fromMs) before = s;
  }
  if (before) return { snap: before, partial: false };
  return { snap: list[0], partial: true };
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

function writePeriodNote(move, meta) {
  const label = (meta && meta.label) || 'Period';
  const partial = !!(meta && meta.partial);
  const dU = Number(move && move.dUnrealUsd) || 0;
  const dR = Number(move && move.dRealUsd) || 0;
  const movers = ((move && move.rows) || [])
    .filter((r) => Math.abs(Number(r.dUnrealUsd) || 0) >= 5 || Math.abs(Number(r.dRealUsd) || 0) >= 5)
    .slice(0, 10)
    .map((r) => ({
      ticker: r.ticker,
      text: moverSentence(r),
      dUnrealUsd: r.dUnrealUsd,
      dRealUsd: r.dRealUsd,
      reason: r.reason
    }));
  const since = move && move.fromAt
    ? (partial ? 'since first snapshot ' + fmtSgt(move.fromAt) : 'since ' + fmtSgt(move.fromAt))
    : '';
  let summary;
  if (!move || (Math.abs(dU) < 1 && Math.abs(dR) < 1)) {
    summary = label + ': no material PnL change' + (since ? ' (' + since + ')' : '') + '.';
  } else {
    const bits = [];
    if (Math.abs(dU) >= 0.5) bits.push('unrealised ' + moneyUsd(dU));
    if (Math.abs(dR) >= 0.5) bits.push('realised ' + moneyUsd(dR));
    summary = label + ' the book moved ' + bits.join(' and ') + (since ? ' (' + since + ')' : '') + '.';
    if (movers.length) summary += ' ' + movers.map((m) => m.text).join('; ') + '.';
  }
  return {
    key: (meta && meta.key) || 'period',
    label,
    summary,
    partial,
    fromAt: move && move.fromAt || null,
    toAt: move && move.toAt || null,
    dUnrealUsd: +dU.toFixed(2),
    dRealUsd: +dR.toFixed(2),
    movers
  };
}

function buildMoveNotes(snaps, nowMs = Date.now()) {
  const list = (snaps || []).filter((s) => s && s.at);
  const curr = list[list.length - 1] || null;
  const starts = periodStarts(nowMs);
  const periods = {};
  for (const spec of [starts.day, starts.week, starts.month]) {
    if (!curr) {
      periods[spec.key] = writePeriodNote(null, spec);
      continue;
    }
    const base = pickBaseline(list, spec.fromMs);
    const move = (base.snap && base.snap.at !== curr.at)
      ? attributeMove(base.snap, curr)
      : {
        headline: '',
        large: false,
        dUnrealUsd: 0,
        dRealUsd: 0,
        fromAt: base.snap && base.snap.at || null,
        toAt: curr.at,
        rows: []
      };
    periods[spec.key] = writePeriodNote(move, {
      key: spec.key,
      label: spec.label,
      partial: base.partial
    });
  }
  const lifetime = curr ? currentAttribution(curr) : {
    headline: 'No IBKR book snapshot yet.',
    totalUnrealUsd: 0,
    drags: [],
    lifts: []
  };
  const day = periods.day;
  const topBits = [];
  if (day && (Math.abs(day.dUnrealUsd) >= 1 || Math.abs(day.dRealUsd) >= 1)) {
    topBits.push(day.summary);
  } else {
    topBits.push(day && day.summary ? day.summary : 'Today: no material PnL change yet.');
  }
  const hole = Number(lifetime.totalUnrealUsd) || 0;
  let life = 'Open book is ' + moneyUsd(hole) + ' vs entry (lifetime MTM, not a 1-day move).';
  const drag = lifetime.drags && lifetime.drags[0];
  if (drag && drag.unrealizedUsd < -50) {
    const share = hole < 0 && Math.abs(hole) > 1
      ? Math.round((Math.abs(drag.unrealizedUsd) / Math.abs(hole)) * 100)
      : 0;
    life += ' Largest lifetime drag: ' + drag.ticker + ' ' + moneyUsd(drag.unrealizedUsd);
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
  buildMoveNotes
};
