'use strict';

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 90;

function diagnosticsDir(root) {
  return path.join(root, 'diagnostics');
}

function fileFor(root, day) {
  return path.join(diagnosticsDir(root), `scan-${day}.json`);
}

function pruneScanDiagnostics(root, keepDays = KEEP_DAYS, now = Date.now()) {
  const dir = diagnosticsDir(root);
  if (!fs.existsSync(dir)) return [];
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^scan-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!match) continue;
    const stamp = Date.parse(`${match[1]}T00:00:00Z`);
    if (Number.isFinite(stamp) && stamp < cutoff) {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    }
  }
  return removed;
}

function writeScanDiagnostic(root, day, snapshot) {
  const dir = diagnosticsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(root, day);
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  pruneScanDiagnostics(root);
  return file;
}

function readLatestScanDiagnostic(root) {
  const dir = diagnosticsDir(root);
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir)
    .filter(name => /^scan-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (!names.length) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = {
  KEEP_DAYS,
  writeScanDiagnostic,
  readLatestScanDiagnostic,
  pruneScanDiagnostics,
};
