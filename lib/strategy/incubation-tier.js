'use strict';

/**
 * Incubation tier — rules in docs/incubation-tier.md, enforced here.
 *
 * Books in this tier are NOT validated. They carry pre-registered evidence
 * that clears a lower bar (INCUBATION_ELIGIBLE), trade a fixed small ticket,
 * sit at the lowest priority inside the shared 50-slot pool, and are reviewed
 * against their own backtest expectation after 6 months or 30 trades.
 */

const INCUBATION_TICKET_USD = 10_000;
const INCUBATION_MAX_SLOTS = 10;
const INCUBATION_LABEL = 'Incubation — not validated';
const INCUBATION_TIER = 4; // Experimental is 3; priority = tier * 10, higher sorts later.

const INCUBATION_ELIGIBILITY = Object.freeze({
  preRegistered: true,
  minNetExcessPp: 0, // strictly positive full-sample net excess
  minPositiveWindows: 3,
  windows: 4,
  minExcessT: 1.5,
  maxDrawdownPct: 50,
});

const INCUBATION_REVIEW = Object.freeze({
  months: 6,
  trades: 30,
  promoteWithinSd: 1,
  stopBeyondSd: 1,
  stopDrawdownMultiple: 1.5,
});

/**
 * Evidence rows are copied verbatim from the pre-registered research outputs
 * named in `source`. `basis` says which row gates the book: the executable
 * instrument (default) or the index proxy the family was registered on.
 */
const INCUBATION_BOOKS = Object.freeze({
  INCUBATION_UK_TOM: Object.freeze({
    id: 'INCUBATION_UK_TOM',
    kind: 'tom',
    market: 'UK',
    ticker: 'ISF.L',
    benchmark: 'ISF.L',
    currency: 'GBP',
    holdFrom: -1,
    holdTo: 3,
    maxPositions: 1,
    preRegistered: 'docs/fund-program-preregistration-2026-10-25.md (F12-A, FTSE 100 via ISF.L, −1..+3)',
    evidenceBasis: 'instrument',
    evidence: Object.freeze({
      instrument: Object.freeze({
        source: 'scripts/f12-results.json — "A TOM FTSE 100 via ISF.L (ISF.L) -1..+3"',
        sample: '2010-01-06 .. 2026-10-05',
        trades: 202,
        netExcessPp: 21.3,
        excessT: 0.91,
        positiveWindows: 3,
        maxDrawdownPct: 17.67,
        perTradeMeanPct: 0.11,
        pf: 1.191,
        winPct: 56.9,
        verdict: 'FAIL',
      }),
      index: Object.freeze({
        source: 'scripts/f12-results.json — "A TOM FTSE 100 (^FTSE) -1..+3"',
        sample: '2010-01-06 .. 2026-10-05',
        trades: 202,
        netExcessPp: 68.16,
        excessT: 2.09,
        positiveWindows: 3,
        maxDrawdownPct: 12.95,
        perTradeMeanPct: 0.28,
        pf: 1.484,
        winPct: 59.9,
        verdict: 'INCUBATION_ELIGIBLE',
      }),
    }),
  }),
  INCUBATION_HK_TOM: Object.freeze({
    id: 'INCUBATION_HK_TOM',
    kind: 'tom',
    market: 'Hong Kong',
    ticker: '2800.HK',
    benchmark: '2800.HK',
    currency: 'HKD',
    holdFrom: -1,
    holdTo: 3,
    maxPositions: 1,
    preRegistered: 'docs/fund-program-preregistration-2026-10-25.md (F12-A, Hang Seng ^HSI, −1..+3; 2800.HK itself was not a registered instrument)',
    evidenceBasis: 'instrument',
    evidence: Object.freeze({
      instrument: Object.freeze({
        source: 'scripts/score-incubation-tom.js 2026-10-27, F12-A procedure on 2800.HK from sample start (not a pre-registered instrument)',
        sample: '2010-01-06 .. 2026-10-06',
        trades: 202,
        netExcessPp: 24.62,
        excessT: 0.84,
        positiveWindows: 3,
        maxDrawdownPct: 37.2,
        perTradeMeanPct: 0.13,
        pf: 1.158,
        winPct: null,
        verdict: 'FAIL',
      }),
      index: Object.freeze({
        source: 'scripts/f12-results.json — "A TOM Hang Seng (^HSI) -1..+3"',
        sample: '2016-11-03 .. 2026-09-03',
        trades: 119,
        netExcessPp: 30.53,
        excessT: 1.16,
        positiveWindows: 3,
        maxDrawdownPct: 21.02,
        perTradeMeanPct: 0.25,
        pf: 1.314,
        winPct: 47.1,
        verdict: 'FAIL',
      }),
    }),
  }),
  INCUBATION_US_LONG_P6: Object.freeze({
    id: 'INCUBATION_US_LONG_P6',
    kind: 'momentum',
    market: 'US',
    benchmark: 'SPY',
    currency: 'USD',
    holdMonths: 6,
    k: 1,
    minPiotroski: 6,
    statementLagDays: 45,
    maxPositions: 6,
    preRegistered: 'scripts/run-momentum-rescore.js / docs/momentum-rescore-2026-10-25.md (US__long__12-1__piotroski6, variant k1)',
    evidenceBasis: 'instrument',
    evidence: Object.freeze({
      instrument: Object.freeze({
        source: 'scripts/momentum-rescore-results.json — US__long__12-1__piotroski6 k1 vs SPY',
        sample: '2014-03-03 .. 2026-10-01 (152 months)',
        trades: 147,
        netExcessPp: 965.66,
        excessT: 2.17,
        positiveWindows: 3,
        maxDrawdownPct: 28.8,
        meanMonthlyExcessPct: 0.99,
        months: 152,
        pf: 3.393,
        winPct: 63.3,
        verdict: 'INCUBATION_ELIGIBLE',
      }),
    }),
  }),
});

function isIncubationSetup(setupId) {
  return Object.prototype.hasOwnProperty.call(INCUBATION_BOOKS, String(setupId || ''));
}

function incubationBook(setupId) {
  return INCUBATION_BOOKS[String(setupId || '')] || null;
}

function gatingEvidence(book) {
  if (!book || !book.evidence) return null;
  const basis = book.evidenceBasis === 'index' ? 'index' : 'instrument';
  return { basis, row: book.evidence[basis] || null };
}

/**
 * Eligibility per docs/incubation-tier.md. Returns the failing rules by name
 * so the status page and dry-runs can show exactly why a book is gated.
 */
function incubationEligibility(setupId) {
  const book = incubationBook(setupId);
  if (!book) return { eligible: false, failReasons: ['not an incubation book'], basis: null, evidence: null };
  const gate = gatingEvidence(book);
  const row = gate && gate.row;
  const fail = [];
  if (!book.preRegistered) fail.push('not pre-registered');
  if (!row) fail.push('no evidence row');
  else {
    if (!(Number(row.netExcessPp) > INCUBATION_ELIGIBILITY.minNetExcessPp)) fail.push(`net excess ${row.netExcessPp} pp not positive`);
    if (!(Number(row.positiveWindows) >= INCUBATION_ELIGIBILITY.minPositiveWindows)) fail.push(`positive windows ${row.positiveWindows}/${INCUBATION_ELIGIBILITY.windows} < ${INCUBATION_ELIGIBILITY.minPositiveWindows}`);
    if (!(Number(row.excessT) >= INCUBATION_ELIGIBILITY.minExcessT)) fail.push(`excess t ${row.excessT} < ${INCUBATION_ELIGIBILITY.minExcessT}`);
    if (!(Number(row.maxDrawdownPct) < INCUBATION_ELIGIBILITY.maxDrawdownPct)) fail.push(`max drawdown ${row.maxDrawdownPct}% >= ${INCUBATION_ELIGIBILITY.maxDrawdownPct}%`);
  }
  return { eligible: fail.length === 0, failReasons: fail, basis: gate ? gate.basis : null, evidence: row };
}

function incubationEnabled(setupId) {
  const flag = String(process.env[`${setupId}_ENABLED`] || '').trim();
  return flag === '1';
}

/**
 * A book may emit new entries only when it is eligible AND explicitly enabled
 * by env (`<SETUP_ID>_ENABLED=1`, e.g. INCUBATION_UK_TOM_ENABLED=1). Dry-runs
 * never need the env flag.
 */
function incubationCanEmit(setupId) {
  const eligibility = incubationEligibility(setupId);
  if (!eligibility.eligible) return { allowed: false, reason: 'ineligible', detail: eligibility.failReasons.join('; '), eligibility };
  if (!incubationEnabled(setupId)) return { allowed: false, reason: 'not-enabled', detail: `${setupId}_ENABLED is not 1`, eligibility };
  return { allowed: true, eligibility };
}

function setupTicketUsd(setupId, defaultTicketUsd) {
  return isIncubationSetup(setupId) ? INCUBATION_TICKET_USD : defaultTicketUsd;
}

function occupiesSlot(row) {
  if (!row || row.closed === true) return false;
  return row.entryFilled === true || row.parentId != null;
}

/** Count of pool slots held by incubation books (any of them). */
function incubationSlotUsage(openRows) {
  let used = 0;
  const byBook = {};
  for (const row of openRows || []) {
    if (!occupiesSlot(row) || !isIncubationSetup(row.setupId)) continue;
    used += 1;
    byBook[row.setupId] = (byBook[row.setupId] || 0) + 1;
  }
  return { used, max: INCUBATION_MAX_SLOTS, free: Math.max(0, INCUBATION_MAX_SLOTS - used), byBook };
}

function evaluateIncubationSlots(setupId, openRows) {
  if (!isIncubationSetup(setupId)) return { applied: false, allowed: true };
  const usage = incubationSlotUsage(openRows);
  if (usage.used >= INCUBATION_MAX_SLOTS) {
    return { applied: true, allowed: false, reason: 'capacity', detail: 'incubation-slots', usage };
  }
  return { applied: true, allowed: true, usage };
}

/**
 * Review at 6 months or 30 closed trades (whichever first).
 *   promote: live excess positive and within 1 SD of the backtest expectation
 *   stop:    live excess more than 1 SD below expectation, or live drawdown
 *            deeper than 1.5x the backtest max drawdown
 *   continue: review not yet due
 * Backtest expectation and SD are scaled to the live sample: per-trade mean
 * and SD (SD = mean * sqrt(n) / t) for trade-based books, monthly for the
 * momentum book.
 */
function backtestExpectation(setupId, { trades = 0, months = 0 } = {}) {
  const book = incubationBook(setupId);
  const row = gatingEvidence(book)?.row;
  if (!row) return null;
  if (row.meanMonthlyExcessPct != null && row.months) {
    const mean = Number(row.meanMonthlyExcessPct);
    const sd = Math.abs(mean) * Math.sqrt(Number(row.months)) / Math.abs(Number(row.excessT) || 1e-9);
    const n = Math.max(1, Number(months) || 0);
    return { unit: 'months', n, expectedExcessPct: +(mean * n).toFixed(2), sdPct: +(sd * Math.sqrt(n)).toFixed(2) };
  }
  const mean = Number(row.perTradeMeanPct);
  const sd = Math.abs(mean) * Math.sqrt(Number(row.trades)) / Math.abs(Number(row.excessT) || 1e-9);
  const n = Math.max(1, Number(trades) || 0);
  return { unit: 'trades', n, expectedExcessPct: +(mean * n).toFixed(2), sdPct: +(sd * Math.sqrt(n)).toFixed(2) };
}

function incubationReview(setupId, live = {}) {
  const book = incubationBook(setupId);
  const row = gatingEvidence(book)?.row;
  if (!book || !row) return { due: false, decision: 'unknown-book' };
  const trades = Number(live.closedTrades) || 0;
  const months = Number(live.monthsLive) || 0;
  const due = months >= INCUBATION_REVIEW.months || trades >= INCUBATION_REVIEW.trades;
  const expectation = backtestExpectation(setupId, { trades, months });
  const liveExcess = Number(live.liveExcessPct);
  const liveDd = Number(live.liveMaxDrawdownPct);
  const ddLimit = +(Number(row.maxDrawdownPct) * INCUBATION_REVIEW.stopDrawdownMultiple).toFixed(2);
  const base = { due, trades, months, expectation, drawdownLimitPct: ddLimit };
  if (Number.isFinite(liveDd) && liveDd > ddLimit) {
    return { ...base, decision: 'stop', reason: `live drawdown ${liveDd}% > ${INCUBATION_REVIEW.stopDrawdownMultiple}x backtest max DD (${ddLimit}%)` };
  }
  if (!due) return { ...base, decision: 'continue', reason: `review at ${INCUBATION_REVIEW.months} months or ${INCUBATION_REVIEW.trades} trades` };
  if (!Number.isFinite(liveExcess) || !expectation) return { ...base, decision: 'review-needs-live-excess', reason: 'live excess vs benchmark not supplied' };
  const gap = liveExcess - expectation.expectedExcessPct;
  if (gap < -INCUBATION_REVIEW.stopBeyondSd * expectation.sdPct) {
    return { ...base, decision: 'stop', reason: `live excess ${liveExcess}% is more than ${INCUBATION_REVIEW.stopBeyondSd} SD (${expectation.sdPct}%) below expectation ${expectation.expectedExcessPct}%` };
  }
  if (liveExcess > 0 && Math.abs(gap) <= INCUBATION_REVIEW.promoteWithinSd * expectation.sdPct) {
    return { ...base, decision: 'promote', reason: `live excess ${liveExcess}% positive and within ${INCUBATION_REVIEW.promoteWithinSd} SD of expectation ${expectation.expectedExcessPct}% (SD ${expectation.sdPct}%)` };
  }
  return { ...base, decision: 'hold', reason: liveExcess <= 0 ? 'live excess not positive; not more than 1 SD worse — hold and re-review' : 'live excess more than 1 SD above expectation — hold, check for data/tag errors before promoting' };
}

module.exports = {
  INCUBATION_TICKET_USD,
  INCUBATION_MAX_SLOTS,
  INCUBATION_LABEL,
  INCUBATION_TIER,
  INCUBATION_ELIGIBILITY,
  INCUBATION_REVIEW,
  INCUBATION_BOOKS,
  isIncubationSetup,
  incubationBook,
  incubationEligibility,
  incubationEnabled,
  incubationCanEmit,
  setupTicketUsd,
  incubationSlotUsage,
  evaluateIncubationSlots,
  backtestExpectation,
  incubationReview,
};
