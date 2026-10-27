#!/usr/bin/env node
'use strict';

// Backtest-only, cache-only fundamental fidelity audit. It deliberately does
// not call live FMP endpoints or mutate history/live state.
process.env.RESEARCH_MODE = '1';
process.env.AUTH_TEST_BYPASS = '1';
// The production overlay intentionally warns once per blocked historical bar.
// That is useful in live analysis but would flood this batch audit's output.
console.warn = () => {};

const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { backtestSignal, buildMarketRegime, dailyToWeeklyBars, fetchOHLCV } = require('../server');
const { STATIC_GROUPS } = require('../universe');
const { scoreAtDecision } = require('../lib/research/pit-quality');
const { loadUsUniverseSnapshot, membershipAt } = require('../lib/research/us-universe');

const ROOT = process.cwd();
const FROM = process.argv.find(value => value.startsWith('--from='))?.slice(7) || '2026-08-01';
const TO = process.argv.find(value => value.startsWith('--to='))?.slice(5) || '2026-09-29';
const CHECKPOINT = process.argv.find(value => value.startsWith('--checkpoint='))?.slice(13)
  || 'scripts/performance-stage1-v2-checkpoint.json';
const WORKER_ROOT = process.argv.find(value => value.startsWith('--workerRoot='))?.slice(13)
  || `${CHECKPOINT}.workers`;
const OUTPUT = path.join(ROOT, 'scripts', 'stage1-fidelity-audit-results.json');
const READOUT = path.join(ROOT, 'scripts', 'stage1-fidelity-audit-readout.md');
const DANELFIN_RETIRED_ON = '2026-09-09';
const PARITY_FROM = '2026-09-10'; // First complete SGT recommendation day after retirement.
const US_SNAPSHOT = loadUsUniverseSnapshot(path.join(ROOT, 'data', 'research', 'fmp'));
const UNIVERSES = {
  US: US_SNAPSHOT.candidateSymbols,
  Japan: [...new Set(STATIC_GROUPS.NIKKEI225)],
  'Hong Kong': [...new Set(STATIC_GROUPS.HSI)],
  UK: [...new Set(STATIC_GROUPS.FTSE100)],
  Germany: [...new Set(STATIC_GROUPS.DAX)],
  France: [...new Set(STATIC_GROUPS.CAC40)],
};
const BENCHMARK = { US: 'SPY', Japan: 'EWJ', 'Hong Kong': 'EWH', UK: 'EWU', Germany: 'EWG', France: 'EWQ' };
const LISTING = {
  US: { currency: 'USD', scale: 1 }, Japan: { currency: 'JPY', scale: 1 },
  'Hong Kong': { currency: 'HKD', scale: 1 }, UK: { currency: 'GBP', scale: 0.01 },
  Germany: { currency: 'EUR', scale: 1 }, France: { currency: 'EUR', scale: 1 },
};
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function day(ts, market = null) {
  const value = Number(ts);
  if (!value) return null;
  const utc = value < 1e12 ? value * 1000 : value;
  // Yahoo timestamps Asian daily bars at the preceding UTC session date. Live
  // history is recorded in the listing's local trading date, so only the audit
  // tuple uses this exchange-calendar normalization.
  const offsetHours = market === 'Japan' ? 9 : market === 'Hong Kong' ? 8 : 0;
  return new Date(utc + offsetHours * 3600000).toISOString().slice(0, 10);
}
function singaporeDay(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const raw = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
  if (!Number.isFinite(raw)) return null;
  const milliseconds = raw < 1e12 ? raw * 1000 : raw;
  return new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 10);
}
function historyDay(row) {
  return singaporeDay(row.entryDate) || singaporeDay(row.timestamp);
}
function marketForTicker(ticker) {
  const symbol = String(ticker || '').trim().toUpperCase();
  if (!symbol) return null;
  if (symbol.endsWith('.T')) return 'Japan';
  if (symbol.endsWith('.HK')) return 'Hong Kong';
  if (symbol.endsWith('.L')) return 'UK';
  if (symbol.endsWith('.DE')) return 'Germany';
  if (symbol.endsWith('.PA')) return 'France';
  if (!symbol.includes('.') && !/[=]/.test(symbol) && !symbol.includes('-')) return 'US';
  return null;
}
function fxAt(currency, date) {
  if (String(currency).toUpperCase() === 'USD') return 1;
  const maps = { GBP: 'GBPUSD_X', EUR: 'EURUSD_X', HKD: 'HKDUSD_X', JPY: 'JPYUSD_X' };
  const file = maps[String(currency).toUpperCase()];
  if (!file) return null;
  const target = path.join(ROOT, 'data', 'research', 'fx', `${file}.json`);
  if (!fs.existsSync(target)) return null;
  const bars = readJson(target).bars || [];
  const bar = bars.find(item => day(item.t) === date);
  return Number(bar?.c) > 0 ? Number(bar.c) : null;
}
function tuple(row) { return [row.market, row.ticker, row.horizon, row.side, row.date].join('|'); }
function markdownRows(rows) {
  return rows.length ? rows.map(row => `| ${row.market} | ${row.ticker} | ${row.horizon} | ${row.side} | ${row.date} |`).join('\n')
    : '| — | — | — | — | — |';
}

function gateDiagnostics(records, market) {
  const rows = records.filter(row => row.market === market);
  const count = predicate => rows.filter(predicate).length;
  const scoreForSide = (row, scores) => Number(scores?.[row.side === 'sell' ? 'sellScore' : 'buyScore']) || 0;
  const supertrendAligned = row => row.side === 'sell'
    ? row.supertrend?.direction === 'bear'
    : row.supertrend?.direction === 'bull';
  return {
    decisions: rows.length,
    scoreBelow62: count(row => scoreForSide(row, row.postOverlay) < 62),
    confidenceBelow62: count(row => Number(row.confidence) < 62),
    rewardRisk: count(row => row.gate === 'rewardRisk'),
    supertrendNotAligned: count(row => !supertrendAligned(row)),
    overlayReducedBelow62: count(row => scoreForSide(row, row.preOverlay) >= 62
      && scoreForSide(row, row.postOverlay) < 62),
    marketTierPolicy: count(row => row.gate === 'marketPolicy'),
    piotroskiUnavailable: count(row => row.qualityUsable && !Number.isFinite(Number(row.piotroski))),
    altmanUnavailable: count(row => row.qualityUsable && !Number.isFinite(Number(row.altmanZ))),
    missingFundamentals: count(row => !row.qualityUsable),
    entryEligible: count(row => row.gate === 'entryEligible'),
  };
}

function workerContext(market, symbol) {
  const id = `${market}__medium__${symbol}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const file = path.join(ROOT, WORKER_ROOT, 'stage1', `${id}.result.json`);
  if (!fs.existsSync(file)) return null;
  const result = readJson(file).result;
  return result.outcome === 'success' ? result.context : null;
}
async function replaySymbol(market, symbol, context) {
  if (!context?.bars?.length) return { records: [], candidates: [], error: 'STAGE1_CONTEXT_UNAVAILABLE' };
  const { bars, arrays: statements, benchmarkBars } = context;
  const listing = LISTING[market];
  const fundamentalsAt = ({ bar }) => {
    const quality = scoreAtDecision(statements, {
      market, decisionDate: day(bar.t), close: bar.c, listingCurrency: listing.currency,
      listingPriceScale: listing.scale, fxAt,
    });
    return { fmp: quality.usable ? quality : null };
  };
  const common = {
    // The supplied full series retains indicator warm-up; this bounded tail
    // covers the audit dates plus a margin without re-evaluating prior years.
    symbol, market, marketSeries: buildMarketRegime(benchmarkBars), windowBars: 70, entryStep: 1,
    allowOverlapping: true, entryLedgerOnly: true, captureEntryCandidates: true, captureDecisionRecords: true,
    fundamentalsAt,
  };
  const results = await Promise.all(['short', 'medium', 'long'].map(async horizon => {
    const result = await backtestSignal(bars, horizon, dailyToWeeklyBars(bars), null, common);
    const records = (result?.decisionRecords || []).filter(row => {
      const date = day(row.signalTs, market);
      return date >= PARITY_FROM && date <= TO
        && (market !== 'US' || membershipAt(US_SNAPSHOT, date).has(symbol));
    }).map(row => ({ ...row, market, ticker: symbol, horizon, date: day(row.signalTs, market) }));
    const candidates = (result?.entryCandidates || []).filter(row => {
      const date = day(row.signalTs, market);
      return date >= PARITY_FROM && date <= TO
        && (market !== 'US' || membershipAt(US_SNAPSHOT, date).has(symbol));
    }).map(row => ({ ...row, market, ticker: symbol, horizon, date: day(row.signalTs, market) }));
    return { records, candidates };
  }));
  return { records: results.flatMap(result => result.records), candidates: results.flatMap(result => result.candidates), error: null };
}

async function main() {
  const rawHistory = (readJson(path.join(ROOT, 'data', 'history_data.json')).data || [])
    .filter(row => /^(buy|sell)$/i.test(row.action || ''));
  const unparseable = [];
  const unmapped = [];
  const preDanelfin = [];
  const inRange = [];
  for (const row of rawHistory) {
    const date = historyDay(row);
    const market = marketForTicker(row.ticker);
    const normalized = {
      market, ticker: String(row.ticker || '').trim().toUpperCase(), horizon: row.hz || 'short',
      side: String(row.action).toLowerCase(), date, rating: row.rating || null,
      score: Number(row[`${row.hz}Score`] ?? row[`${row.hz}SellScore`] ?? null),
      confidence: Number(row[`${row.hz}Conf`] ?? row.conf ?? null), historyMarketTier: row.marketTier || null,
      rawDate: row.entryDate ?? row.timestamp ?? null,
    };
    if (!date) { unparseable.push(normalized); continue; }
    if (!market) { unmapped.push(normalized); continue; }
    if (date < FROM || date > TO) continue;
    inRange.push(normalized);
    if (date < PARITY_FROM) preDanelfin.push(normalized);
  }
  const actual = inRange.filter(row => row.date >= PARITY_FROM);
  const countByMarketHorizon = rows => {
    const out = {};
    for (const row of rows) {
      const key = `${row.market || 'UNMAPPED'}|${row.horizon || 'UNKNOWN'}`;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  };
  const unsupportedShort = actual.filter(row => row.horizon === 'short');
  const replayed = [];
  const decisionRecords = [];
  const failures = [];
  for (const [market, symbols] of Object.entries(UNIVERSES)) {
    const completed = await Promise.all(symbols.map(async symbol => {
      const result = await replaySymbol(market, symbol, workerContext(market, symbol));
      return { symbol, result };
    }));
    for (const { symbol, result } of completed) {
      if (result.error) failures.push({ market, symbol, error: result.error });
      replayed.push(...result.candidates);
      decisionRecords.push(...result.records);
      const actualForSymbol = actual.filter(row => row.market === market && row.ticker === symbol);
      for (const live of actualForSymbol) {
        const diagnostic = result.records.find(row => row.horizon === live.horizon && row.date === live.date);
        live.currentPitFunnel = diagnostic || { gate: 'NOT_EVALUATED', rejectionReasons: ['No bar for exact UTC decision date'] };
      }
    }
  }
  const actualStage1 = actual;
  const actualMap = new Map(actualStage1.map(row => [tuple(row), row]));
  const replayMap = new Map(replayed.map(row => [tuple(row), row]));
  const matched = [...actualMap.keys()].filter(key => replayMap.has(key)).map(key => ({ live: actualMap.get(key), replay: replayMap.get(key) }));
  const missed = [...actualMap.keys()].filter(key => !replayMap.has(key)).map(key => actualMap.get(key));
  const extra = [...replayMap.keys()].filter(key => !actualMap.has(key)).map(key => replayMap.get(key));
  const diagnostics = Object.fromEntries(['US', 'UK'].map(market => [market, gateDiagnostics(decisionRecords, market)]));
  const perMarket = Object.fromEntries(Object.keys(UNIVERSES).map(market => [market, {
    matched: matched.filter(row => row.live.market === market).length,
    missed: missed.filter(row => row.market === market).length,
    extra: extra.filter(row => row.market === market).length,
  }]));
  const report = {
    generatedAt: new Date().toISOString(), mode: 'BACKTEST_ONLY', liveBehaviorChanged: false,
    range: { requestedFrom: FROM, parityFrom: PARITY_FROM, to: TO },
    danelfinRetirement: { commitDate: DANELFIN_RETIRED_ON, comparisonStarts: PARITY_FROM },
    usUniverse: {
      currentSymbols: US_SNAPSHOT.currentSymbols.length,
      candidates: US_SNAPSHOT.candidateSymbols.length,
      historicalMembership: US_SNAPSHOT.historicalMembership.available,
      survivorshipBias: US_SNAPSHOT.survivorshipBias,
    },
    history: {
      rawBuySellRows: rawHistory.length,
      inRequestedRange: countByMarketHorizon(inRange),
      auditUsed: countByMarketHorizon(actualStage1),
      excludedPreDanelfin: countByMarketHorizon(preDanelfin),
      unparseableDate: unparseable,
      unmappedMarket: unmapped,
    },
    replay: {
      markets: Object.keys(UNIVERSES), horizons: ['short', 'medium', 'long'], entryStep: 1,
      exactKey: 'market|ticker|horizon|side|UTC decision date',
      fundamentals: 'cache-only PIT Piotroski/Altman decision-date injection',
    },
    perMarket, diagnostics, matched, missed, extra, unsupportedShort, failures,
  };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Stage 1 Fidelity Audit', '', `Range: ${FROM} through ${TO} (inclusive).`,
    `Parity comparison: ${PARITY_FROM} through ${TO}; Danelfin retired from live scoring on ${DANELFIN_RETIRED_ON}.`,
    'Backtest-only. No live history, preregistration, or execution behavior changed.', '',
    `US universe: ${US_SNAPSHOT.currentSymbols.length} current symbols / ${US_SNAPSHOT.candidateSymbols.length} PIT candidates; ${US_SNAPSHOT.survivorshipBias ? 'SURVIVORSHIP_BIAS' : 'FMP historical membership available'}.`,
    '', '## History intake',
    `Raw Buy/Sell rows: ${rawHistory.length}. Unparseable dates: ${unparseable.length}. Unmapped tickers: ${unmapped.length}. Pre-Danelfin-cutover rows excluded: ${preDanelfin.length}.`,
    '| Market | Horizon | In requested range | Used by parity audit | Pre-cutover excluded |',
    '| --- | --- | ---: | ---: | ---: |',
    ...[...new Set([...Object.keys(countByMarketHorizon(inRange)), ...Object.keys(countByMarketHorizon(actual)), ...Object.keys(countByMarketHorizon(preDanelfin))])]
      .sort().map(key => {
        const [market, horizon] = key.split('|');
        return `| ${market} | ${horizon} | ${countByMarketHorizon(inRange)[key] || 0} | ${countByMarketHorizon(actual)[key] || 0} | ${countByMarketHorizon(preDanelfin)[key] || 0} |`;
      }),
    ...(unparseable.length ? ['', '### Unparseable dates', ...unparseable.map(row => `- ${row.ticker || 'UNKNOWN'} ${row.horizon}: ${String(row.rawDate)}`)] : []),
    ...(unmapped.length ? ['', '### Unmapped tickers', ...unmapped.map(row => `- ${row.ticker || 'UNKNOWN'} ${row.horizon}: ${row.date}`)] : []),
    '## Exact-match results', '| Market | Matched | Missed | Extra |', '| --- | ---: | ---: | ---: |',
    ...Object.entries(perMarket).map(([market, counts]) => `| ${market} | ${counts.matched} | ${counts.missed} | ${counts.extra} |`),
    '', `Short-horizon history picks included after the dated scope amendment: ${unsupportedShort.length}.`,
    '', '## US / UK gate diagnostics', 'The production engine combines fundamental, structural, and Supertrend effects into its final score; these overlapping counts are diagnostics, not a sequential funnel.',
    '| Market | Decisions | Score <62 | Conf <62 | RR | Supertrend unaligned | Overlay reduced <62 | Market policy | Pio unavailable | Altman unavailable | Missing data | Eligible |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(diagnostics).map(([market, value]) => `| ${market} | ${value.decisions} | ${value.scoreBelow62} | ${value.confidenceBelow62} | ${value.rewardRisk} | ${value.supertrendNotAligned} | ${value.overlayReducedBelow62} | ${value.marketTierPolicy} | ${value.piotroskiUnavailable} | ${value.altmanUnavailable} | ${value.missingFundamentals} | ${value.entryEligible} |`),
    '', '## Comparability note',
    'The replay list is the production per-symbol entry ledger before daily board selection. History contains only published server-board picks after shortlist limits, top-five pane ranking, cross-horizon deduplication, open-position suppression, rotation, board lock, live-price repricing, and the final history writer checks. Without dated board snapshots and shortlist/open-position state, raw replay extras cannot be classified as live false positives. They are reported as unselected raw opportunities, not parity failures.',
    '', '## Matched', '| Market | Ticker | Horizon | Side | Date |', '| --- | --- | --- | --- | --- |',
    ...markdownRows(matched.map(row => row.live)).split('\n'),
    '', '## Missed live picks and current PIT funnel', '| Market | Ticker | Horizon | Side | Date | Current gate | Reasons |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...(missed.length ? missed.map(row => `| ${row.market} | ${row.ticker} | ${row.horizon} | ${row.side} | ${row.date} | ${row.currentPitFunnel?.gate || 'NOT_EVALUATED'} | ${(row.currentPitFunnel?.rejectionReasons || []).join('; ') || '—'} |`)
      : ['| — | — | — | — | — | — | — |']),
    '', '## Extra current PIT picks', '| Market | Ticker | Horizon | Side | Date |', '| --- | --- | --- | --- | --- |',
    ...markdownRows(extra).split('\n'),
    '', `Machine-readable report: ${path.relative(ROOT, OUTPUT)}`,
  ];
  fs.writeFileSync(READOUT, `${lines.join('\n')}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)} and ${path.relative(ROOT, READOUT)}`);
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
