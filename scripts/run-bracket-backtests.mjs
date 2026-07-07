/** One-off: hit local backtest API for all buy/sell × horizon brackets. */
const TICKERS = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AMD','JPM','BAC',
  'UNH','XOM','CVX','PEP','KO','WMT','HD','DIS','NFLX','COST',
  'ORCL','CSCO','INTC','IBM','GE','BA','CAT','GS','MS','ABBV'
].join(',');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const WINDOW = process.env.WINDOW || '252';

async function run(hz, side) {
  const url = `${BASE}/api/backtest/medium-sell?hz=${hz}&side=${side}&window=${WINDOW}&tickers=${encodeURIComponent(TICKERS)}`;
  const r = await fetch(url);
  const j = await r.json();
  return { hz, side, ok: r.ok, ...j };
}

const combos = [];
for (const hz of ['short', 'medium', 'long']) {
  for (const side of ['buy', 'sell']) combos.push([hz, side]);
}

const results = [];
for (const [hz, side] of combos) {
  process.stdout.write(`Running ${hz} ${side}... `);
  try {
    const j = await run(hz, side);
    results.push(j);
    const a = j.aggregate || {};
    console.log(`trades=${a.totalTrades ?? '?'} wr=${a.winRate ?? '?'}% avg=${a.avgReturnPct ?? '?'}% pf=${a.meanProfitFactor ?? '?'}`);
  } catch (e) {
    console.log('FAIL', e.message);
    results.push({ hz, side, error: e.message });
  }
}

console.log('\n=== AGGREGATE SUMMARY ===');
console.log(JSON.stringify(results.map(r => ({
  bracket: `${r.side || '?'} × ${r.hz || '?'}`,
  totalTrades: r.aggregate?.totalTrades,
  winRate: r.aggregate?.winRate,
  avgReturnPct: r.aggregate?.avgReturnPct,
  meanProfitFactor: r.aggregate?.meanProfitFactor,
  tickersTested: r.tickersTested,
  error: r.error
})), null, 2));
