'use strict';

/**
 * Cell strategy search: which strategy family gives the best result for the
 * market × horizon cells that have no live setup, scored under the
 * consistency-first framework (docs/cell-strategy-search-preregistration.md).
 *
 * Pure helpers only. Variants already scored by earlier frozen studies are
 * normalised into one row shape and ranked with the framework's rule:
 * CONSISTENT first, then worst all-window PF, then smaller average loss.
 */

const STUDY_ID = 'cell-strategy-search-v1';

const REQUESTED_CELLS = Object.freeze([
  { market: 'Hong Kong', horizon: 'short' },
  { market: 'UK', horizon: 'short' },
  { market: 'Germany', horizon: 'short' },
  { market: 'France', horizon: 'short' },
  { market: 'Commodities', horizon: 'short' },
  { market: 'Crypto', horizon: 'short' },
  { market: 'US', horizon: 'medium' },
  { market: 'UK', horizon: 'medium' },
  { market: 'Germany', horizon: 'medium' },
  { market: 'France', horizon: 'medium' },
  { market: 'Crypto', horizon: 'medium' },
  { market: 'US', horizon: 'long' },
  { market: 'UK', horizon: 'long' },
  { market: 'Crypto', horizon: 'long' },
]);

const ENGINE_SHORT_MARKETS = Object.freeze([
  'Hong Kong', 'UK', 'Germany', 'France', 'Commodities', 'Crypto',
]);

const MR_KIND = 'mean_reversion';

function cellKey(market, horizon) {
  return `${market}|${horizon}`;
}

function isRequested(market, horizon) {
  return REQUESTED_CELLS.some(cell => cell.market === market && cell.horizon === horizon);
}

function kindForConsistencyCell(cell) {
  if (cell.part === 'A') return MR_KIND;
  if (cell.part === 'B') return 'current_engine';
  return 'wave3_breakout';
}

function kindForBookRow(row) {
  const id = String(row.id || '');
  if (/pead|react/.test(id)) return 'earnings';
  if (/momentum|piotroski/.test(id)) return 'momentum';
  if (/worst/.test(id)) return 'weekly_reversal';
  if (/breakout/.test(id)) return 'breakout';
  if (/trend/.test(id)) return 'trend';
  return 'book';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Consistency-study cell (Part A/B/C) → unified row. */
function normalizeConsistencyCell(cell, source = 'consistency-study') {
  const windows = (cell.windows || []).map(window => ({
    fold: window.fold,
    final: window.final === true,
    from: window.range?.from || null,
    to: window.range?.to || null,
    trades: num(window.metrics?.trades) || 0,
    winRate: num(window.metrics?.winRate),
    profitFactor: num(window.metrics?.profitFactor),
    pnlUsd: num(window.metrics?.pnlUsd),
    returnPct: null,
    avgLossPct: num(window.metrics?.avgLossPct),
  }));
  const pooled = cell.pooledDevelopment || {};
  const row = {
    id: cell.id,
    source,
    kind: kindForConsistencyCell(cell),
    market: cell.market,
    horizon: cell.horizon,
    description: describeConsistencyCell(cell),
    survivorship: cell.survivorship || null,
    windows,
    pooled: {
      trades: num(pooled.trades) || 0,
      winRate: num(pooled.winRate),
      profitFactor: num(pooled.profitFactor),
      pnlUsd: num(pooled.pnlUsd),
      avgWinPct: num(pooled.avgWinPct),
      avgLossPct: num(pooled.avgLossPct),
      breakevenWinRate: num(pooled.breakevenWinRate),
      picksPerMonth: num(pooled.picksPerMonth),
    },
    sourceVerdict: cell.consistent ? 'CONSISTENT' : 'NOT_CONSISTENT',
    bhQValue: num(cell.bhQValue),
    bhPass: cell.bhPass === true,
    benchmarkBeat: null,
  };
  return finishRow(row);
}

function describeConsistencyCell(cell) {
  if (cell.part === 'A') {
    return `MR ${cell.trigger} · ${cell.regime} · ${cell.stopAtr} ATR stop · t${cell.timeStopBars} · ${cell.partial ? '50/50 partial' : 'full'}`;
  }
  if (cell.part === 'B') return `Live engine ${cell.horizon}, sector ${cell.sector ? 'on' : 'off'}`;
  return `Wave 3 breakout baseline (${cell.universe || 'US'})`;
}

/** New-strategy-types / strategy-amendment portfolio-book row → unified row. */
function normalizeBookRow(row, source) {
  const windows = (row.windows || []).map((window, index) => ({
    fold: window.fold ?? index + 1,
    final: index === (row.windows.length - 1),
    from: window.from || null,
    to: window.to || null,
    trades: num(window.trades) || 0,
    winRate: num(window.win),
    profitFactor: num(window.pf),
    pnlUsd: null,
    returnPct: num(window.returnPct),
    avgLossPct: null,
    benchmarkReturnPct: num(window.benchmarkReturnPct),
    beat: window.beat === true,
  }));
  const overall = row.overall || {};
  const out = {
    id: row.id,
    source,
    kind: kindForBookRow(row),
    market: row.market,
    horizon: row.horizon,
    description: row.strategy || row.id,
    survivorship: row.survivorship || null,
    windows,
    pooled: {
      trades: num(overall.trades ?? overall.n) || 0,
      winRate: num(overall.win),
      profitFactor: num(overall.pf),
      pnlUsd: null,
      returnPct: num(overall.returnPct),
      maxDrawdownPct: num(overall.maxDrawdownPct ?? row.maxDrawdownPct),
      avgWinPct: null,
      avgLossPct: null,
      breakevenWinRate: null,
      picksPerMonth: null,
    },
    sourceVerdict: row.verdict || null,
    sourceReason: row.reason || null,
    bhQValue: null,
    bhPass: null,
    benchmarkBeat: windows.length ? windows.filter(window => window.beat).length : null,
  };
  return finishRow(out);
}

function windowProfitable(window) {
  if (window.pnlUsd != null) return window.pnlUsd > 0;
  if (window.returnPct != null) return window.returnPct > 0;
  return false;
}

/**
 * Framework consistency rule. Mean reversion: every window profitable with
 * win rate >= 60. Everything else: every window profitable with PF >= 1.2.
 */
function consistencyVerdict(row) {
  const windows = row.windows || [];
  if (windows.length !== 4) return { consistent: false, reason: 'fewer than four scored windows' };
  for (const window of windows) {
    if (!(window.trades > 0)) return { consistent: false, reason: `window ${window.fold} has no trades` };
    if (!windowProfitable(window)) return { consistent: false, reason: `window ${window.fold} lost money` };
    if (row.kind === MR_KIND) {
      if (!(Number(window.winRate) >= 60)) {
        return { consistent: false, reason: `window ${window.fold} win rate ${window.winRate}% < 60%` };
      }
    } else if (!(Number(window.profitFactor) >= 1.2)) {
      return { consistent: false, reason: `window ${window.fold} PF ${window.profitFactor} < 1.2` };
    }
  }
  return { consistent: true, reason: null };
}

function finishRow(row) {
  const verdict = consistencyVerdict(row);
  const pfs = (row.windows || []).map(window => Number(window.profitFactor)).filter(Number.isFinite);
  const losses = (row.windows || []).map(window => Math.abs(Number(window.avgLossPct))).filter(Number.isFinite);
  return {
    ...row,
    consistent: verdict.consistent,
    failReason: verdict.reason,
    worstWindowPf: pfs.length === (row.windows || []).length && pfs.length ? +Math.min(...pfs).toFixed(3) : 0,
    averageLossMagnitude: losses.length
      ? +(losses.reduce((sum, value) => sum + value, 0) / losses.length).toFixed(3)
      : null,
    emptyWindows: (row.windows || []).filter(window => !(window.trades > 0)).length,
  };
}

/** CONSISTENT first, then worst-window PF, then smaller average loss, then id. */
function rankRows(rows) {
  return rows.slice().sort((a, b) =>
    Number(b.consistent) - Number(a.consistent)
    || Number(b.worstWindowPf) - Number(a.worstWindowPf)
    || Number(a.averageLossMagnitude ?? Infinity) - Number(b.averageLossMagnitude ?? Infinity)
    || String(a.id).localeCompare(String(b.id)));
}

/** Rows that have at least one trade in every window are judged before empty cells. */
function rankCell(rows) {
  const populated = rows.filter(row => row.emptyWindows === 0);
  const sparse = rows.filter(row => row.emptyWindows > 0);
  return [...rankRows(populated), ...rankRows(sparse)];
}

function cellVerdict(rows, blockedFamilies = []) {
  const ranked = rankCell(rows);
  const best = ranked[0] || null;
  if (!best) {
    return {
      verdict: blockedFamilies.length ? 'BLOCKED' : 'NONE',
      best: null,
      ranked: [],
      blockedFamilies,
    };
  }
  return {
    verdict: best.consistent ? 'CONSISTENT' : 'NONE',
    best,
    ranked,
    blockedFamilies,
  };
}

function summarizeByFamily(rows) {
  const families = new Map();
  for (const row of rows) {
    if (!families.has(row.kind)) families.set(row.kind, []);
    families.get(row.kind).push(row);
  }
  return [...families.entries()].map(([kind, list]) => {
    const best = rankCell(list)[0];
    return {
      kind,
      variants: list.length,
      consistent: list.filter(row => row.consistent).length,
      best: best ? {
        id: best.id,
        worstWindowPf: best.worstWindowPf,
        pooledTrades: best.pooled.trades,
        pooledWinRate: best.pooled.winRate,
        pooledProfitFactor: best.pooled.profitFactor,
        failReason: best.failReason,
      } : null,
    };
  }).sort((a, b) => a.kind.localeCompare(b.kind));
}

function buildCellTable(rows, blocked = {}) {
  return REQUESTED_CELLS.map(cell => {
    const key = cellKey(cell.market, cell.horizon);
    const inCell = rows.filter(row => row.market === cell.market && row.horizon === cell.horizon);
    const verdict = cellVerdict(inCell, blocked[key] || []);
    return {
      ...cell,
      key,
      variantsScored: inCell.length,
      verdict: verdict.verdict,
      best: verdict.best,
      top: verdict.ranked.slice(0, 5),
      families: summarizeByFamily(inCell),
      blockedFamilies: verdict.blockedFamilies,
    };
  });
}

module.exports = {
  STUDY_ID,
  REQUESTED_CELLS,
  ENGINE_SHORT_MARKETS,
  MR_KIND,
  cellKey,
  isRequested,
  normalizeConsistencyCell,
  normalizeBookRow,
  consistencyVerdict,
  rankRows,
  rankCell,
  cellVerdict,
  summarizeByFamily,
  buildCellTable,
};
