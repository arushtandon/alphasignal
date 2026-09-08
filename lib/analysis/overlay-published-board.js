'use strict';

/**
 * Full analysis must match today's published dashboard pick for that ticker.
 * /api/analyze used to recompute live quant (often <62% conf, blank TP/SL)
 * while the board still showed Buy — SHEL.L medium 8 Sep.
 */

const HORIZONS = ['short', 'medium', 'long'];
const PANES = [
  { pane: 'short', hz: 'short', side: 'buy' },
  { pane: 'medium', hz: 'medium', side: 'buy' },
  { pane: 'long', hz: 'long', side: 'buy' },
  { pane: 'shortSell', hz: 'short', side: 'sell' },
  { pane: 'medSell', hz: 'medium', side: 'sell' },
  { pane: 'longSell', hz: 'long', side: 'sell' }
];

function normTicker(t) {
  return String(t || '').trim().toUpperCase();
}

function pickToDashData(pick) {
  const data = {
    short: [], medium: [], long: [],
    shortSell: [], medSell: [], longSell: []
  };
  if (!pick || !pick.ticker) return data;
  let anyHz = false;
  for (const hz of HORIZONS) {
    const act = String(pick[hz + 'Action'] || '').toLowerCase();
    if (act === 'buy') {
      data[hz].push(pick);
      anyHz = true;
    } else if (act === 'sell') {
      const pane = hz === 'medium' ? 'medSell' : hz === 'long' ? 'longSell' : 'shortSell';
      data[pane].push(pick);
      anyHz = true;
    }
  }
  if (!anyHz) {
    const act = String(pick.action || '').toLowerCase();
    const hz = HORIZONS.includes(String(pick.hz || '')) ? pick.hz : 'short';
    if (act === 'buy') data[hz].push(pick);
    else if (act === 'sell') {
      const pane = hz === 'medium' ? 'medSell' : hz === 'long' ? 'longSell' : 'shortSell';
      data[pane].push(pick);
    }
  }
  return data;
}

function publishedHitsForTicker(dashData, ticker) {
  if (!dashData || !ticker) return [];
  const want = normTicker(ticker);
  const hits = [];
  for (const { pane, hz, side } of PANES) {
    for (const p of dashData[pane] || []) {
      if (p && normTicker(p.ticker) === want) hits.push({ pick: p, hz, side });
    }
  }
  return hits;
}

function overlayPublishedBoardOnAnalyzeRow(row, dashData, minConf) {
  if (!row || !row.ticker) return row;
  const floor = Number(minConf) > 0 ? Number(minConf) : 62;
  const data = dashData && (dashData.short || dashData.medium || dashData.long
    || dashData.shortSell || dashData.medSell || dashData.longSell)
    ? dashData
    : pickToDashData(dashData);
  const hits = publishedHitsForTicker(data, row.ticker);
  if (!hits.length) return row;
  for (const { pick, hz, side } of hits) {
    const act = pick[hz + 'Action'] || pick.action;
    if (act !== 'Buy' && act !== 'Sell') continue;
    const conf = Number(pick[hz + 'Conf'] || pick.conf || 0);
    const entry = pick[hz + 'Entry'] != null && pick[hz + 'Entry'] !== ''
      ? pick[hz + 'Entry'] : pick.entry;
    const tp1 = pick[hz + 'Target1'] != null && pick[hz + 'Target1'] !== ''
      ? pick[hz + 'Target1'] : pick.target1;
    const tp2 = pick[hz + 'Target2'] != null && pick[hz + 'Target2'] !== ''
      ? pick[hz + 'Target2'] : pick.target2;
    const sl = pick[hz + 'StopLoss'] != null && pick[hz + 'StopLoss'] !== ''
      ? pick[hz + 'StopLoss'] : pick.stopLoss;
    if (!(conf >= floor) || !(parseFloat(entry) > 0) || !(parseFloat(sl) > 0)) continue;
    row[hz + 'Action'] = act;
    row[hz + 'Rating'] = pick[hz + 'Rating'] || pick.rating || act;
    row[hz + 'Conf'] = Math.round(conf);
    row[hz + 'Entry'] = String(entry);
    row[hz + 'Target1'] = tp1 != null && tp1 !== '' ? String(tp1) : '';
    row[hz + 'Target2'] = tp2 != null && tp2 !== '' ? String(tp2) : '';
    row[hz + 'StopLoss'] = String(sl);
    if (pick[hz + 'Score'] != null) row[hz + 'Score'] = pick[hz + 'Score'];
    if (side === 'sell') {
      row.sellEntry = String(entry);
      row.sellTarget1 = tp1 != null && tp1 !== '' ? String(tp1) : '';
      row.sellTarget2 = tp2 != null && tp2 !== '' ? String(tp2) : '';
      row.sellStopLoss = String(sl);
    }
  }
  if (row.shortEntry) {
    row.entry = row.shortEntry;
    row.target1 = row.shortTarget1;
    row.target2 = row.shortTarget2;
    row.stopLoss = row.shortStopLoss;
    if (row.shortAction) row.action = row.shortAction;
  }
  return row;
}

module.exports = {
  overlayPublishedBoardOnAnalyzeRow,
  publishedHitsForTicker,
  pickToDashData
};
