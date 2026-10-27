'use strict';

/**
 * Turn-of-month incubation books (docs/incubation-tier.md).
 *
 * Rule (F12-A, variant −1..+3): long from the close of the last trading day
 * of the month, executed at the open of the first session of the new month,
 * to the close of trading day +3. One ETF per book, $10,000 per position,
 * buys only, no stop. Entry and exit reuse the momentum no-stop order path
 * (noStop + momentumOpen → LSE LMT-OPEN / SEHK OPG; exit → server
 * setup-time-exit, flattened by the bridge).
 *
 * Exit timing: the exit event is emitted on day +3 once the market is within
 * EXIT_WINDOW_MINUTES of its close (the bridge polls every few minutes), so
 * the live exit prints in the closing window rather than exactly at the
 * close print the backtest used. If a poll is missed, the exit is emitted on
 * the next poll and marked `late`.
 */

const { isAfterDailyRecommendationRelease } = require('../schedule/entry-release');
const incubation = require('./incubation-tier');
const momentum = require('./momentum-book');

const EXIT_WINDOW_MINUTES = 20;

const SESSION = Object.freeze({
  UK: { timeZone: 'Europe/London', closeMinutes: 16 * 60 + 30 },
  'Hong Kong': { timeZone: 'Asia/Hong_Kong', closeMinutes: 16 * 60 },
});

const BOOKS = Object.freeze(Object.fromEntries(
  Object.values(incubation.INCUBATION_BOOKS)
    .filter(book => book.kind === 'tom')
    .map(book => [book.id, book]),
));

function zoned(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const value = type => parts.find(part => part.type === type)?.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

function barDate(bar) {
  if (bar?.date) return String(bar.date).slice(0, 10);
  const stamp = Number(bar?.t);
  if (!(stamp > 0)) return null;
  return new Date(stamp > 1e12 ? stamp : stamp * 1000).toISOString().slice(0, 10);
}

function barClose(bar) {
  const close = Number(bar?.c ?? bar?.close);
  return close > 0 ? close : null;
}

function sessionDates(bars) {
  return (bars || []).map(barDate).filter(Boolean);
}

/** First session of a new month: previous session belongs to another month. */
function isFirstSessionOfMonth(dates, today) {
  return momentum.batchDue(dates, today, false);
}

/**
 * Date of trading day +holdTo counting the entry session as +1, from the
 * calendar; sessions after the last known bar are extended by weekdays.
 */
function exitSessionDate(dates, entryDate, holdTo) {
  const need = Math.max(1, Number(holdTo) || 3);
  const sessions = (dates || []).filter(date => date > entryDate);
  sessions.unshift(entryDate); // the entry session is day +1 whether or not its bar exists yet
  if (sessions.length >= need) return sessions[need - 1];
  let cursor = sessions[sessions.length - 1];
  let count = sessions.length;
  const day = new Date(`${cursor}T00:00:00Z`);
  while (count < need) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    count += 1;
    cursor = day.toISOString().slice(0, 10);
  }
  return cursor;
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

function exitEvent(book, sleeve, late) {
  return {
    action: 'sell',
    accept: { setupId: book.id, month: sleeve.month, exitKey: sleeve.key },
    event: {
      type: 'exit',
      key: sleeve.key,
      ticker: sleeve.ticker,
      hz: 'short',
      side: 'buy',
      setupId: book.id,
      setupTimeExit: true,
      status: 'time_limit',
      reason: `setup-time-exit tom-window-complete${late ? ' late' : ''}`,
      momentumHoldExit: true,
      incubation: true,
    },
  };
}

async function planTomBatch({ now = new Date(), held = [], loadBars, dryRun = false } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const released = isAfterDailyRecommendationRelease(nowMs);
  const heldSet = new Set((held || []).map(ticker => String(ticker).toUpperCase()));
  const state = momentum.readState();
  const orders = [];
  const books = [];
  for (const book of Object.values(BOOKS)) {
    const session = SESSION[book.market];
    const local = zoned(nowMs, session.timeZone);
    const today = local.date;
    const month = today.slice(0, 7);
    const row = momentum.bookState(state, book.id);
    const gate = incubation.incubationCanEmit(book.id);
    const summary = {
      id: book.id,
      market: book.market,
      ticker: book.ticker,
      benchmark: book.benchmark,
      variant: `${book.holdFrom}..+${book.holdTo}`,
      tier: incubation.INCUBATION_LABEL,
      ticketUsd: incubation.INCUBATION_TICKET_USD,
      eligible: gate.eligibility.eligible,
      enabled: incubation.incubationEnabled(book.id),
      localDate: today,
      month,
      action: 'idle',
    };
    if (!gate.allowed) summary.gate = { reason: gate.reason, detail: gate.detail };
    let bars = null;
    try { bars = await loadBars(book.ticker); } catch (error) { summary.error = error.message; }
    const dates = sessionDates(bars);
    if (!dates.length) {
      summary.action = 'no-price-history';
      books.push(summary);
      continue;
    }
    // Exits first: any open sleeve whose +holdTo session is today (closing
    // window) or already past.
    const open = (row.entries || []).filter(sleeve => sleeve && !sleeve.exited);
    for (const sleeve of open) {
      const due = sleeve.exitDue || exitSessionDate(dates, sleeve.entryDate, book.holdTo);
      sleeve.exitDue = due;
      const inWindow = today === due && local.minutes >= session.closeMinutes - EXIT_WINDOW_MINUTES;
      const late = today > due;
      if (inWindow || late) {
        orders.push(exitEvent(book, sleeve, late));
        heldSet.delete(String(sleeve.ticker).toUpperCase());
        summary.action = 'exit';
        summary.exit = { key: sleeve.key, due, late };
      } else {
        summary.openSleeve = { key: sleeve.key, entryDate: sleeve.entryDate, exitDue: due };
      }
    }
    const monthRan = (row.monthsRun || []).includes(month);
    if (!released || monthRan || !isFirstSessionOfMonth(dates, today)) {
      if (summary.action === 'idle') {
        summary.action = !released ? 'before-sgt-release' : (monthRan ? 'already-ran' : 'not-entry-day');
      }
      books.push(summary);
      continue;
    }
    if (row.paused) {
      summary.action = 'paused';
      summary.reason = row.paused.reason;
      books.push(summary);
      continue;
    }
    if (heldSet.has(book.ticker.toUpperCase()) || open.some(sleeve => sleeve.ticker === book.ticker)) {
      summary.action = 'already-held';
      books.push(summary);
      continue;
    }
    const entry = latestClose(bars, today);
    if (!(entry > 0)) {
      summary.action = 'no-entry-price';
      books.push(summary);
      continue;
    }
    const exitDue = exitSessionDate(dates, today, book.holdTo);
    summary.candidate = { ticker: book.ticker, entry, entryDate: today, exitDue };
    if (summary.gate) {
      summary.action = summary.gate.reason;
      books.push(summary);
      continue;
    }
    const key = `${book.ticker}|long|${today}`;
    heldSet.add(book.ticker.toUpperCase());
    orders.push({
      action: 'buy',
      accept: {
        setupId: book.id,
        month,
        entry: { month, ticker: book.ticker, entry, entryDate: today, exitDue, key },
      },
      event: {
        type: 'entry',
        key,
        ticker: book.ticker,
        hz: 'short',
        side: 'buy',
        entry,
        sl: null,
        noStop: true,
        momentumOpen: true,
        forceOpg: true,
        setupId: book.id,
        setupTag: `SETUP_BOOK:${book.id}`,
        ledgerNamespace: `SETUP_BOOK:${book.id}`,
        experimentalLabel: incubation.INCUBATION_LABEL,
        incubation: true,
        setupNotionalUsd: incubation.INCUBATION_TICKET_USD,
        benchmark: book.benchmark,
        entryDate: today,
        exitDue,
        t: new Date().toISOString(),
        reason: 'tom-month-open',
      },
    });
    summary.action = 'buy';
    books.push(summary);
  }
  if (!dryRun && orders.length) momentum.writeState(state);
  return { ok: true, orders, books, dryRun: dryRun === true, wrote: dryRun !== true && orders.length > 0 };
}

module.exports = {
  BOOKS,
  SESSION,
  EXIT_WINDOW_MINUTES,
  exitSessionDate,
  isFirstSessionOfMonth,
  planTomBatch,
};
