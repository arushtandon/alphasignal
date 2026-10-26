'use strict';

// Requiring server.js (research runners, forked workers, tests) must perform no
// file writes. Boot-time ledger/history/risk-state repairs may only run when
// server.js is the main module. See bootRepair / BOOT_WRITES_ENABLED in server.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

// A ledger row that satisfies isStampInflatedCorrectedFill (entry, avg-correct,
// pence scale, corrected price ~0.5% above the tape print), so the boot
// stamp-restore repair WOULD rewrite the file if it were allowed to run.
const STAMP_INFLATED_ROW = {
  key: 'SHEL.L|medium|Tue Sep 08 2026', ticker: 'SHEL.L', role: 'entry', side: 'buy',
  qty: 100, price: 3542, priceCorrectedFrom: 3523, ccyScale: 100, recon: 'avg-correct',
  execId: 'test-exec-1', time: '2026-09-08T08:00:00.000Z',
};

const CHILD = `
const fs = require('fs');
const hits = [];
const record = (name, args) => hits.push(name + ' ' + String(args[0]));
for (const name of ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'unlinkSync',
  'mkdirSync', 'rmSync', 'rmdirSync', 'truncateSync', 'writeSync', 'createWriteStream']) {
  const orig = fs[name];
  fs[name] = function (...args) { record(name, args); return orig.apply(this, args); };
}
const origOpen = fs.openSync;
fs.openSync = function (...args) {
  if (/[wa+]/.test(String(args[1] || 'r'))) record('openSync', args);
  return origOpen.apply(this, args);
};
for (const name of ['writeFile', 'appendFile', 'rename', 'copyFile', 'unlink', 'mkdir', 'rm', 'truncate']) {
  const orig = fs.promises[name];
  fs.promises[name] = function (...args) { record('promises.' + name, args); return orig.apply(this, args); };
}
const mod = require(process.argv[1]);
let ledgerWriteBlocked = false;
try { mod.writeIbkrFillRows([]); } catch (e) { ledgerWriteBlocked = /disabled outside the serving process/.test(e.message); }
setTimeout(() => {
  process.stdout.write('\\n__RESULT__' + JSON.stringify({ hits, ledgerWriteBlocked }) + '\\n');
  process.exit(0);
}, 1500);
`;

test('requiring server.js performs no file writes and cannot rewrite the fill ledger', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alphasignal-nowrite-'));
  try {
    const ledger = path.join(dataDir, 'ibkr_fills.jsonl');
    fs.writeFileSync(ledger, `${JSON.stringify(STAMP_INFLATED_ROW)}\n`);
    fs.writeFileSync(path.join(dataDir, 'history_data.json'), JSON.stringify({ version: 2, data: [] }));
    const before = fs.readFileSync(ledger, 'utf8');
    const entriesBefore = fs.readdirSync(dataDir).sort();

    const run = spawnSync(process.execPath, ['-e', CHILD, path.join(REPO, 'server.js')], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        RESEARCH_MODE: '1',
        AUTH_TEST_BYPASS: '1',
        PORT: '0',
        DATABASE_URL: '',
      },
    });
    const marker = run.stdout.lastIndexOf('__RESULT__');
    assert.ok(marker >= 0, `child produced no result\nstdout: ${run.stdout.slice(-2000)}\nstderr: ${run.stderr.slice(-2000)}`);
    const result = JSON.parse(run.stdout.slice(marker + '__RESULT__'.length).split('\n')[0]);

    assert.deepEqual(result.hits, [], `requiring server.js wrote to disk:\n${result.hits.join('\n')}`);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before, 'fill ledger changed on require');
    assert.deepEqual(fs.readdirSync(dataDir).sort(), entriesBefore, 'data dir gained/lost files on require');
    assert.equal(result.ledgerWriteBlocked, true, 'writeIbkrFillRows must throw outside the serving process');
    assert.doesNotMatch(run.stderr, /boot stamp-restore failed/, 'stamp-restore must not run on require');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ISOLATED_DATA_DIR_WRITES is ignored when DATA_DIR is the repo data dir', () => {
  // The harness opt-in must not be usable against the real ledger. Point
  // DATA_DIR at ./data with the flag set: the ledger write must still throw.
  // (Nothing is written because the guard stays off; read-only otherwise.)
  const run = spawnSync(process.execPath, ['-e', CHILD, path.join(REPO, 'server.js')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      DATA_DIR: path.join(REPO, 'data'),
      ISOLATED_DATA_DIR_WRITES: '1',
      RESEARCH_MODE: '1',
      AUTH_TEST_BYPASS: '1',
      PORT: '0',
      DATABASE_URL: '',
    },
  });
  const marker = run.stdout.lastIndexOf('__RESULT__');
  assert.ok(marker >= 0, `child produced no result\nstderr: ${run.stderr.slice(-2000)}`);
  const result = JSON.parse(run.stdout.slice(marker + '__RESULT__'.length).split('\n')[0]);
  assert.deepEqual(result.hits, [], `opt-in against ./data wrote to disk:\n${result.hits.join('\n')}`);
  assert.equal(result.ledgerWriteBlocked, true, 'opt-in must be ignored for the repo data dir');
});
