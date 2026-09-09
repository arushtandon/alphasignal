'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HORIZON_BLEND,
  HORIZON_WEIGHTING_LABELS,
  applyYahooFundGates,
  applyHorizonQualityBlend,
  buildPreciseTradeThesis,
  looksGenericReason
} = require('../lib/strategy/horizon-blend');

test('horizon mix is technical + FMP + fundamentals, not Danelfin', () => {
  assert.equal(HORIZON_BLEND.short.technical + HORIZON_BLEND.short.fmp + HORIZON_BLEND.short.fund, 1);
  assert.equal(HORIZON_BLEND.medium.fmp, 0.30);
  assert.equal(HORIZON_BLEND.long.fund, 0.35);
  assert.match(HORIZON_WEIGHTING_LABELS.medium, /30% FMP/);
});

test('short fundamentals are a veto on collapsing earnings', () => {
  const cut = applyYahooFundGates('short', { earningsGrowth: -18, revenueGrowth: 2 });
  assert.ok(cut.buyMult < 0.7);
  assert.ok(cut.condBuy.some((c) => /EPS/.test(c)));
  const ok = applyYahooFundGates('short', { earningsGrowth: 24, revenueGrowth: 14 });
  assert.ok(ok.buyDelta > 0);
});

test('medium fundamentals add EPS/rev gates; long is a no-op here', () => {
  const med = applyYahooFundGates('medium', { earningsGrowth: 18, revenueGrowth: 14, pegRatio: 1.1 });
  assert.ok(med.buyDelta >= 1.5);
  assert.ok(med.condBuy.some((c) => /EPS \+18%/.test(c)));
  const long = applyYahooFundGates('long', { earningsGrowth: 40 });
  assert.equal(long.buyDelta, 0);
});

test('FMP overlay does not require buy_track_record', () => {
  const sig = { buyScore: 70, sellScore: 20, conditions: ['Above MA200 — primary uptrend'] };
  applyHorizonQualityBlend(sig, { hz: 'medium', fmp: { qualityScore: 8, piotroski: 7, altmanZ: 3.4 } });
  assert.ok(sig.buyScore > 70);
  assert.ok(sig.conditions.some((c) => /FMP quality 8\/10/.test(c)));
  assert.equal(sig.tier, 1);
});

test('weak FMP cuts a short buy without a track-record flag', () => {
  const sig = { buyScore: 72, sellScore: 10, conditions: [] };
  applyHorizonQualityBlend(sig, { hz: 'short', fmp: { piotroski: 2, qualityScore: 3 } });
  assert.ok(sig.buyScore < 50);
  assert.ok(sig.conditions.some((c) => /Piotroski 2\/9/.test(c)));
});

test('thesis is layman: why buy, company check, mix, levels, walk away', () => {
  const text = buildPreciseTradeThesis({
    hz: 'medium',
    isSell: false,
    rating: 'Strong Buy',
    score: 80,
    regime: 'bull',
    conditions: ['MA200 bull regime + Golden Cross', 'SD channel pullback in uptrend'],
    fmp: { piotroski: 7, qualityScore: 8, altmanZ: 3.2 },
    fund: { earningsGrowth: 12, revenueGrowth: 8, pegRatio: 1.2 },
    entry: 100, tp1: 114, tp2: 122, sl: 90
  });
  assert.match(text, /Why buy:/);
  assert.match(text, /50-day average is above the 200-day/);
  assert.match(text, /pullback inside an uptrend/);
  assert.match(text, /company quality from FMP \(30%\)/);
  assert.match(text, /company finances look healthy \(7\/9/);
  assert.match(text, /earnings grew 12%/);
  assert.match(text, /Levels:/);
  assert.match(text, /you stand to make about 1\.4×/);
  assert.match(text, /Walk away if the weekly trend turns down/);
  assert.equal(/Setup:/.test(text), false);
  assert.equal(/Invalid if/.test(text), false);
  assert.equal(looksGenericReason(text), false);
  assert.equal(looksGenericReason('Buy @ 100 · TP1 110 · SL 90 | Strong Buy (80/100) — levels locked at signal.'), true);
});

test('old dashboard jargon is rebuilt into a why-buy thesis', () => {
  const old = 'Buy @ 2260.5 - TP1 2368.53 (+3.7%) - TP2 2392.8 (+4.9%) - SL 2208.25 (-3.1%) - RR 1.2:1. Piotroski 8/9; SD channel: below lower band (statistical discount); At MA50 support; RSI(2) 9.7 washed out';
  assert.equal(looksGenericReason(old), true);
  const rebuilt = buildPreciseTradeThesis({
    hz: 'short',
    isSell: false,
    rating: 'Strong Buy',
    score: 88,
    conditions: [],
    sourceWhy: old,
    fmp: { piotroski: 8 },
    entry: 2260.5, tp1: 2368.53, tp2: 2392.8, sl: 2208.25
  });
  assert.match(rebuilt, /Why buy:/);
  assert.match(rebuilt, /discount/i);
  assert.match(rebuilt, /50-day average/);
  assert.match(rebuilt, /oversold reading 9\.7/);
  assert.match(rebuilt, /healthy \(8\/9/);
  assert.match(rebuilt, /Walk away if/);
});
