'use strict';

const fs = require('fs');
const path = require('path');
const { pauseSetup } = require('./setup-book-runtime');

function membershipAt(snapshot, date) {
  if (!snapshot?.historicalMembership?.available) return new Set(snapshot?.currentSymbols || []);
  const membership = new Set(snapshot.currentSymbols || []);
  const asOf = String(date || '').slice(0, 10);
  for (const change of snapshot.historicalMembership.changes || []) {
    if (!change.date || change.date <= asOf) continue;
    if (change.added) membership.delete(change.added);
    if (change.removed) membership.add(change.removed);
  }
  return membership;
}

const BOOKS = Object.freeze({
  UK_LONG_MOMENTUM: Object.freeze({
    id: 'UK_LONG_MOMENTUM',
    market: 'UK',
    benchmark: 'EWU',
    membershipFile: 'ftse100.json',
  }),
  FRANCE_LONG_MOMENTUM: Object.freeze({
    id: 'FRANCE_LONG_MOMENTUM',
    market: 'France',
    benchmark: 'EWQ',
    membershipFile: 'cac40.json',
  }),
});

const HOLD_MONTHS = 6;
const PAUSE_AFTER_ENTRIES = 6;
const PAUSE_GAP = 0.05;
const STATE_FILE = process.env.MOMENTUM_BOOK_STATE_FILE
  || path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'momentum-book-state.json');
const MEMBERSHIP_DIR = path.join(__dirname, '..', '..', 'data', 'research', 'index-membership');

function barDate(bar) {
  if (bar?.date) return String(bar.date).slice(0, 10);
  const stamp = Number(bar?.t);
  if (!(stamp > 0)) return null;
  const ms = stamp > 1e12 ? stamp : stamp * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function barClose(bar) {
  const close = Number(bar?.c ?? bar?.close);
  return close > 0 ? close : null;
}

function sessionDates(bars) {
  return (bars || []).map(barDate).filter(Boolean);
}

function addMonths(month, count) {
  const [year, raw] = String(month).split('-').map(Number);
  const index = year * 12 + (raw - 1) + count;
  const nextYear = Math.floor(index / 12);
  const nextMonth = index % 12 + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

function batchDue(dates, today, alreadyRan) {
  if (alreadyRan) return false;
  const prior = (dates || []).filter(date => date < today);
  const last = prior.length ? prior[prior.length - 1] : null;
  if (!last || last.slice(0, 7) === today.slice(0, 7)) return false;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const gapDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86400000;
  return gapDays >= 1 && gapDays <= 5;
}

function score12Minus1(bars, asOf) {
  const dated = [];
  for (const bar of bars || []) {
    const date = barDate(bar);
    const close = barClose(bar);
    if (date && close) dated.push({ date, close });
  }
  let at = -1;
  for (let index = 0; index < dated.length; index++) {
    if (dated[index].date <= asOf) at = index;
  }
  if (at >= 0 && dated[at].date === asOf) at -= 1;
  if (at < 252) return null;
  const end = dated[at - 21].close;
  const start = dated[at - 252].close;
  if (!(end > 0) || !(start > 0)) return null;
  return end / start - 1;
}

function rankMembers(members, seriesBySymbol, asOf) {
  const ranked = [];
  for (const symbol of members) {
    const score = score12Minus1(seriesBySymbol.get(symbol), asOf);
    if (score == null) continue;
    ranked.push({ ticker: symbol, score });
  }
  ranked.sort((left, right) => right.score - left.score || left.ticker.localeCompare(right.ticker));
  return ranked;
}

function selectEntry(ranked, held) {
  const blocked = held instanceof Set ? held : new Set(held || []);
  return ranked.find(row => !blocked.has(String(row.ticker).toUpperCase())) || null;
}

function sleevesToExit(entries, month) {
  return (entries || []).filter(row => row && row.month && addMonths(row.month, HOLD_MONTHS) <= month && !row.exited);
}

function shouldAutoPause(entryCount, bookReturn, benchmarkReturn) {
  if (!(entryCount >= PAUSE_AFTER_ENTRIES)) return false;
  if (!Number.isFinite(bookReturn) || !Number.isFinite(benchmarkReturn)) return false;
  return benchmarkReturn - bookReturn > PAUSE_GAP;
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function bookState(state, id) {
  if (!state[id]) state[id] = { monthsRun: [], entries: [], paused: null };
  return state[id];
}

function latestClose(bars, asOf) {
  let close = null;
  for (const bar of bars || []) {
    const date = barDate(bar);
    const value = barClose(bar);
    if (date && date <= asOf && value) close = value;
  }
  return close;
}

function priceOnOrAfter(bars, date) {
  for (const bar of bars || []) {
    const stamp = barDate(bar);
    const close = barClose(bar);
    if (stamp && stamp >= date && close) return close;
  }
  return null;
}

async function planMomentumBatch({ now = new Date(), held = [], loadBars } = {}) {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const heldSet = new Set((held || []).map(ticker => String(ticker).toUpperCase()));
  const state = readState();
  const orders = [];
  const books = [];
  for (const book of Object.values(BOOKS)) {
    const row = bookState(state, book.id);
    const summary = { id: book.id, market: book.market, benchmark: book.benchmark, month, action: 'idle' };
    const snapshotPath = path.join(MEMBERSHIP_DIR, book.membershipFile);
    if (!fs.existsSync(snapshotPath)) {
      summary.action = 'membership-missing';
      books.push(summary);
      continue;
    }
    const benchmarkBars = await loadBars(book.benchmark);
    const dates = sessionDates(benchmarkBars);
    if (!batchDue(dates, today, (row.monthsRun || []).includes(month))) {
      summary.action = (row.monthsRun || []).includes(month) ? 'already-ran' : 'not-batch-day';
      books.push(summary);
      continue;
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const members = [...membershipAt(snapshot, today)];
    const series = new Map();
    for (const symbol of members) {
      try { series.set(symbol, await loadBars(symbol)); }
      catch (_) { series.set(symbol, null); }
    }
    const ranked = rankMembers(members, series, today);
    if (!ranked.length) {
      summary.action = 'no-ranks';
      books.push(summary);
      continue;
    }
    const exits = sleevesToExit(row.entries, month);
    for (const sleeve of exits) {
      sleeve.exited = month;
      heldSet.delete(String(sleeve.ticker).toUpperCase());
      orders.push({
        action: 'sell',
        event: {
          type: 'exit',
          key: sleeve.key,
          ticker: sleeve.ticker,
          hz: 'long',
          side: 'buy',
          setupId: book.id,
          setupTimeExit: true,
          status: 'time_limit',
          reason: 'setup-time-exit momentum-hold-complete',
          momentumHoldExit: true,
        },
      });
    }
    const priced = (row.entries || []).filter(sleeve => sleeve.entry > 0);
    const sleeveReturns = priced.map(sleeve => {
      const mark = latestClose(series.get(sleeve.ticker), today);
      return mark ? mark / sleeve.entry - 1 : null;
    }).filter(value => value != null);
    const bookReturn = sleeveReturns.length
      ? sleeveReturns.reduce((sum, value) => sum + value, 0) / sleeveReturns.length
      : null;
    const first = priced[0];
    const benchmarkStart = first ? priceOnOrAfter(benchmarkBars, first.entryDate || `${first.month}-01`) : null;
    const benchmarkNow = latestClose(benchmarkBars, today);
    const benchmarkReturn = benchmarkStart && benchmarkNow ? benchmarkNow / benchmarkStart - 1 : null;
    summary.bookReturn = bookReturn;
    summary.benchmarkReturn = benchmarkReturn;
    summary.entries = (row.entries || []).length;
    if (shouldAutoPause((row.entries || []).length, bookReturn, benchmarkReturn)) {
      const gap = +((benchmarkReturn - bookReturn) * 100).toFixed(2);
      const reason = `${gap} points behind ${book.benchmark} after ${row.entries.length} monthly entries`;
      row.paused = { at: new Date().toISOString(), reason, bookReturn, benchmarkReturn };
      pauseSetup(book.id, reason);
      summary.action = 'paused';
      summary.reason = reason;
      row.monthsRun = [...new Set([...(row.monthsRun || []), month])];
      books.push(summary);
      continue;
    }
    if (row.paused) {
      summary.action = 'paused';
      summary.reason = row.paused.reason;
      row.monthsRun = [...new Set([...(row.monthsRun || []), month])];
      books.push(summary);
      continue;
    }
    const pick = selectEntry(ranked, heldSet);
    summary.top = ranked[0] || null;
    if (!pick) {
      summary.action = 'no-free-name';
      row.monthsRun = [...new Set([...(row.monthsRun || []), month])];
      books.push(summary);
      continue;
    }
    const entry = latestClose(series.get(pick.ticker), today);
    if (!(entry > 0)) {
      summary.action = 'no-entry-price';
      books.push(summary);
      continue;
    }
    const key = `${pick.ticker}|long|${today}`;
    row.entries.push({ month, ticker: pick.ticker, entry, entryDate: today, key });
    row.monthsRun = [...new Set([...(row.monthsRun || []), month])];
    heldSet.add(pick.ticker.toUpperCase());
    orders.push({
      action: 'buy',
      event: {
        type: 'entry',
        key,
        ticker: pick.ticker,
        hz: 'long',
        side: 'buy',
        entry,
        sl: null,
        noStop: true,
        momentumOpen: true,
        forceOpg: true,
        setupId: book.id,
        setupTag: `SETUP_BOOK:${book.id}`,
        ledgerNamespace: `SETUP_BOOK:${book.id}`,
        experimentalLabel: 'Experimental',
        benchmark: book.benchmark,
        entryDate: today,
        t: new Date().toISOString(),
        reason: 'momentum-month-open',
      },
    });
    summary.action = 'buy';
    summary.ticker = pick.ticker;
    summary.score = pick.score;
    books.push(summary);
  }
  writeState(state);
  return { ok: true, today, orders, books, liveBehaviorChanged: false };
}

module.exports = {
  BOOKS,
  HOLD_MONTHS,
  PAUSE_AFTER_ENTRIES,
  PAUSE_GAP,
  batchDue,
  score12Minus1,
  rankMembers,
  selectEntry,
  sleevesToExit,
  shouldAutoPause,
  addMonths,
  planMomentumBatch,
};
