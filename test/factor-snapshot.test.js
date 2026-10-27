'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  percentileRank,
  buildCrossSectionalSnapshots,
  breakoutRetestAt,
  commodityProxyAt,
  indexByDate,
} = require('../lib/research/factor-snapshot');

function bars(values, start = Date.UTC(2020, 0, 1) / 1000) {
  return values.map((close, index) => ({
    t: start + index * 86400,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 1_000_000,
  }));
}

test('percentile rank uses a tie midpoint', () => {
  assert.equal(percentileRank([1, 2, 2, 4], 2), 0.5);
});

test('cross-sectional snapshots use only values available on that date', () => {
  const rising = bars(Array.from({ length: 225 }, (_, i) => 100 + i));
  const falling = bars(Array.from({ length: 225 }, (_, i) => 500 - i));
  const snapshots = buildCrossSectionalSnapshots([
    { symbol: 'UP', bars: rising },
    { symbol: 'DOWN', bars: falling },
  ]);
  const date = new Date(rising[220].t * 1000).toISOString().slice(0, 10);
  const up = snapshots.get(`UP|${date}`);
  const down = snapshots.get(`DOWN|${date}`);
  assert.ok(up.rsPercentile > down.rsPercentile);
  assert.equal(up.constituentCount, 2);
  assert.equal(up.breadth50, 0.5);
  assert.equal(up.breadth200, 0.5);

  rising[224].c = 1_000_000;
  const rebuilt = buildCrossSectionalSnapshots([
    { symbol: 'UP', bars: rising },
    { symbol: 'DOWN', bars: falling },
  ]);
  assert.deepEqual(rebuilt.get(`UP|${date}`), up);
});

test('breakout retest does not inspect bars after the snapshot index', () => {
  const series = bars(Array.from({ length: 30 }, () => 100));
  series[20] = { ...series[20], o: 101, h: 106, l: 101, c: 105 };
  series[21] = { ...series[21], o: 103, h: 104, l: 101.5, c: 103 };
  series[22] = { ...series[22], o: 104, h: 107, l: 103, c: 106 };
  const at22 = breakoutRetestAt(series, 22, 'buy', { lookback: 20, retestWindow: 6 });
  assert.equal(at22.pass, true);
  series[23] = { ...series[23], o: 50, h: 500, l: 1, c: 400 };
  assert.deepEqual(
    breakoutRetestAt(series, 22, 'buy', { lookback: 20, retestWindow: 6 }),
    at22,
  );
});

test('commodity snapshot labels proxies and blocks high-volatility Wednesdays', () => {
  const start = Date.UTC(2023, 0, 1) / 1000;
  const commodityBars = bars(Array.from({ length: 180 }, (_, i) => 80 + i * 0.2), start);
  const proxyBars = bars(Array.from({ length: 180 }, (_, i) => 70 + i * 0.1), start);
  const proxy = { bars: proxyBars, index: indexByDate(proxyBars) };
  const proxies = new Map([
    ['CL=F', { bars: commodityBars, index: indexByDate(commodityBars) }],
    ['BZ=F', proxy],
    ['USO', proxy],
    ['DBC', proxy],
  ]);
  const result = commodityProxyAt(
    { market: 'Commodities', symbol: 'CL=F', bars: commodityBars },
    170,
    'buy',
    proxies,
  );
  assert.equal(result.applicable, true);
  assert.match(result.label, /proxies-not-inventory-or-futures-curve/);
  assert.ok(Object.hasOwn(result, 'brentWtiSpreadMomentum'));
  assert.ok(Object.hasOwn(result, 'rollYieldProxy'));
});
