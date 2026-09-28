#!/usr/bin/env node
'use strict';

/**
 * Read-only strategy scorecard. It deliberately reports UNKNOWN rather than
 * reads the deployed ledger directly when run in the Render Shell. It never
 * mutates data, orders, or strategy configuration.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DISABLED_BRACKETS } = require('../lib/strategy/bracket-policy');
const { classifyMarket } = require('../lib/strategy/market-tier');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'strategy-scorecard.json');
const date = new Date().toISOString().slice(0, 10);
const DOC = path.join(ROOT, 'docs', `strategy-scorecard-${date}.md`);
const geographies = ['US', 'Japan', 'HK', 'UK', 'Germany', 'France', 'India', 'Commodities', 'Crypto'];
const horizons = ['short', 'medium', 'long'];
const sides = ['buy', 'sell'];

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { return 'UNKNOWN'; }
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

function geographyOf(ticker) {
  const s = String(ticker || '').toUpperCase();
  if (s.includes('=F')) return 'Commodities';
  if (s.endsWith('-USD') || s.endsWith('-EUR')) return 'Crypto';
  if (s.endsWith('.T')) return 'Japan';
  if (s.endsWith('.HK')) return 'HK';
  if (s.endsWith('.L')) return 'UK';
  if (s.endsWith('.DE')) return 'Germany';
  if (s.endsWith('.PA')) return 'France';
  if (s.endsWith('.NS') || s.endsWith('.BO')) return 'India';
  return 'US';
}
function readJsonLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch (_) { return null; }
}
function paperByCell() {
  const dataDir = process.env.DATA_DIR || process.env.RENDER_DISK_MOUNT_PATH || path.join(ROOT, 'data');
  const fills = readJsonLines(path.join(dataDir, 'ibkr_fills.jsonl'));
  if (!fills) return { available: false, errorPnl: 'UNKNOWN', cells: new Map() };
  const lots = new Map(), error = [];
  for (const f of fills) {
    if (f.errorTrade || String(f.key || '').includes('|cursor-err')) { error.push(f); continue; }
    const key = f.key || `${f.ticker}|${f.hz}|unknown`;
    const lot = lots.get(key) || { ticker: f.ticker, hz: f.hz || 'short', side: f.side || 'buy', entry: 0, exit: 0, pnl: 0, dates: [] };
    if (f.role === 'entry') lot.entry += Number(f.qty) || 0; else lot.exit += Number(f.qty) || 0;
    lot.pnl += Number(f.realizedUsd) || 0;
    if (f.time) lot.dates.push(f.time);
    lots.set(key, lot);
  }
  const cells = new Map();
  for (const lot of lots.values()) {
    const id = `${geographyOf(lot.ticker)}|${lot.hz}|${lot.side}`;
    const a = cells.get(id) || { lots: [], dates: [] };
    a.lots.push(lot); a.dates.push(...lot.dates); cells.set(id, a);
  }
  return { available: true, errorPnl: error.reduce((s, f) => s + (Number(f.realizedUsd) || 0), 0), cells };
}
function paperMetrics(paper, geo, horizon, side) {
  if (!paper.available) return { status: 'UNKNOWN', reason: 'No readable DATA_DIR ibkr_fills.jsonl', dateRange: null, closedTrades: null, openTrades: null, winPct: null, profitFactor: null, realisedPnl: null, avgWin: null, avgLoss: null, tooEarly: 'UNKNOWN' };
  const lots = (paper.cells.get(`${geo}|${horizon}|${side}`) || { lots: [], dates: [] });
  const closed = lots.lots.filter(x => x.entry > 0 && x.exit >= x.entry);
  const open = lots.lots.filter(x => x.entry > x.exit);
  const wins = closed.filter(x => x.pnl > 0), losses = closed.filter(x => x.pnl < 0);
  const grossWin = wins.reduce((s, x) => s + x.pnl, 0), grossLoss = losses.reduce((s, x) => s + Math.abs(x.pnl), 0);
  const dates = lots.dates.sort();
  return { status: 'DATA_DIR', dateRange: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : null, closedTrades: closed.length, openTrades: open.length, winPct: closed.length ? +(wins.length / closed.length * 100).toFixed(1) : null, profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null, realisedPnl: +closed.reduce((s, x) => s + x.pnl, 0).toFixed(2), avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : null, avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : null, tooEarly: closed.length < 30 };
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

function cell(geo, horizon, side, paper, runtimeConfig) {
  const bracket = `${side}:${horizon}`;
  const disabled = DISABLED_BRACKETS.has(bracket);
  const evidence = backtestEvidence();
  const symbol = { US:'AAPL', Japan:'7203.T', HK:'0700.HK', UK:'SHEL.L', Germany:'SAP.DE', France:'MC.PA', India:'RELIANCE.NS', Commodities:'CL=F', Crypto:'BTC-USD' }[geo];
  const tier = classifyMarket(symbol);
  const horizonConfig = runtimeConfig && typeof runtimeConfig === 'object'
    ? {
      minPct: runtimeConfig.HORIZON_MIN_PCT?.[horizon] || 'UNKNOWN',
      fallbackPct: runtimeConfig.HORIZON_PCT?.[horizon]?.[side] || 'UNKNOWN',
      atr: runtimeConfig.HORIZON_ATR?.[horizon]?.[side] || 'UNKNOWN',
      supertrend: runtimeConfig.SUPERTREND_PARAMS?.[horizon] || 'UNKNOWN',
    }
    : 'UNKNOWN';
  const conf = runtimeConfig?.PICKS_MIN_CONF ?? 'UNKNOWN';
  const rr = runtimeConfig?.PICKS_MIN_RR ?? 'UNKNOWN';
  const sellEnabled = runtimeConfig?.SELL_PICKS_ENABLED;
  const enabled = disabled ? false : (side === 'sell' && sellEnabled === false ? false : (sellEnabled == null && side === 'sell' ? 'UNKNOWN' : true));
  return {
    geography: geo,
    horizon,
    side,
    liveConfig: {
      enabled,
      disabledBy: disabled ? `DISABLED_BRACKETS=${[...DISABLED_BRACKETS].join(',')}` : (side === 'sell' && sellEnabled === false ? 'SELL_PICKS_ENABLED=false (Strong Sell exception is enforced by the decision engine)' : null),
      strategyFamily: 'trend engine',
      marketTier: tier,
      entryRules: {
        confidenceFloor: conf,
        rrFloor: rr,
        supertrend: horizonConfig === 'UNKNOWN' ? 'UNKNOWN' : horizonConfig.supertrend,
        marketTier: tier,
        overlays: 'market/sector/earnings overlays: implementation-specific; UNKNOWN where no exported runtime setting exists',
      },
      exits: {
        fallbackPct: horizonConfig === 'UNKNOWN' ? 'UNKNOWN' : horizonConfig.fallbackPct,
        atrMultiples: horizonConfig === 'UNKNOWN' ? 'UNKNOWN' : horizonConfig.atr,
        minimumPct: horizonConfig === 'UNKNOWN' ? 'UNKNOWN' : horizonConfig.minPct,
        policy: runtimeConfig?.exitPolicyVersion ?? 'UNKNOWN',
        runner: 'partial TP1; TP2 live runner exit; post-TP1 TSL ratchet',
      },
      pointInTimeReplayable: tier.fmp ? 'price/volume/technical: YES; FMP financial score: CURRENT-only; earnings reports: PIT available; analyst estimates: CURRENT-only' : 'price/volume/technical: YES; non-price fundamental inputs: not used',
      envOverrides: {
        DISABLED_BRACKETS: [...DISABLED_BRACKETS].join(','),
        SELL_PICKS_ENABLED: sellEnabled ?? 'UNKNOWN',
        PICKS_MIN_CONF: conf,
        PICKS_MIN_RR: rr,
      },
    },
    backtestEvidence: evidence,
    livePaper: paperMetrics(paper, geo, horizon, side),
    execution: geo === 'India'
      ? 'signals-only / IBKR execution eligibility UNKNOWN'
      : 'IBKR-eligible when provenance, account, release, Conf and RR gates pass',
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
    `Commit status: ${report.render.commitStatus}`,
    '',
    `> Live-paper source: ${report.paperSource}. Model rows exclude \`errorTrade\` and \`|cursor-err\`; Error PnL is reported separately as ${report.errorTradePnlTotal}.`,
    '',
    '| Geography | Horizon | Side | Enabled | Live entry/gates | Live exits | PIT inputs | Exact backtest | Live paper | Execution | Drift |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.cells) {
    const enabled = row.liveConfig.enabled === true ? 'YES' : row.liveConfig.enabled === false ? 'NO' : 'UNKNOWN';
    const entry = `Conf≥${row.liveConfig.entryRules.confidenceFloor}; RR≥${row.liveConfig.entryRules.rrFloor}; ST=${JSON.stringify(row.liveConfig.entryRules.supertrend)}`;
    const exits = `ATR=${JSON.stringify(row.liveConfig.exits.atrMultiples)}; floor=${JSON.stringify(row.liveConfig.exits.minimumPct)}; ${row.liveConfig.exits.runner}`;
    const metrics = row.livePaper.status === 'DATA_DIR'
      ? `n=${row.livePaper.closedTrades}; open=${row.livePaper.openTrades}; win=${row.livePaper.winPct}; PF=${row.livePaper.profitFactor}; PnL=${row.livePaper.realisedPnl}`
      : 'UNKNOWN';
    lines.push(`| ${row.geography} | ${row.horizon} | ${row.side} | ${enabled} | ${entry} | ${exits} | ${row.liveConfig.pointInTimeReplayable} | ${row.backtestEvidence.study} | ${metrics} | ${row.execution} | ${row.driftFlag} |`);
  }
  lines.push('', '## Geography verdicts');
  for (const geo of geographies) {
    const live = report.cells.filter(r => r.geography === geo && r.liveConfig.enabled === true).length;
    lines.push(`- ${geo}: ${live}/6 confirmed enabled cells. Confirmed live cells are UNTESTED as exact configurations because current FMP financial scores are not point-in-time replayable.`);
  }
  const early = report.cells.filter(r => r.livePaper.tooEarly === true).map(r => `${r.geography}/${r.horizon}/${r.side}`);
  lines.push('', '## Required follow-up flags', '- Live DRIFT/UNTESTED: all enabled cells (exact production replay unavailable).', `- Live paper n < 30: ${early.length ? early.join(', ') : 'UNKNOWN (no readable ledger)'}.`, '- Live/backtest contradictions: UNKNOWN; no exact production backtest exists.', '');
  return lines.join('\n');
}

(async () => {
  const render = await health();
  const h = render.data;
  const paper = paperByCell();
  const deployCommit = h?.deployCommit || null;
  const codeCommit = git('rev-parse', 'HEAD');
  const report = {
    generatedAt: new Date().toISOString(),
    codeCommit,
    render: {
      healthUrl: render.url,
      deploy: h ? `server_build=${h.server_build || 'UNKNOWN'}; uptime_s=${h.uptime_s ?? 'UNKNOWN'}; commit=${h.deployCommit || 'UNKNOWN'}` : 'UNKNOWN',
      healthError: render.error,
      publicEnv: h ? {
        deployCommit: h.deployCommit || 'UNKNOWN',
        runtimeConfig: h.runtimeConfig || 'UNKNOWN',
        fmpKeyResolved: h.fmp && h.fmp.key_resolved,
        fmpPlan: h.fmp && h.fmp.plan,
        disabledBrackets: h.disabledBrackets || 'UNKNOWN',
      } : null,
    },
    errorTradePnlTotal: paper.errorPnl,
    paperSource: paper.available ? `${process.env.DATA_DIR || process.env.RENDER_DISK_MOUNT_PATH || path.join(ROOT, 'data')}/ibkr_fills.jsonl` : 'UNKNOWN',
    cells: geographies.flatMap(geo => horizons.flatMap(horizon => sides.map(side => cell(geo, horizon, side, paper, h?.runtimeConfig)))),
  };
  report.render.commitStatus = deployCommit ? (deployCommit === codeCommit ? 'MATCH' : 'DRIFT') : 'UNKNOWN';
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(DOC, markdown(report));
  console.log(JSON.stringify({ output: OUT, document: DOC, cells: report.cells.length, codeCommit: report.codeCommit }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
