'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  simulateTslOnlyAfterTp1,
  tslOnlyFieldsForTrade,
  TSL_ONLY_ANALYTICS_V
} = require('../lib/ibkr/tsl-only-sim');
const { tslAfterTp1 } = require('../lib/ibkr/tsl-policy');

const DAY = 86400;
const BASE = 1_700_000_000;

function barsFrom(rows) {
  return rows.map((r, i) => ({
    t: BASE + i * DAY,
    o: r.o, h: r.h, l: r.l, c: r.c
  }));
}

test('skip-TP2: TSL ratchets on up-opens, ignores TP2, exits later on TSL', () => {
  // TP1 day 1, TP2 would print day 2, then several +3% opens lift TSL above TP2,
  // then a dip tags TSL still above TP2 — skipping TP2 is the better call.
  const data = barsFrom([
    { o: 100, h: 104, l: 99, c: 103 },       // 0: no TP1
    { o: 104, h: 108, l: 103, c: 107.2 },    // 1: TP1 107
    { o: 110.2, h: 113, l: 109, c: 112 },    // 2: TP2 112 prints; TSL not hit
    { o: 115.4, h: 116, l: 114, c: 115.5 },  // 3
    { o: 119.0, h: 120, l: 118, c: 119 },    // 4
    { o: 122.6, h: 123, l: 121, c: 122 },    // 5
    { o: 125.7, h: 126, l: 124, c: 125 },    // 6  peak 126
    { o: 124.0, h: 124.5, l: 117.0, c: 118 } // 7  adverse open; TSL hit
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 107,
    tp2: 112,
    sl: 95,
    isSell: false,
    partialFrac: 0.5
  });
  assert.ok(sim);
  assert.equal(sim.tp1Hit, true);
  assert.equal(sim.tp2Printed, true);
  assert.equal(sim.status, 'tp1_then_sl');
  assert.equal(sim.tp2EarlyDays, 5); // sessions 7 − 2
  assert.ok(sim.exitPx > 112, 'TSL exit should be above TP2 after ratchets');
  assert.equal(sim.peakPx, 126);
  assert.ok(sim.peakToTp2DonPct > 8, 'peak 126 → TP2 112 is ~11% donation');
  assert.ok(sim.peakToTslDonPct > 0);
  assert.ok(sim.peakToTslDonPct < sim.peakToTp2DonPct, 'TSL donates less than taking TP2 vs the high');
  assert.ok(sim.tp2VsTslDeltaPct > 0, 'TSL-only PnL beats taking TP2');
  // Must not have exited at TP2 itself.
  assert.notEqual(sim.exitPx, 112);
});

test('both methods bank 50% at TP1; only the 50% runner exit differs', () => {
  const data = barsFrom([
    { o: 100, h: 104, l: 99, c: 103 },
    { o: 104, h: 108, l: 103, c: 107.2 },
    { o: 108, h: 116, l: 107, c: 115 },
    { o: 114, h: 114.5, l: 101.0, c: 102 }
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 107,
    tp2: 112,
    sl: 95,
    isSell: false,
    partialFrac: 0.5
  });
  const tp1Leg = 0.5 * ((107 - 100) / 100) * 100; // +3.5%
  const tp2Method = tp1Leg + 0.5 * ((112 - 100) / 100) * 100; // +9.5%
  assert.equal(sim.tp2ExitPnlPct, 9.5);
  assert.ok(Math.abs(sim.tslOnlyPnlPct - tp1Leg - 0.5 * ((sim.exitPx - 100) / 100) * 100) < 0.05);
  assert.notEqual(sim.tslOnlyPnlPct, sim.tp2ExitPnlPct);
  assert.ok(sim.tp2ExitPnlPct > tp1Leg, 'live method still includes the TP1 half');
  assert.ok(sim.tslOnlyPnlPct !== tp2Method || sim.exitPx !== 112);
});

test('skip-TP2: a dump after TP2 makes taking TP2 the correct call', () => {
  const data = barsFrom([
    { o: 100, h: 104, l: 99, c: 103 },
    { o: 104, h: 108, l: 103, c: 107.2 },     // TP1
    { o: 108, h: 116, l: 107, c: 115 },       // TP2 112 + peak 116
    { o: 114, h: 114.5, l: 101.0, c: 102 }    // dump tags TSL (~102) well below TP2
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 107,
    tp2: 112,
    sl: 95,
    isSell: false
  });
  assert.ok(sim);
  assert.equal(sim.status, 'tp1_then_sl');
  assert.ok(sim.tp2EarlyDays >= 1);
  assert.ok(sim.tp2VsTslDeltaPct < 0, 'taking TP2 beat riding TSL into the dump');
  assert.ok(sim.peakToTp2DonPct > 0, 'donation from high 116 down to TP2 112');
  assert.ok(sim.peakToTslDonPct > sim.peakToTp2DonPct, 'actual TSL donation is the larger giveback');
});

test('TSL ratchets on favorable opens and never loosens on adverse opens', () => {
  const start = tslAfterTp1({ entry: 100, tp1: 107, sl: 95, isSell: false });
  const data = barsFrom([
    { o: 100, h: 104, l: 99, c: 103 },
    { o: 104, h: 108, l: 103, c: 107 },  // TP1
    { o: 110, h: 111, l: 109, c: 110 },  // up open vs 107 → ratchet
    { o: 108, h: 109, l: 107.5, c: 108 } // down open → TSL unchanged; no hit (low 107.5 > tsl)
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 107,
    tp2: 130, // never prints
    sl: 95,
    isSell: false
  });
  assert.ok(sim);
  assert.equal(sim.status, 'tp1_open'); // TSL never tagged
  assert.equal(sim.tp2Printed, false);
  assert.equal(sim.tp2EarlyDays, null);
  assert.ok(sim.tsl > start, 'up-open must lift TSL');
  // Third session open 108 < prior close 110 → no loosen: TSL stays at the day-2 ratchet.
  const afterUp = start * (1 + (110 - 107) / 107);
  assert.ok(Math.abs(sim.tsl - afterUp) < 0.05);
});

test('short: TSL ratchets down on lower opens and ignores TP2', () => {
  const data = barsFrom([
    { o: 100, h: 101, l: 97, c: 98 },
    { o: 97, h: 98, l: 92, c: 93.2 },          // TP1 93
    { o: 90, h: 91, l: 87, c: 88 },            // TP2 88 prints
    { o: 85.4, h: 86, l: 84, c: 85 },          // lower open ratchets TSL down
    { o: 86, h: 97.8, l: 85, c: 96 }           // bounce tags TSL
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 93,
    tp2: 88,
    sl: 105,
    isSell: true
  });
  assert.ok(sim);
  assert.equal(sim.tp2Printed, true);
  assert.equal(sim.status, 'tp1_then_sl');
  assert.ok(sim.tp2EarlyDays >= 1);
  assert.ok(sim.exitPx < 100, 'short TSL stays at or below breakeven');
  assert.notEqual(sim.exitPx, 88);
  assert.ok(sim.peakPx <= 84); // best short extreme is the low
});

test('TSL never worse than breakeven after TP1', () => {
  const data = barsFrom([
    { o: 100, h: 101, l: 99, c: 100.5 },
    { o: 101, h: 108, l: 100.8, c: 107 },
    { o: 99, h: 100, l: 98, c: 99 } // would loosen if allowed; TSL stays >= entry so this tags
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 107,
    tp2: 120,
    sl: 95,
    isSell: false
  });
  assert.ok(sim);
  assert.ok(sim.tsl >= 100);
  assert.equal(sim.status, 'tp1_then_sl');
  assert.ok(sim.exitPx >= 100);
});

test('no TP1 print → no TSL-only path', () => {
  const data = barsFrom([
    { o: 100, h: 101, l: 99, c: 100 }
  ]);
  const sim = simulateTslOnlyAfterTp1({
    bars: data,
    entryMs: BASE * 1000,
    entry: 100,
    tp1: 107,
    tp2: 112,
    sl: 95,
    isSell: false
  });
  assert.equal(sim, null);
});

test('tslOnlyFieldsForTrade stamps frozen analytics without touching PnL keys', () => {
  const data = barsFrom([
    { o: 100, h: 104, l: 99, c: 103 },
    { o: 104, h: 108, l: 103, c: 107.2 },
    { o: 108, h: 116, l: 107, c: 115 },
    { o: 114, h: 114.5, l: 101.0, c: 102 }
  ]);
  const trade = {
    action: 'Buy',
    hz: 'medium',
    mediumEntry: 100,
    mediumTarget1: 107,
    mediumTarget2: 112,
    mediumStopLoss: 95,
    mediumPnl: 999, // must not be read or rewritten by the helper
    mediumStatus: 'tp2_hit'
  };
  const fields = tslOnlyFieldsForTrade(trade, 'medium', data, BASE * 1000, false);
  assert.equal(fields.TslOnlyV, TSL_ONLY_ANALYTICS_V);
  assert.ok(fields.PeakToTp2DonPct > 0);
  assert.ok(fields.PeakToTslDonPct > 0);
  assert.ok(fields.Tp2EarlyDays >= 1);
  assert.equal(trade.mediumPnl, 999);
  assert.equal(trade.mediumStatus, 'tp2_hit');
});
