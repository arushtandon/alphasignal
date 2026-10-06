'use strict';

const fs = require('fs');
const path = require('path');

const PAPER_FLAGS_FILE = process.env.SETUP_BOOK_PAPER_FLAGS_FILE
  || path.join(__dirname, '..', '..', 'config', 'setup-book-paper-flags.json');

function envEnabled(name) {
  return String(process.env[name] || '').trim() === '1';
}

function liveBridgeRole() {
  return String(process.env.IBKR_BRIDGE_ROLE || '').toLowerCase() === 'live'
    || process.argv.includes('live');
}

function readPaperFlags() {
  try {
    return JSON.parse(fs.readFileSync(PAPER_FLAGS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function applyPaperFlagsFromDisk() {
  if (liveBridgeRole()) return false;
  if (process.env.RESEARCH_MODE === '1') return false;
  if (process.env.AUTH_TEST_BYPASS === '1') return false;
  const flags = readPaperFlags();
  if (flags.SETUP_BOOK_ENABLED === true && !process.env.SETUP_BOOK_ENABLED) {
    process.env.SETUP_BOOK_ENABLED = '1';
  }
  if (flags.SETUP_BOOK_PAPER_EXECUTION === true && !process.env.SETUP_BOOK_PAPER_EXECUTION) {
    process.env.SETUP_BOOK_PAPER_EXECUTION = '1';
  }
  return envEnabled('SETUP_BOOK_ENABLED');
}

function setupBookEnabled() {
  return envEnabled('SETUP_BOOK_ENABLED');
}

function setupBookPaperExecutionEnabled() {
  if (liveBridgeRole()) return false;
  return setupBookEnabled() && envEnabled('SETUP_BOOK_PAPER_EXECUTION');
}

function fmpTierOverlayEnabled() {
  // The FMP-tier study was dropped. This flag must stay off.
  return false;
}

module.exports = {
  PAPER_FLAGS_FILE,
  liveBridgeRole,
  applyPaperFlagsFromDisk,
  setupBookEnabled,
  setupBookPaperExecutionEnabled,
  fmpTierOverlayEnabled,
};
