'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

function fmpKeyPresent() {
  return Boolean(String(process.env.FMP_API_KEY || process.env.FMP_KEY || process.env.FINANCIAL_MODELING_PREP_API_KEY || '').trim());
}

function loadResearchEnv() {
  // Render injects the key into the environment and has no .env file.
  // A missing file must not hide a key that is already set.
  if (!fs.existsSync(ENV_FILE)) {
    return { envFile: ENV_FILE, loaded: false, keyPresent: fmpKeyPresent() };
  }
  // Node 22's parser keeps the secret in process.env; it is never logged.
  process.loadEnvFile(ENV_FILE);
  return {
    envFile: ENV_FILE,
    loaded: true,
    keyPresent: fmpKeyPresent()
  };
}

function assertFmpKey() {
  const state = loadResearchEnv();
  console.log(`FMP_API_KEY ${state.keyPresent ? 'PRESENT' : 'ABSENT'} (${state.loaded ? '.env loaded' : '.env missing'})`);
  if (!state.keyPresent) {
    throw new Error('FMP_API_KEY is absent in this research runtime; aborting before any FMP-dependent backtest.');
  }
  return state;
}

module.exports = { ROOT, ENV_FILE, loadResearchEnv, assertFmpKey };
