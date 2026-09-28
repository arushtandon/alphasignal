#!/usr/bin/env node
'use strict';

/**
 * Read-only strategy scorecard. It deliberately reports UNKNOWN rather than
 * inferring authenticated Render ledger fields from local files or chat.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DISABLED_BRACKETS } = require('../lib/strategy/bracket-policy');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'strategy-scorecard.json');
const date = new Date().toISOString().slice(0, 10);
const DOC = path.join(ROOT, 'docs', `strategy-scorecard-${date}.md`);
const geographies = ['US', 'Japan', 'HK', 'UK', 'Germany', 'France', 'India', 'Commodities', 'Crypto'];
const horizons = ['short', 'medium', 'long'];
const sides = ['buy', 'sell'];
const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { return 'UNKNOWN'; }
}
function value(pattern, fallback = 'UNKNOWN') {
  const hit = code.match(pattern);
  return hit ? hit[1] : fallback;
}
function marketRule(geo, hz) {
  if (geo === 'US' || geo === 'UK') {
    return hz === 'short'
      ? 'Strong rating; MTF Supertrend(10,3), momentum/HLC and structural S/R confirmation; FMP quality required'
      : 'Strong rating; FMP quality required; minimum RR 1.4';
  }
  if (geo === 'Commodities' || geo === 'Crypto') return 'Technical-only market tier; no FMP quality gate';
  return 'Trend/momentum technical engine with FMP quality/fundamental overlay when provider data exists';
}
function pit(geo) {
  return geo === 'Commodities' || geo === 'Crypto'
    ? 'price/volume/technical inputs: YES; inventory, curve and event data: UNKNOWN/not live'
    : 'price/volume/technical: YES; FMP financial score: CURRENT-only; earnings report: PIT available; analyst estimates: CURRENT-only';
}
function backtestEvidence() {
  // No registered study replays the entire live FMP-gated production book
  // point-in-time. Naming a related price-only study as an exact test would be
  // a false match.
  return {
    study: 'NONE',
    date: null,
    holdoutN: null,
    winPct: null,
    profitFactor: null,
    netPnl: null,
    holdoutStatus: 'NONE',
  };
}

async function health() {
  const url = process.env.SCORECARD_RENDER_URL || 'https://alphasignal-dvg5.onrender.com/api/health';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { url, data: await res.json(), error: null };
  } catch (error) {
    return { url, data: null, error: String(error.message || error) };
  }
}

function cell(geo, horizon, side) {
  const bracket = `${side}:${horizon}`;
  const disabled = DISABLED_BRACKETS.has(bracket);
  const evidence = backtestEvidence();
  return {
    geography: geo,
    horizon,
    side,
    liveConfig: {
      // Render health intentionally does not expose SELL_PICKS_ENABLED. The
      // bracket disable is known from the deployed Render blueprint; other sell
      // cells are conditional rather than assumed enabled.
      enabled: disabled ? false : (side === 'sell' ? 'UNKNOWN' : true),
      disabledBy: disabled ? `DISABLED_BRACKETS=${[...DISABLED_BRACKETS].join(',')}` : null,
      strategyFamily: 'trend engine',
      entryRules: `${marketRule(geo, horizon)}; Conf >= ${value(/PICKS_MIN_CONF[^;]*\|\| '(\d+)'/, '62')}; RR >= ${value(/PICKS_MIN_RR[^;]*\|\| '([\d.]+)'/, '1.1')}; horizon Supertrend cap; market/sector/earnings overlays`,
      exits: 'ATR/structure SL floor; partial TP1; TP2 is live runner exit; post-TP1 TSL ratchet; horizon time exit',
      pointInTimeReplayable: pit(geo),
      envOverrides: {
        DISABLED_BRACKETS: [...DISABLED_BRACKETS].join(','),
        SELL_PICKS_ENABLED: 'UNKNOWN (Render health does not expose this non-secret flag)',
        PICKS_MIN_CONF: 'UNKNOWN (Render health does not expose this non-secret flag)',
        PICKS_MIN_RR: 'UNKNOWN (Render health does not expose this non-secret flag)',
      },
    },
    backtestEvidence: evidence,
    livePaper: {
      status: 'UNKNOWN',
      reason: 'Render /api/ibkr/trades requires authentication; no Render ledger export was available to this read-only runtime',
      dateRange: null, closedTrades: null, openTrades: null, winPct: null,
      profitFactor: null, realisedPnl: null, avgWin: null, avgLoss: null,
    },
    driftFlag: 'UNTESTED',
    driftReason: 'No study exactly replays the live FMP-gated production configuration with point-in-time financial-score data',
  };
}

function markdown(report) {
  const lines = [
    '# Authoritative strategy scorecard',
    '',
    `Generated: ${report.generatedAt}`,
    `Code commit: \`${report.codeCommit}\``,
    `Render deploy: ${report.render.deploy}`,
    '',
    '> Authenticated Render fills/history were unavailable to this read-only runtime. Live-paper values are deliberately `UNKNOWN`; they are not estimated from backtests or local files.',
    '',
    '| Geography | Horizon | Side | Enabled | Live entry/gates | Live exits | PIT inputs | Exact backtest | Live paper | Drift |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.cells) {
    const enabled = row.liveConfig.enabled === true ? 'YES' : row.liveConfig.enabled === false ? 'NO' : 'UNKNOWN';
    lines.push(`| ${row.geography} | ${row.horizon} | ${row.side} | ${enabled} | ${row.liveConfig.entryRules} | ${row.liveConfig.exits} | ${row.liveConfig.pointInTimeReplayable} | ${row.backtestEvidence.study} | ${row.livePaper.status} | ${row.driftFlag} |`);
  }
  lines.push('', '## Geography verdicts');
  for (const geo of geographies) {
    const live = report.cells.filter(r => r.geography === geo && r.liveConfig.enabled === true).length;
    lines.push(`- ${geo}: ${live}/6 confirmed enabled cells; sell cells with no bracket-disable are UNKNOWN until authenticated Render configuration is read. Confirmed live cells are UNTESTED as exact configurations because current FMP financial scores are not point-in-time replayable.`);
  }
  lines.push('', '## Required follow-up flags', '- Live DRIFT/UNTESTED: all enabled cells (exact production replay unavailable).', '- Live paper n < 30: UNKNOWN for every cell because authenticated fills were inaccessible.', '- Live/backtest contradictions: UNKNOWN; no authenticated model-bucket ledger was available.', '');
  return lines.join('\n');
}

(async () => {
  const render = await health();
  const h = render.data;
  const report = {
    generatedAt: new Date().toISOString(),
    codeCommit: git('rev-parse', 'HEAD'),
    render: {
      healthUrl: render.url,
      deploy: h ? `server_build=${h.server_build || 'UNKNOWN'}; uptime_s=${h.uptime_s ?? 'UNKNOWN'}; commit=UNKNOWN` : 'UNKNOWN',
      healthError: render.error,
      publicEnv: h ? {
        fmpKeyResolved: h.fmp && h.fmp.key_resolved,
        fmpPlan: h.fmp && h.fmp.plan,
        disabledBrackets: h.disabledBrackets || 'UNKNOWN',
      } : null,
    },
    cells: geographies.flatMap(geo => horizons.flatMap(horizon => sides.map(side => cell(geo, horizon, side)))),
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(DOC, markdown(report));
  console.log(JSON.stringify({ output: OUT, document: DOC, cells: report.cells.length, codeCommit: report.codeCommit }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
