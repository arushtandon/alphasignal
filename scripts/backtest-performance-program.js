#!/usr/bin/env node
'use strict';

/**
 * Backtest-only performance program coordinator.
 *
 * It intentionally never imports the live server, fetches FMP, or mutates
 * runtime configuration. With no verified Render/FMP PIT statements it writes
 * an explicit blocked/not-evaluable report instead of fabricating a replay.
 */
const fs = require('fs');
const path = require('path');
const {
  createPerformanceProgramReport,
  performanceProgramReadout,
} = require('../lib/research/performance-program');

const args = Object.fromEntries(process.argv.slice(2)
  .filter(value => value.startsWith('--'))
  .map(value => {
    const [key, raw] = value.slice(2).split('=');
    return [key, raw || '1'];
  }));
const root = path.join(__dirname, '..');
const capabilityPath = path.join(__dirname, args.capability || 'fmp-point-in-time-capability.json');
const outputPath = path.join(__dirname, args.output || 'backtest-performance-program-results.json');
const readoutPath = path.join(__dirname, args.readout || 'performance-program-readout.md');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const report = createPerformanceProgramReport({
  capability: readJson(capabilityPath),
  factorResults: readJson(path.join(__dirname, 'backtest-production-factor-overlays-results.json')),
  meanReversionResults: readJson(path.join(__dirname, 'backtest-usjp-regime-stabilize-results.json')),
});

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(readoutPath, performanceProgramReadout(report));
console.log(`Wrote ${path.relative(root, outputPath)}`);
console.log(`Wrote ${path.relative(root, readoutPath)}`);
