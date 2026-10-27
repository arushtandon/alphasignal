#!/usr/bin/env node
'use strict';

// Backtest-only audit. This reads the authenticated Render history endpoint but
// never writes to Render or invokes any order, bridge, or scheduler path.
process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
const originalWarn = console.warn;
console.warn = () => {};

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { backtestSignal, buildMarketRegime, dailyToWeeklyBars } = require('../server');
const { scoreAtDecision } = require('../lib/research/pit-quality');

const ROOT = process.cwd();
const CACHE = path.join(ROOT, 'data', 'research', 'render-history-score-parity.json');
const OUTPUT = path.join(ROOT, 'scripts', 'render-score-parity-results.json');
const READOUT = path.join(ROOT, 'scripts', 'render-score-parity-readout.md');
const CHECKPOINT = process.argv.find(value => value.startsWith('--checkpoint='))?.slice(13)
  || 'scripts/performance-stage1-v2-checkpoint.json';
const WORKER_ROOT = process.argv.find(value => value.startsWith('--workerRoot='))?.slice(13)
  || `${CHECKPOINT}.workers`;
const PARITY_FROM = '2026-09-10'; // First full SGT recommendation day after Danelfin retirement.
const LISTING = {
  US: { currency: 'USD', scale: 1 },
  Japan: { currency: 'JPY', scale: 1 },
  'Hong Kong': { currency: 'HKD', scale: 1 },
  UK: { currency: 'GBP', scale: 0.01 },
  Germany: { currency: 'EUR', scale: 1 },
  France: { currency: 'EUR', scale: 1 },
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function singaporeDay(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const raw = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(raw)) return null;
  return new Date((raw < 1e12 ? raw * 1000 : raw) + 8 * 3600000).toISOString().slice(0, 10);
}
function barDay(timestamp, market) {
  const offset = market === 'Japan' ? 9 : market === 'Hong Kong' ? 8 : 0;
  return new Date(Number(timestamp) * 1000 + offset * 3600000).toISOString().slice(0, 10);
}
function marketForTicker(ticker) {
  const symbol = String(ticker || '').trim().toUpperCase();
  if (!symbol) return null;
  if (symbol.endsWith('.T')) return 'Japan';
  if (symbol.endsWith('.HK')) return 'Hong Kong';
  if (symbol.endsWith('.L')) return 'UK';
  if (symbol.endsWith('.DE')) return 'Germany';
  if (symbol.endsWith('.PA')) return 'France';
  if (symbol.endsWith('.NS')) return 'India';
  if (symbol.endsWith('-USD')) return 'Crypto';
  if (symbol.endsWith('=F') || symbol.endsWith('=X')) return 'Commodities';
  if (!symbol.includes('.') && !symbol.includes('=') && !symbol.includes('-')) return 'US';
  return null;
}
function fxAt(currency, date) {
  if (String(currency).toUpperCase() === 'USD') return 1;
  const maps = { GBP: 'GBPUSD_X', EUR: 'EURUSD_X', HKD: 'HKDUSD_X', JPY: 'JPYUSD_X' };
  const file = maps[String(currency).toUpperCase()];
  const target = file && path.join(ROOT, 'data', 'research', 'fx', `${file}.json`);
  if (!target || !fs.existsSync(target)) return null;
  const row = (readJson(target).bars || []).find(bar => barDay(bar.t) === date);
  return Number(row?.c) > 0 ? Number(row.c) : null;
}
function idFor(market, horizon, symbol) {
  return `${market}__${horizon}__${symbol}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
function workerContext(market, horizon, symbol) {
  const file = path.join(ROOT, WORKER_ROOT, 'stage1', `${idFor(market, horizon, symbol)}.result.json`);
  if (!fs.existsSync(file)) return null;
  const result = readJson(file).result;
  return result?.outcome === 'success' ? result.context : null;
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function distribution(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { n: 0, min: null, median: null, max: null, mean: null };
  return {
    n: finite.length,
    min: Math.min(...finite),
    median: median(finite),
    max: Math.max(...finite),
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
  };
}
function componentSummary(pick, record) {
  if (!record) return { status: 'NO_REPLAY_DECISION' };
  const side = pick.side;
  const post = Number(record.postOverlay?.[side === 'sell' ? 'sellScore' : 'buyScore']);
  const pre = Number(record.preOverlay?.[side === 'sell' ? 'sellScore' : 'buyScore']);
  return {
    baseTechnicalScore: Number.isFinite(pre) ? pre : null,
    qualityAndStructuralDelta: Number.isFinite(post) && Number.isFinite(pre) ? post - pre : null,
    replayPostOverlayScore: Number.isFinite(post) ? post : null,
    replayConfidence: Number(record.postOverlay?.confidence ?? record.confidence) || null,
    supertrend: record.supertrend || null,
    marketTier: record.marketTier || null,
    quality: {
      usable: record.qualityUsable === true,
      piotroski: record.piotroski,
      altmanZ: record.altmanZ,
    },
    overlayConditions: record.overlayConditions || [],
    preOverlayConditions: record.preOverlay?.conditions || [],
    postOverlayConditions: record.postOverlay?.conditions || [],
    canonicalGate: record.gate,
    rejectionReasons: record.rejectionReasons || [],
  };
}
async function fetchHistory() {
  const url = String(process.env.RENDER_HISTORY_URL || '').trim();
  const token = String(process.env.RENDER_MACHINE_TOKEN || '').trim();
  if (!url || !token) throw new Error('RENDER_HISTORY_URL and RENDER_MACHINE_TOKEN must be set (values are not logged).');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Render history returned HTTP ${response.status}.`);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(rows)) throw new Error('Render history response did not contain an array.');
  // Persist only data and non-secret source provenance; never cache the token or full URL.
  const payload = { fetchedAt: new Date().toISOString(), sourceOrigin: new URL(url).origin, status: response.status, rows };
  writeJson(CACHE, payload);
  return payload;
}
async function replayPick(pick) {
  if (!LISTING[pick.market]) return { status: 'NO_REPLAY_COVERAGE_FOR_MARKET' };
  const context = workerContext(pick.market, pick.horizon, pick.ticker);
  if (!context?.bars?.length) return { status: 'NO_CACHED_REPLAY_CONTEXT' };
  // The board publishes around 06:00 SGT. Its recommendation day therefore
  // precedes the Japan/HK/Europe session and follows the prior US session.
  // In every covered market the causal signal input is the latest completed
  // daily bar strictly before the SGT recommendation day.
  const signalBar = context.bars.findLast(bar => barDay(bar.t, pick.market) < pick.date);
  if (!signalBar) return { status: 'NO_CAUSAL_SIGNAL_BAR' };
  const signalDate = barDay(signalBar.t, pick.market);
  let replayBars = context.bars;
  let paddedDecisionTail = false;
  const signalIndex = context.bars.indexOf(signalBar);
  if (signalIndex > context.bars.length - 3) {
    // backtestSignal reserves two bars for exit simulation. Synthetic tail bars
    // only unlock decision capture at the end of the cache; indicators at the
    // signal index cannot observe them.
    const last = context.bars[context.bars.length - 1];
    replayBars = context.bars.concat([1, 2].map(days => ({
      ...last,
      t: Number(last.t) + days * 86400,
    })));
    paddedDecisionTail = true;
  }
  const listing = LISTING[pick.market];
  const fundamentalsAt = ({ bar }) => {
    const quality = scoreAtDecision(context.arrays, {
      market: pick.market, decisionDate: barDay(bar.t, pick.market), close: bar.c,
      listingCurrency: listing.currency, listingPriceScale: listing.scale, fxAt,
    });
    return { fmp: quality.usable ? quality : null };
  };
  const result = await backtestSignal(replayBars, pick.horizon, dailyToWeeklyBars(replayBars), null, {
    symbol: pick.ticker, market: pick.market, marketSeries: buildMarketRegime(context.benchmarkBars),
    windowBars: 70, entryStep: 1, allowOverlapping: true, entryLedgerOnly: true,
    captureDecisionRecords: true, fundamentalsAt,
  });
  const record = (result?.decisionRecords || []).find(row => barDay(row.signalTs, pick.market) === signalDate);
  if (!record) return { status: 'NO_EXACT_REPLAY_BAR', signalDate, paddedDecisionTail };
  const replayScore = Number(record.postOverlay?.[pick.side === 'sell' ? 'sellScore' : 'buyScore']);
  const replayConf = Number(record.postOverlay?.confidence ?? record.confidence);
  return {
    status: 'MATCHED_DECISION_DATE',
    signalDate,
    paddedDecisionTail,
    replayScore: Number.isFinite(replayScore) ? replayScore : null,
    replayConfidence: Number.isFinite(replayConf) ? replayConf : null,
    record: componentSummary(pick, record),
  };
}
function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function scoreProvenance(row) {
  const entryMs = Date.parse(row.entryDate || row.timestamp || '');
  const revalidatedMs = Date.parse(row.revalidatedAt || '');
  if (Number.isFinite(entryMs) && Number.isFinite(revalidatedMs) && revalidatedMs - entryMs > 5 * 60 * 1000) {
    return 'MUTABLE_REVALIDATED';
  }
  return 'AT_OR_NEAR_ENTRY';
}
function markdown(value) { return value == null ? 'UNKNOWN' : String(value); }

async function main() {
  const cache = await fetchHistory();
  const unparseable = [];
  const unmapped = [];
  const picks = [];
  for (const row of cache.rows) {
    if (!/^(buy|sell)$/i.test(String(row.action || ''))) continue;
    const date = singaporeDay(row.entryDate) || singaporeDay(row.timestamp);
    const market = marketForTicker(row.ticker);
    if (!date) { unparseable.push({ ticker: row.ticker || null, horizon: row.hz || null, rawDate: row.entryDate ?? row.timestamp ?? null }); continue; }
    if (!market) { unmapped.push({ ticker: row.ticker || null, horizon: row.hz || null, date }); continue; }
    if (date < PARITY_FROM) continue;
    const horizon = String(row.hz || '').toLowerCase();
    const side = String(row.action).toLowerCase();
    if (!['short', 'medium', 'long'].includes(horizon)) {
      unmapped.push({ ticker: row.ticker || null, horizon: row.hz || null, date, reason: 'UNKNOWN_HORIZON' });
      continue;
    }
    const scoreKey = side === 'sell' ? `${horizon}SellScore` : `${horizon}Score`;
    picks.push({
      ticker: String(row.ticker || '').trim().toUpperCase(), market, horizon, side, date,
      liveScore: numberOrNull(row[scoreKey] ?? row.score),
      liveConfidence: numberOrNull(row[`${horizon}Conf`] ?? row.conf),
      historyScoreProvenance: scoreProvenance(row),
      historyRevalidatedAt: row.revalidatedAt || null,
      liveFmpScore: numberOrNull(row.fmpScore),
      liveFundSnapshot: row.fundSnapshot || null,
    });
  }
  const reportRows = [];
  for (const pick of picks) {
    const replay = await replayPick(pick);
    reportRows.push({
      ...pick, ...replay,
      scoreDifferenceLiveMinusReplay: Number.isFinite(pick.liveScore) && Number.isFinite(replay.replayScore)
        ? pick.liveScore - replay.replayScore : null,
      confidenceDifferenceLiveMinusReplay: Number.isFinite(pick.liveConfidence) && Number.isFinite(replay.replayConfidence)
        ? pick.liveConfidence - replay.replayConfidence : null,
    });
  }
  const groups = [...new Set(reportRows.map(row => `${row.market}|${row.horizon}`))].sort();
  const perMarketHorizon = Object.fromEntries(groups.map(group => {
    const rows = reportRows.filter(row => `${row.market}|${row.horizon}` === group);
    return [group, {
      picks: rows.length,
      replayed: rows.filter(row => row.status === 'MATCHED_DECISION_DATE').length,
      scoreLiveMinusReplay: distribution(rows.map(row => row.scoreDifferenceLiveMinusReplay)),
      confidenceLiveMinusReplay: distribution(rows.map(row => row.confidenceDifferenceLiveMinusReplay)),
      statusCounts: Object.fromEntries([...new Set(rows.map(row => row.status))].sort()
        .map(status => [status, rows.filter(row => row.status === status).length])),
    }];
  }));
  const cited = reportRows.filter(row => (row.ticker === '5901.T' && row.horizon === 'medium' && row.date === '2026-09-18')
    || (row.ticker === '8604.T' && row.horizon === 'short' && row.date === '2026-09-18'));
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'BACKTEST_ONLY',
    renderHistory: { fetchedAt: cache.fetchedAt, sourceOrigin: cache.sourceOrigin, rows: cache.rows.length },
    danelfin: { retiredOn: '2026-09-09', comparisonFrom: PARITY_FROM },
    scope: 'Every Render history Buy/Sell pick whose SGT recommendation date is on or after comparisonFrom.',
    knownReplayDifferences: [
      'History horizon scores are mutable: applyAnalyticsSnapshotToTrade overwrites them during revalidation. Rows marked MUTABLE_REVALIDATED do not preserve the publication-time score and cannot establish original recommendation-score parity.',
      'The replay injects cache-derived PIT Piotroski and Altman Z. Render history stores the live FMP snapshot/score captured at recommendation time; these are intentionally not the same time-series source.',
      'The replay has historical benchmark regime but no dated live board shortlist, open-position suppression, board lock, live quote repricing, or publication-time cross-horizon selection state.',
      'No dated sector and company-earnings overlay event stream is injected into this audit; those live inputs are therefore UNKNOWN rather than treated as parity failures.',
    ],
    perMarketHorizon,
    picks: reportRows,
    citedPicks: cited,
    unparseableDates: unparseable,
    unmappedTickers: unmapped,
  };
  writeJson(OUTPUT, report);
  const lines = [
    '# Render Live Pick Score Parity Audit',
    '',
    'Backtest-only. This report reads Render history with a machine bearer token and does not mutate Render, the live engine, orders, or strategy rules.',
    `Render history: ${cache.rows.length} rows fetched ${cache.fetchedAt}; source ${cache.sourceOrigin}.`,
    `Comparison scope: every Buy/Sell recommendation with Singapore recommendation day from ${PARITY_FROM} (Danelfin retired 2026-09-09).`,
    '',
    '## Distribution: current history snapshot minus causal replay',
    'These deltas are diagnostic, not publication-time parity evidence, when score provenance is MUTABLE_REVALIDATED.',
    '| Market | Horizon | Picks | Replayed | Score Δ n / min / median / max / mean | Conf Δ n / min / median / max / mean | Statuses |',
    '| --- | --- | ---: | ---: | --- | --- | --- |',
    ...groups.map(group => {
      const [market, horizon] = group.split('|');
      const item = perMarketHorizon[group];
      const fmt = value => `${value.n}/${markdown(value.min)}/${markdown(value.median)}/${markdown(value.max)}/${value.mean == null ? 'UNKNOWN' : value.mean.toFixed(2)}`;
      return `| ${market} | ${horizon} | ${item.picks} | ${item.replayed} | ${fmt(item.scoreLiveMinusReplay)} | ${fmt(item.confidenceLiveMinusReplay)} | ${Object.entries(item.statusCounts).map(([k, v]) => `${k}:${v}`).join(', ')} |`;
    }),
    '',
    '## Component interpretation',
    'For each matched replay decision, the JSON contains base technical score (before the quality/structural overlay), the resulting overlay delta, Supertrend state, market tier, PIT Piotroski/Altman values, conditions, and canonical gate. The production signal does not expose a numeric per-condition contribution, so this audit does not invent one.',
    ...report.knownReplayDifferences.map(note => `- ${note}`),
    '',
    '## Every post-cutover live pick',
    '| Ticker | Market | Horizon | Side | SGT recommendation | Signal bar | History score | Provenance | Replay score | Δ score | History Conf | Replay Conf | Δ Conf | Status |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...reportRows.map(row => `| ${row.ticker} | ${row.market} | ${row.horizon} | ${row.side} | ${row.date} | ${markdown(row.signalDate)} | ${markdown(row.liveScore)} | ${row.historyScoreProvenance} | ${markdown(row.replayScore)} | ${markdown(row.scoreDifferenceLiveMinusReplay)} | ${markdown(row.liveConfidence)} | ${markdown(row.replayConfidence)} | ${markdown(row.confidenceDifferenceLiveMinusReplay)} | ${row.status} |`),
    '',
    '## Previously omitted cited picks',
    ...cited.map(row => `- ${row.ticker} ${row.horizon} ${row.side} (${row.date}): present in authoritative Render history; ${row.status}; history score provenance ${row.historyScoreProvenance}. The earlier local audit used a stale local history snapshot and therefore did not examine it.`),
    ...(cited.length ? [] : ['- Neither cited tuple was found in the current Render history response.']),
    '',
    `Unparseable history dates: ${unparseable.length}. Unmapped ticker/horizon rows: ${unmapped.length}.`,
    `Machine-readable details: ${path.relative(ROOT, OUTPUT)}.`,
  ];
  fs.writeFileSync(READOUT, `${lines.join('\n')}\n`);
  console.warn = originalWarn;
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} and ${path.relative(ROOT, READOUT)}`);
}

main().catch(error => {
  console.warn = originalWarn;
  console.error(error.stack || error);
  process.exitCode = 1;
});
