'use strict';

const SECTORS = Object.freeze([
  'communication-services',
  'consumer-discretionary',
  'consumer-staples',
  'energy',
  'financials',
  'health-care',
  'industrials',
  'information-technology',
  'materials',
  'real-estate',
  'utilities',
]);

const FIELDS = 'aiscore,fundamental,technical,sentiment,low_risk';

function nyParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  let hour = Number(value('hour'));
  if (hour === 24) hour = 0;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    weekday: value('weekday'),
    minutes: hour * 60 + Number(value('minute')),
  };
}

function previousWeekday(date) {
  const cursor = new Date(`${date}T00:00:00Z`);
  do { cursor.setUTCDate(cursor.getUTCDate() - 1); } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

function dailySweepDue(now, storedDates) {
  const ny = nyParts(now);
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return { due: false, date: ny.date };
  if (ny.minutes < 16 * 60 + 10) return { due: false, date: ny.date };
  if (storedDates && storedDates.has(ny.date)) return { due: false, date: ny.date };
  return { due: true, date: ny.date, calls: [{ purpose: 'live-ai-10', params: { date: ny.date, aiscore: 10, fields: FIELDS } }] };
}

function weeklySweepDue(now, storedWeeks) {
  const ny = nyParts(now);
  if (ny.weekday !== 'Sat') return { due: false, date: null };
  const date = previousWeekday(ny.date);
  if (storedWeeks && storedWeeks.has(date)) return { due: false, date };
  const calls = [];
  for (const score of [8, 9]) {
    for (const sector of SECTORS) {
      calls.push({
        purpose: `live-ai-${score}-sector`,
        params: { date, aiscore: score, sector, fields: FIELDS },
      });
    }
  }
  return { due: true, date, calls };
}

function sectorSplitCalls(date, score) {
  return SECTORS.map(sector => ({
    purpose: `live-ai-${score}-sector`,
    params: { date, aiscore: score, sector, fields: FIELDS },
  }));
}

function namesFromBody(body) {
  const names = [];
  const scores = {};
  const payload = body && typeof body === 'object' ? body : {};
  for (const [key, rows] of Object.entries(payload)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !rows || typeof rows !== 'object') continue;
    for (const [ticker, row] of Object.entries(rows)) {
      const symbol = String(ticker).toUpperCase();
      names.push(symbol);
      scores[symbol] = {
        aiscore: Number(row && row.aiscore),
        fundamental: Number(row && row.fundamental),
        technical: Number(row && row.technical),
        sentiment: Number(row && row.sentiment),
        low_risk: Number(row && row.low_risk),
        date: key,
      };
    }
  }
  return { names, scores, capped: names.length === 100 };
}

function isUsPick(pick) {
  const market = String(pick && (pick.market || pick.country) || '').toUpperCase();
  if (market === 'US' || market === 'UNITED STATES') return true;
  const ticker = String(pick && pick.ticker || '').toUpperCase();
  return ticker && !/[.=]/.test(ticker) && !/\.[A-Z]+$/.test(ticker);
}

function orderMode(pick, horizon, candidates) {
  if (!isUsPick(pick)) return 'unchanged';
  const ticker = String(pick.ticker || '').toUpperCase();
  const listed = candidates && candidates.has(ticker);
  if (horizon === 'short' && pick.setupId === 'US_SHORT_MR') return listed ? 'order' : 'block';
  if (horizon === 'medium' || horizon === 'long') return listed ? 'watch' : 'block';
  if (horizon === 'short') return 'block';
  return 'unchanged';
}

function scoreFromTickerBody(body, ticker) {
  const parsed = namesFromBody(body);
  const symbol = String(ticker || '').toUpperCase();
  if (parsed.scores[symbol]) return parsed.scores[symbol];
  let latest = null;
  const payload = body && typeof body === 'object' ? body : {};
  for (const [key, row] of Object.entries(payload)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !row || typeof row !== 'object' || row.aiscore == null) continue;
    if (latest && key <= latest.date) continue;
    latest = {
      aiscore: Number(row.aiscore),
      fundamental: Number(row.fundamental),
      technical: Number(row.technical),
      sentiment: Number(row.sentiment),
      low_risk: Number(row.low_risk),
      date: key,
    };
  }
  return latest;
}

function viewScoreSource(ticker, now, sources) {
  const symbol = String(ticker || '').toUpperCase();
  const sweep = sources.sweep && sources.sweep[symbol];
  if (sweep) return { action: 'free', score: sweep, from: 'sweep' };
  const cached = sources.cache && sources.cache[symbol];
  if (cached && now - Date.parse(cached.savedAt) <= 7 * 86400000) {
    return { action: 'cache', score: cached.score, from: 'cache' };
  }
  return { action: 'spend', from: 'view-lookups' };
}

module.exports = {
  SECTORS,
  FIELDS,
  nyParts,
  previousWeekday,
  dailySweepDue,
  weeklySweepDue,
  sectorSplitCalls,
  namesFromBody,
  isUsPick,
  orderMode,
  viewScoreSource,
  scoreFromTickerBody,
};
