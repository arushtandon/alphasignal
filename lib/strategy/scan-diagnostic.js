'use strict';

function blankSetup(setup) {
  return {
    setupId: setup.id,
    market: setup.market,
    horizon: setup.horizon,
    kind: setup.kind,
    inMorningScan: setup.kind !== 'momentum',
    paused: false,
    reason: null,
    symbolsScanned: 0,
    dailyUnder275: 0,
    triggers: 0,
    plans: 0,
    shortlist: 0,
    board: 0,
    drops: [],
  };
}

function createScanDiagnostic(meta, setups, pauseOf) {
  const markets = {};
  const byId = {};
  for (const setup of Object.values(setups || {})) {
    const row = blankSetup(setup);
    const pause = pauseOf(setup.id);
    row.paused = pause.paused === true;
    row.reason = pause.reason || null;
    byId[setup.id] = row;
  }
  const scanned = new Map();
  const under275 = new Map();
  const triggered = new Map();
  const planned = new Map();
  const shortlisted = new Map();
  const boarded = new Map();
  const dropped = new Map();
  function bucket(map, setupId) {
    if (!byId[setupId]) return null;
    if (!map.has(setupId)) map.set(setupId, new Set());
    return map.get(setupId);
  }
  return {
    meta: { ...meta },
    noteMarket(market, benchmark, rawBars, completedBars) {
      if (!market || markets[market]) return;
      markets[market] = {
        benchmark: benchmark || null,
        rawBars: benchmark ? (Array.isArray(rawBars) ? rawBars.length : 0) : null,
        completedBars: benchmark ? (Array.isArray(completedBars) ? completedBars.length : 0) : null,
      };
    },
    scanned(setupId, symbol, dailyBars) {
      const set = bucket(scanned, setupId);
      if (!set || !symbol) return;
      set.add(symbol);
      if (!(Number(dailyBars) >= 275)) {
        const short = bucket(under275, setupId);
        if (short) short.add(symbol);
      }
    },
    trigger(setupId, symbol) {
      const set = bucket(triggered, setupId);
      if (set && symbol) set.add(symbol);
    },
    plan(setupId, symbol) {
      const set = bucket(planned, setupId);
      if (set && symbol) set.add(symbol);
    },
    shortlist(setupId, symbol) {
      const set = bucket(shortlisted, setupId);
      if (set && symbol) set.add(symbol);
    },
    board(setupId, symbol) {
      const set = bucket(boarded, setupId);
      if (set && symbol) set.add(symbol);
      const gates = dropped.get(setupId);
      if (gates) gates.delete(symbol);
    },
    drop(setupId, symbol, gate) {
      if (!byId[setupId] || !symbol || !gate) return;
      if (!dropped.has(setupId)) dropped.set(setupId, new Map());
      dropped.get(setupId).set(symbol, gate);
    },
    snapshot(extra = {}) {
      const setupsOut = {};
      for (const [setupId, row] of Object.entries(byId)) {
        const gates = dropped.get(setupId) || new Map();
        const grouped = {};
        for (const [symbol, gate] of gates) {
          if (boarded.get(setupId)?.has(symbol)) continue;
          if (!grouped[gate]) grouped[gate] = [];
          grouped[gate].push(symbol);
        }
        for (const symbols of Object.values(grouped)) symbols.sort();
        setupsOut[setupId] = {
          ...row,
          symbolsScanned: scanned.get(setupId)?.size || 0,
          dailyUnder275: under275.get(setupId)?.size || 0,
          triggers: triggered.get(setupId)?.size || 0,
          plans: planned.get(setupId)?.size || 0,
          shortlist: shortlisted.get(setupId)?.size || 0,
          board: boarded.get(setupId)?.size || 0,
          drops: Object.keys(grouped).sort().map(gate => ({ gate, symbols: grouped[gate] })),
        };
      }
      return {
        ...this.meta,
        ...extra,
        markets,
        setups: setupsOut,
      };
    },
  };
}

module.exports = { createScanDiagnostic };
