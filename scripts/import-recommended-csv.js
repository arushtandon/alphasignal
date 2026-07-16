#!/usr/bin/env node
/**
 * One-shot: import a dashboard recommended CSV into data/history_data.json
 * Usage: node scripts/import-recommended-csv.js [path-to-csv]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const HISTORY = path.join(DATA, 'history_data.json');
const csvPath = process.argv[2]
  || path.join(DATA, 'pending_history_import', 'alphasignal-recommended-2026-07-15.csv')
  || path.join(require('os').homedir(), 'Downloads', 'alphasignal-recommended-2026-07-15.csv');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function entryDateFromName(name) {
  const m = String(name || '').match(/(20\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z` : new Date().toISOString();
}

function hzOf(tf) {
  const s = String(tf || '').toLowerCase();
  if (s.startsWith('long')) return 'long';
  if (s.startsWith('medium') || s.startsWith('med')) return 'medium';
  return 'short';
}

function parseRecommended(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = (n) => headers.indexOf(n);
  const iTf = idx('timeframe'), iSide = idx('side'), iTk = idx('ticker');
  const iName = idx('name'), iMkt = idx('market'), iRating = idx('rating');
  const iScore = idx('score'), iEntry = idx('entry');
  const iTp1 = idx('target 1'), iTp2 = idx('target 2'), iSl = idx('stop loss');
  const iReason = idx('reason');
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCsvLine(lines[li]);
    const ticker = String(cols[iTk] || '').trim().toUpperCase();
    if (!ticker) continue;
    const side = String(cols[iSide] || '').trim().toLowerCase() === 'sell' ? 'sell' : 'buy';
    const hz = hzOf(cols[iTf]);
    const entry = parseFloat(cols[iEntry]);
    if (!Number.isFinite(entry) || entry <= 0) continue;
    rows.push({
      ticker, name: cols[iName] || ticker, market: cols[iMkt] || '',
      hz, side, rating: cols[iRating] || (side === 'sell' ? 'Sell' : 'Buy'),
      score: parseFloat(cols[iScore]), entry,
      tp1: parseFloat(cols[iTp1]), tp2: parseFloat(cols[iTp2]), sl: parseFloat(cols[iSl]),
      reason: cols[iReason] || ''
    });
  }
  return rows;
}

function toRecord(r, ts) {
  const hz = r.hz;
  const isSell = r.side === 'sell';
  const score = Number.isFinite(r.score) ? r.score : null;
  const tp1 = Number.isFinite(r.tp1) ? r.tp1 : null;
  const tp2 = Number.isFinite(r.tp2) ? r.tp2 : null;
  const sl = Number.isFinite(r.sl) ? r.sl : null;
  return {
    _v: 2,
    ticker: r.ticker, name: r.name, market: r.market, sector: '',
    hz, action: isSell ? 'Sell' : 'Buy', rating: r.rating, conf: score || 0,
    entryDate: ts, timestamp: ts,
    entry: r.entry, target1: tp1, target2: tp2, stopLoss: sl,
    [hz + 'Entry']: r.entry, [hz + 'Target1']: tp1, [hz + 'Target2']: tp2, [hz + 'StopLoss']: sl,
    [hz + 'TrailingSL']: true,
    sellEntry: r.entry, sellTarget1: isSell ? tp1 : null, sellTarget2: isSell ? tp2 : null, sellStopLoss: isSell ? sl : null,
    reason: r.reason,
    shortScore: hz === 'short' && !isSell ? score : null,
    mediumScore: hz === 'medium' && !isSell ? score : null,
    longScore: hz === 'long' && !isSell ? score : null,
    shortSellScore: hz === 'short' && isSell ? score : null,
    mediumSellScore: hz === 'medium' && isSell ? score : null,
    longSellScore: hz === 'long' && isSell ? score : null,
    [hz + 'Status']: 'open', [hz + 'PnlDollar']: null, [hz + 'PnlPct']: null,
    revalidatedAt: ts, analyticsVersion: 2, _fromRecommendedCsv: true
  };
}

function keyOf(t) {
  const hz = t.hz || 'short';
  const day = new Date(t.entryDate || t.timestamp || Date.now()).toDateString();
  return `${t.ticker}|${hz}|${day}`;
}

if (!fs.existsSync(csvPath)) {
  console.error('CSV not found:', csvPath);
  process.exit(1);
}

const csv = fs.readFileSync(csvPath, 'utf8');
const ts = entryDateFromName(path.basename(csvPath));
const rows = parseRecommended(csv);
const incoming = rows.map(r => toRecord(r, ts));
console.log('Parsed', incoming.length, 'rows from', csvPath, 'entryDate', ts);

let hist = [];
if (fs.existsSync(HISTORY)) {
  const raw = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  hist = Array.isArray(raw) ? raw : (raw.data || []);
}
const existing = new Map(hist.map(h => [keyOf(h), h]));
const incomingKeys = new Set(incoming.map(keyOf));
hist = hist.filter(h => !incomingKeys.has(keyOf(h)));
const accepted = [];
for (const t of incoming) {
  const prev = existing.get(keyOf(t));
  if (prev) {
    // Keep settled prev; otherwise prefer CSV levels but preserve any settled status
    const hz = t.hz;
    const st = prev[hz + 'Status'];
    if (['tp1_then_sl', 'tp1_then_time', 'sl_hit', 'time_limit', 'signal_exit', 'tp1_hit', 'tp2_hit'].includes(st)) {
      accepted.push(prev);
      continue;
    }
  }
  accepted.push(t);
}
hist = accepted.concat(hist);
fs.writeFileSync(HISTORY, JSON.stringify({ version: 3, data: hist }));
console.log('Wrote', accepted.length, 'Jul-15 restores; history total', hist.length);

const byDay = {};
for (const h of hist) {
  const d = new Date(h.entryDate || h.timestamp).toISOString().slice(0, 10);
  byDay[d] = (byDay[d] || 0) + 1;
}
console.log('Date counts:', byDay);
