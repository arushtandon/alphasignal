'use strict';

const { applyCosts } = require('../research/cost-model');
const { nyParts } = require('./danelfin-sweep');

const WATCH_LABEL = 'Danelfin + AlphaSignal: not validated, forward test';
const NOTIONAL = 30000;

function emptyBook() {
  return {
    orders: false,
    label: WATCH_LABEL,
    notional: NOTIONAL,
    selections: [],
    open: [],
    closed: [],
  };
}

function lastWeekdayOfMonth(year, month) {
  const date = new Date(Date.UTC(year, month, 0));
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function fridayMediumDue(now, selectedFridays) {
  const ny = nyParts(now);
  if (ny.weekday !== 'Fri') return { due: false, date: ny.date };
  if (ny.minutes < 16 * 60 + 10) return { due: false, date: ny.date };
  if (selectedFridays && selectedFridays.has(ny.date)) return { due: false, date: ny.date };
  return { due: true, date: ny.date };
}

function monthlySelectionDue(now, selectedMonths) {
  const ny = nyParts(now);
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return { due: false, date: ny.date };
  if (ny.minutes < 16 * 60 + 10) return { due: false, date: ny.date };
  const [year, month] = ny.date.split('-').map(Number);
  const last = lastWeekdayOfMonth(year, month);
  if (ny.date !== last) return { due: false, date: ny.date, month: ny.date.slice(0, 7) };
  const key = ny.date.slice(0, 7);
  if (selectedMonths && selectedMonths.has(key)) return { due: false, date: ny.date, month: key };
  return { due: true, date: ny.date, month: key };
}

function featuresFromBars(bars, asOf) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const index = asOf ? indexOnOrBefore(bars, asOf) : bars.length - 1;
  if (index < 0) return null;
  const close = Number(bars[index].c);
  if (!(close > 0)) return null;
  let dollarAdv = null;
  if (index >= 19) {
    let total = 0;
    let ok = true;
    for (let i = index - 19; i <= index; i += 1) {
      if (!(Number(bars[i].c) > 0) || !(Number(bars[i].v) > 0)) ok = false;
      total += Number(bars[i].c) * Number(bars[i].v);
    }
    dollarAdv = ok ? total / 20 : null;
  }
  const prev6 = index >= 126 ? Number(bars[index - 126].c) : null;
  const recent = index >= 252 ? Number(bars[index - 21].c) : null;
  const base = index >= 252 ? Number(bars[index - 252].c) : null;
  return {
    close,
    dollarAdv,
    ret6: prev6 > 0 ? close / prev6 - 1 : null,
    ret12: recent > 0 && base > 0 ? recent / base - 1 : null,
    date: bars[index].date,
  };
}

function liquidAi10(row) {
  return row
    && Number(row.ai) === 10
    && Number(row.close) >= 5
    && Number(row.marketCap) >= 2e9
    && Number(row.dollarAdv) >= 20e6;
}

function byTicker(a, b) {
  return String(a.ticker).localeCompare(String(b.ticker));
}

// Same ordering as select() in data/run-u1-backtest.js. U2 M-BUY Danelfin k=1
// ranks that day's liquid AI=10 names by 12-1 and takes the first name that
// is not already in an open medium trade. The 6-month top-30% cut is the
// combined arm, not this book.
function selectMediumK1(rows, heldTickers) {
  const held = new Set(heldTickers || []);
  const pool = (rows || []).filter(row => row && row.ticker && !held.has(row.ticker) && row.tradable !== false && liquidAi10(row));
  pool.sort((a, b) => ((b.ret12 ?? -Infinity) - (a.ret12 ?? -Infinity)) || (a.ticker < b.ticker ? -1 : 1));
  return pool[0] || null;
}

function choosePicks(rows, open, horizons) {
  const wanted = horizons || { medium: true, long: true };
  const heldMedium = new Set((open || []).filter(row => row.horizon === 'medium').map(row => row.ticker));
  const heldLong = new Set((open || []).filter(row => row.horizon === 'long').map(row => row.ticker));
  const picks = [];
  if (wanted.medium) {
    const medium = selectMediumK1(rows, heldMedium);
    if (medium) picks.push(pickFrom(medium, 'medium', 'M-BUY'));
  }
  if (wanted.long) {
    const long = (rows || [])
      .filter(row => liquidAi10(row) && Number(row.piotroski) >= 6 && row.ret12 > 0 && !heldLong.has(row.ticker))
      .sort((a, b) => b.ret12 - a.ret12 || byTicker(a, b));
    for (const row of long.slice(0, 5)) picks.push(pickFrom(row, 'long', 'L-BUY'));
  }
  return picks;
}

function pickFrom(row, horizon, book) {
  return {
    ticker: row.ticker,
    horizon,
    book,
    orders: false,
    label: WATCH_LABEL,
    ai: row.ai,
    fundamental: row.fundamental,
    technical: row.technical,
    sentiment: row.sentiment,
    low_risk: row.low_risk,
    ret6: row.ret6,
    ret12: row.ret12,
    piotroski: row.piotroski,
  };
}

function newPosition(pick, signalDate) {
  return {
    ...pick,
    signalDate,
    status: 'pending',
    orders: false,
    label: WATCH_LABEL,
    model: { notional: NOTIONAL, pnl: null, status: 'pending' },
  };
}

function indexOnOrBefore(bars, date) {
  let found = -1;
  for (let index = 0; index < bars.length; index += 1) {
    if (bars[index].date <= date) found = index;
    else break;
  }
  return found;
}

function atr14(bars, index) {
  if (index < 14) return null;
  let total = 0;
  for (let i = index - 13; i <= index; i += 1) {
    const high = Number(bars[i].h);
    const low = Number(bars[i].l);
    const previous = Number(bars[i - 1].c);
    if (![high, low, previous].every(Number.isFinite)) return null;
    total += Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
  }
  return total / 14;
}

function holdDays(from, to) {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));
}

function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + months, day)).toISOString().slice(0, 10);
}

function withModel(position, fields) {
  const net = fields.gross == null ? null : applyCosts(fields.gross, {
    market: 'US',
    symbol: position.ticker,
    holdDays: holdDays(fields.entryDate, fields.exitDate || fields.entryDate),
    side: 'buy',
  });
  return {
    ...position,
    ...fields,
    orders: false,
    label: WATCH_LABEL,
    model: {
      notional: NOTIONAL,
      pnl: net ? Math.round(NOTIONAL * net.netReturn * 100) / 100 : null,
      net: net ? net.netReturn : null,
      status: fields.status,
    },
  };
}

function pending(position) {
  return withModel(position, { status: 'pending', gross: null, entry: null, entryDate: null, reason: null });
}

function markMedium(position, bars) {
  const signalIndex = indexOnOrBefore(bars, position.signalDate);
  if (signalIndex < 14) return pending(position);
  const atr = atr14(bars, signalIndex);
  const entryIndex = signalIndex + 1;
  if (!(atr > 0) || entryIndex >= bars.length) return pending(position);
  const entry = Number(bars[entryIndex].o);
  if (!(entry > 0)) return pending(position);
  const entryDate = bars[entryIndex].date;
  const tp1 = entry + 4.2 * atr;
  const tp2 = entry + 7.0 * atr;
  let stop = entry - 2.5 * atr;
  let took = false;
  let partial = 0;
  const closeOut = (gross, index, reason) => withModel(position, {
    status: 'closed',
    gross,
    reason,
    entry,
    entryDate,
    exitDate: bars[index].date,
  });
  for (let index = entryIndex; index < bars.length; index += 1) {
    const open = Number(bars[index].o);
    const high = Number(bars[index].h);
    const low = Number(bars[index].l);
    const close = Number(bars[index].c);
    const held = index - entryIndex;
    if (index > entryIndex && open <= stop) {
      const rest = open / entry - 1;
      return closeOut(took ? 0.5 * partial + 0.5 * rest : rest, index, took ? 'runner_gap_stop' : 'gap_stop');
    }
    if (low <= stop) {
      const fill = open < stop ? open : stop;
      const rest = fill / entry - 1;
      return closeOut(took ? 0.5 * partial + 0.5 * rest : rest, index, took ? 'runner_stop' : 'stop');
    }
    if (!took && high >= tp1) {
      took = true;
      partial = (open >= tp1 ? open : tp1) / entry - 1;
      stop = entry;
      if (high >= tp2) {
        const runner = (open >= tp2 ? open : tp2) / entry - 1;
        return closeOut(0.5 * partial + 0.5 * runner, index, 'target2');
      }
    } else if (took && high >= tp2) {
      const runner = (open >= tp2 ? open : tp2) / entry - 1;
      return closeOut(0.5 * partial + 0.5 * runner, index, 'target2');
    }
    if (held >= 63) {
      const rest = close / entry - 1;
      return closeOut(took ? 0.5 * partial + 0.5 * rest : rest, index, 'time');
    }
  }
  const last = bars.length - 1;
  const rest = Number(bars[last].c) / entry - 1;
  return withModel(position, {
    status: 'open',
    gross: took ? 0.5 * partial + 0.5 * rest : rest,
    reason: 'mark',
    entry,
    entryDate,
    exitDate: bars[last].date,
  });
}

function markLong(position, bars) {
  const signalIndex = indexOnOrBefore(bars, position.signalDate);
  const entryIndex = signalIndex + 1;
  if (signalIndex < 0 || entryIndex >= bars.length) return pending(position);
  const entry = Number(bars[entryIndex].o);
  const entryDate = bars[entryIndex].date;
  if (!(entry > 0)) return pending(position);
  const due = addMonths(entryDate, 6);
  for (let index = entryIndex + 1; index < bars.length; index += 1) {
    if (bars[index].date < due) continue;
    const price = Number(bars[index].o);
    if (!(price > 0)) continue;
    return withModel(position, {
      status: 'closed',
      gross: price / entry - 1,
      reason: 'hold_6m',
      entry,
      entryDate,
      exitDate: bars[index].date,
    });
  }
  const last = bars.length - 1;
  return withModel(position, {
    status: 'open',
    gross: Number(bars[last].c) / entry - 1,
    reason: 'mark',
    entry,
    entryDate,
    exitDate: bars[last].date,
  });
}

function markPosition(position, bars) {
  const series = Array.isArray(bars) ? bars : [];
  if (position.horizon === 'long') return markLong(position, series);
  return markMedium(position, series);
}

function cardsFromBook(book) {
  return [...(book.open || []), ...(book.closed || [])].map(row => ({
    ticker: row.ticker,
    horizon: row.horizon,
    book: row.book,
    orders: false,
    label: WATCH_LABEL,
    signalDate: row.signalDate,
    status: row.status,
    reason: row.reason || null,
    ai: row.ai,
    fundamental: row.fundamental,
    technical: row.technical,
    sentiment: row.sentiment,
    low_risk: row.low_risk,
    piotroski: row.piotroski,
    model: row.model,
  }));
}

async function updateForwardBook(deps) {
  const book = deps.readBook() || emptyBook();
  book.orders = false;
  book.label = WATCH_LABEL;
  book.notional = NOTIONAL;
  book.selections = book.selections || [];
  book.mediumDates = book.mediumDates || [];
  book.open = book.open || [];
  book.closed = book.closed || [];
  const now = deps.now();
  const mediumDue = fridayMediumDue(now, new Set(book.mediumDates));
  const longDue = monthlySelectionDue(now, new Set(book.selections.map(row => row.month)));
  let waitingForList = false;
  if (mediumDue.due || longDue.due) {
    const date = mediumDue.due ? mediumDue.date : longDue.date;
    const list = await deps.readAi10(date);
    if (!list) waitingForList = true;
    else if (list.truncated) {
      if (mediumDue.due) book.mediumDates.push(date);
      if (longDue.due) book.selections.push({ month: longDue.month, date, skipped: 'capped' });
    } else {
      const rows = [];
      for (const ticker of list.names || []) {
        const symbol = String(ticker).toUpperCase();
        const score = (list.scores && list.scores[symbol]) || {};
        const features = featuresFromBars(await deps.loadBars(symbol), date);
        if (!features) continue;
        const row = {
          ticker: symbol,
          ai: Number(score.aiscore),
          fundamental: score.fundamental,
          technical: score.technical,
          sentiment: score.sentiment,
          low_risk: score.low_risk,
          close: features.close,
          dollarAdv: features.dollarAdv,
          ret6: features.ret6,
          ret12: features.ret12,
          marketCap: await deps.loadCap(symbol),
          piotroski: null,
          tradable: true,
        };
        if (longDue.due && liquidAi10(row) && row.ret12 > 0) row.piotroski = await deps.loadPiotroski(symbol, date);
        rows.push(row);
      }
      const picks = choosePicks(rows, book.open, { medium: mediumDue.due, long: longDue.due });
      for (const pick of picks) book.open.push(newPosition(pick, date));
      if (mediumDue.due) book.mediumDates.push(date);
      if (longDue.due) book.selections.push({ month: longDue.month, date, count: picks.filter(row => row.horizon === 'long').length });
    }
  }
  const stillOpen = [];
  for (const position of book.open) {
    const marked = markPosition(position, await deps.loadBars(position.ticker));
    if (marked.status === 'closed') book.closed.push(marked);
    else stillOpen.push(marked);
  }
  book.open = stillOpen;
  book.cards = cardsFromBook(book);
  book.waitingForList = waitingForList;
  deps.writeBook(book);
  return book;
}

module.exports = {
  WATCH_LABEL,
  NOTIONAL,
  emptyBook,
  lastWeekdayOfMonth,
  fridayMediumDue,
  monthlySelectionDue,
  featuresFromBars,
  selectMediumK1,
  choosePicks,
  markPosition,
  updateForwardBook,
  cardsFromBook,
};
