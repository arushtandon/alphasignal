'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyToWeeklyBars, weeklyBarsVisibleAt } = require('../lib/research/weekly-bars');

function day(offset, h, l, c) {
  const t = Math.floor(Date.UTC(2024, 0, 1 + offset) / 1000);
  return { t, o: c, h, l, c, v: 1000 };
}

function padWeeks(n) {
  const bars = [];
  for (let i = 0; i < n * 5; i++) {
    const px = 100 + (i % 5);
    bars.push(day(i, px + 1, px - 1, px));
  }
  return bars;
}

test('precomputed weekly bars do not leak later-week highs into earlier days', () => {
  const history = padWeeks(12);
  const weekStart = history.length;
  history.push(day(weekStart, 110, 100, 105));     // Mon
  history.push(day(weekStart + 1, 112, 101, 108)); // Tue
  history.push(day(weekStart + 2, 140, 107, 130)); // Wed spike
  history.push(day(weekStart + 3, 132, 120, 125)); // Thu
  history.push(day(weekStart + 4, 128, 118, 122)); // Fri

  const weeklyAll = dailyToWeeklyBars(history);
  const tueIdx = history.length - 4;
  const visible = weeklyBarsVisibleAt(weeklyAll, history[tueIdx].t, history.slice(0, tueIdx + 1));
  const current = visible[visible.length - 1];
  assert.ok(current.endT === history[tueIdx].t);
  assert.ok(current.h < 140, `Tuesday weekly high leaked Wednesday spike: ${current.h}`);
  assert.equal(current.h, 112);
});

test('completed Friday week is visible the following Monday', () => {
  const history = padWeeks(12);
  const weekStart = history.length;
  for (let i = 0; i < 5; i++) history.push(day(weekStart + i, 110 + i, 100, 105 + i));
  history.push(day(weekStart + 7, 120, 110, 118)); // next Monday
  const weeklyAll = dailyToWeeklyBars(history);
  const monday = history[history.length - 1];
  const visible = weeklyBarsVisibleAt(weeklyAll, monday.t, history);
  const prior = visible[visible.length - 2];
  assert.equal(prior.h, 114);
  assert.ok(prior.endT < monday.t);
});
