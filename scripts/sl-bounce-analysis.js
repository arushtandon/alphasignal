'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOG_DIR = path.join(__dirname, '..', 'ibkr-bridge', 'logs');
const FROM = '2026-09-01';
const TO = '2026-09-15';

function files() {
  return fs.readdirSync(LOG_DIR)
    .filter(f => /^bridge-2026-09-\d{2}\.log$/.test(f))
    .filter(f => f >= `bridge-${FROM}.log` && f <= `bridge-${TO}.log`)
    .map(f => path.join(LOG_DIR, f));
}

function parseLogs() {
  const stops = new Map();
  const entries = new Map();
  const reStop = /(\d{4}-\d{2}-\d{2}T[^\s]+)Z exec captured stop (.+?) (\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)\s*$/;
  const reEntry = /(\d{4}-\d{2}-\d{2}T[^\s]+)Z exec captured entry (.+?) (\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)/;
  for (const file of files()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      let m = line.match(reStop);
      if (m) {
        const key = m[2];
        const rec = stops.get(key) || { key, ticker: key.split('|')[0], hz: key.split('|')[1], recDay: key.split('|')[2], qty: 0, notional: 0, time: m[1] };
        const qty = Number(m[3]);
        rec.qty += qty;
        rec.notional += qty * Number(m[4]);
        rec.time = m[1];
        rec.side = 'buy';
        stops.set(key, rec);
        continue;
      }
      m = line.match(reEntry);
      if (m) {
        const key = m[2];
        const rec = entries.get(key) || { qty: 0, notional: 0 };
        const qty = Number(m[3]);
        rec.qty += qty;
        rec.notional += qty * Number(m[4]);
        entries.set(key, rec);
      }
    }
  }
  const rows = [];
  for (const rec of stops.values()) {
    const en = entries.get(rec.key);
    rec.stopPx = rec.qty > 0 ? rec.notional / rec.qty : null;
    rec.entryPx = en && en.qty > 0 ? en.notional / en.qty : null;
    rec.slDistPct = rec.entryPx > 0 ? (rec.entryPx - rec.stopPx) / rec.entryPx : null;
    rows.push(rec);
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

function yahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2mo`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const r = j.chart && j.chart.result && j.chart.result[0];
          if (!r) return resolve([]);
          const ts = r.timestamp || [];
          const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
          const bars = [];
          for (let i = 0; i < ts.length; i++) {
            bars.push({
              t: ts[i] * 1000,
              o: q.open && q.open[i],
              h: q.high && q.high[i],
              l: q.low && q.low[i],
              c: q.close && q.close[i]
            });
          }
          resolve(bars.filter(b => b.c > 0));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const rows = parseLogs();
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  for (const [ticker, list] of byTicker) {
    let bars = [];
    try { bars = await yahooChart(ticker); } catch (_) { bars = []; }
    await sleep(120);
    for (const rec of list) {
      const stopMs = Date.parse(rec.time + 'Z');
      const after = bars.filter(b => b.t >= stopMs - 6 * 3600 * 1000);
      const same = after[0] || null;
      const next3 = after.slice(0, 4);
      const rest = after.slice(0, 8);
      const maxH = rest.reduce((m, b) => Math.max(m, Number(b.h) || 0), 0);
      const lastC = rest.length ? rest[rest.length - 1].c : null;
      rec.sameDayClose = same && same.c;
      rec.sameDayHigh = same && same.h;
      rec.maxHighAfter = maxH || null;
      rec.lastCloseAfter = lastC;
      rec.recoveredToEntry = !!(rec.entryPx > 0 && maxH >= rec.entryPx);
      rec.recovered1pct = !!(rec.stopPx > 0 && maxH >= rec.stopPx * 1.01);
      rec.recovered2pct = !!(rec.stopPx > 0 && maxH >= rec.stopPx * 1.02);
      rec.survivesPlus1 = !!(rec.entryPx > 0 && rec.stopPx > 0 && same
        && same.l > rec.entryPx * 0.99); // if SL were 1% tighter? wait: wider SL is LOWER
      rec.survivesWider1 = !!(rec.entryPx > 0 && same && same.l > rec.entryPx * (1 - (Math.abs(rec.slDistPct || 0) + 0.01)));
      rec.survivesWider2 = !!(rec.entryPx > 0 && same && same.l > rec.entryPx * (1 - (Math.abs(rec.slDistPct || 0) + 0.02)));
      rec.bounceFromStopPct = rec.stopPx > 0 && maxH > 0 ? (maxH - rec.stopPx) / rec.stopPx : null;
      rec.bounceToEntryPct = rec.entryPx > 0 && rec.stopPx > 0 && rec.recoveredToEntry
        ? (rec.entryPx - rec.stopPx) / rec.entryPx : null;
      rec.nBars = rest.length;
    }
  }
  const unique = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    unique.push(r);
  }
  const recent = unique.filter(r => r.time >= '2026-09-08');
  const older = unique.filter(r => r.time < '2026-09-08');
  function stats(list, label) {
    const n = list.length;
    const withPx = list.filter(r => r.maxHighAfter > 0 && r.stopPx > 0);
    const rec1 = withPx.filter(r => r.recovered1pct).length;
    const rec2 = withPx.filter(r => r.recovered2pct).length;
    const recE = withPx.filter(r => r.recoveredToEntry).length;
    const sur1 = withPx.filter(r => r.survivesWider1).length;
    const sur2 = withPx.filter(r => r.survivesWider2).length;
    const avgSl = withPx.filter(r => r.slDistPct != null).reduce((s, r) => s + r.slDistPct, 0) / (withPx.filter(r => r.slDistPct != null).length || 1);
    const avgBounce = withPx.filter(r => r.bounceFromStopPct != null).reduce((s, r) => s + r.bounceFromStopPct, 0) / (withPx.length || 1);
    return {
      label, n, withPx: withPx.length,
      recovered1pct: rec1, recovered1pctRate: withPx.length ? rec1 / withPx.length : 0,
      recovered2pct: rec2, recovered2pctRate: withPx.length ? rec2 / withPx.length : 0,
      recoveredToEntry: recE, recoveredToEntryRate: withPx.length ? recE / withPx.length : 0,
      survivesWider1: sur1, survivesWider1Rate: withPx.length ? sur1 / withPx.length : 0,
      survivesWider2: sur2, survivesWider2Rate: withPx.length ? sur2 / withPx.length : 0,
      avgSlDistPct: avgSl, avgBounceFromStopPct: avgBounce
    };
  }
  const out = {
    recent: stats(recent, '8-15 Sep'),
    older: stats(older, '1-7 Sep'),
    all: stats(unique, '1-15 Sep'),
    trades: unique.map(r => ({
      ticker: r.ticker, key: r.key, time: r.time, qty: r.qty,
      entryPx: r.entryPx && +r.entryPx.toFixed(4),
      stopPx: r.stopPx && +r.stopPx.toFixed(4),
      slDistPct: r.slDistPct != null ? +(r.slDistPct * 100).toFixed(2) : null,
      sameDayHigh: r.sameDayHigh && +Number(r.sameDayHigh).toFixed(4),
      sameDayClose: r.sameDayClose && +Number(r.sameDayClose).toFixed(4),
      maxHighAfter: r.maxHighAfter && +Number(r.maxHighAfter).toFixed(4),
      bounceFromStopPct: r.bounceFromStopPct != null ? +(r.bounceFromStopPct * 100).toFixed(2) : null,
      recovered1pct: r.recovered1pct, recovered2pct: r.recovered2pct,
      recoveredToEntry: r.recoveredToEntry,
      survivesWider1: r.survivesWider1, survivesWider2: r.survivesWider2
    }))
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
