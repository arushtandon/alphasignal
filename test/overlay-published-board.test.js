'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  overlayPublishedBoardOnAnalyzeRow,
  publishedHitsForTicker,
  pickToDashData
} = require('../lib/analysis/overlay-published-board');

test('published board pick overlays live analyze that dropped conf/targets', () => {
  const dashData = {
    medium: [{
      ticker: 'SHEL.L',
      mediumAction: 'Buy',
      mediumRating: 'Buy',
      mediumConf: 72,
      mediumScore: 78,
      mediumEntry: 3482.5,
      mediumTarget1: 3759,
      mediumTarget2: 3910,
      mediumStopLoss: 3262
    }]
  };
  const row = overlayPublishedBoardOnAnalyzeRow({
    ticker: 'SHEL.L',
    mediumAction: 'Hold',
    mediumRating: 'Buy',
    mediumConf: 42,
    mediumEntry: '',
    mediumTarget1: '',
    mediumTarget2: '',
    mediumStopLoss: ''
  }, dashData, 62);
  assert.equal(row.mediumAction, 'Buy');
  assert.equal(row.mediumConf, 72);
  assert.equal(row.mediumEntry, '3482.5');
  assert.equal(row.mediumTarget1, '3759');
  assert.equal(row.mediumStopLoss, '3262');
});

test('does not overlay a pick below the confidence floor', () => {
  const row = overlayPublishedBoardOnAnalyzeRow({
    ticker: 'FOO',
    mediumAction: 'Hold',
    mediumConf: 40
  }, {
    medium: [{ ticker: 'FOO', mediumAction: 'Buy', mediumConf: 50, mediumEntry: 1, mediumStopLoss: 0.9 }]
  }, 62);
  assert.equal(row.mediumAction, 'Hold');
  assert.equal(row.mediumConf, 40);
});

test('dashHint pick object is wrapped into pane data', () => {
  const data = pickToDashData({
    ticker: 'SHEL.L',
    mediumAction: 'Buy',
    mediumConf: 72,
    mediumEntry: 3482.5,
    mediumStopLoss: 3262
  });
  assert.equal(publishedHitsForTicker(data, 'SHEL.L').length, 1);
  const row = overlayPublishedBoardOnAnalyzeRow({
    ticker: 'SHEL.L', mediumAction: 'Hold', mediumConf: 42
  }, {
    ticker: 'SHEL.L',
    mediumAction: 'Buy',
    mediumConf: 72,
    mediumEntry: 3482.5,
    mediumTarget1: 3759,
    mediumStopLoss: 3262
  }, 62);
  assert.equal(row.mediumAction, 'Buy');
  assert.equal(row.mediumTarget1, '3759');
});
