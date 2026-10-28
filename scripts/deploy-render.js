'use strict';

// Deploy the current main commit to Render.
// Refuses a dirty tree, an unpushed HEAD, a commit whose CI is not green,
// the 04:30–07:30 SGT morning window, and 2 Nov 2026 07:00–10:00 SGT.
// Never prints RENDER_DEPLOY_HOOK_URL.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HEALTH_URL = 'https://alphasignal-dvg5.onrender.com/api/health';
const LOG_FILE = path.join(ROOT, 'docs', 'deploy-log.md');
const POLL_MS = 30 * 1000;
const POLL_BUDGET_MS = 15 * 60 * 1000;

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function singaporeParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type).value;
  let hour = Number(value('hour'));
  if (hour === 24) hour = 0;
  return {
    key: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: hour * 60 + Number(value('minute')),
  };
}

function refusalReason(date) {
  const { key, minutes } = singaporeParts(date);
  if (key === '2026-11-02' && minutes >= 7 * 60 && minutes <= 10 * 60) {
    return 'refusing deploy during the first momentum batch (2 Nov 2026 07:00–10:00 SGT)';
  }
  if (minutes >= 4 * 60 + 30 && minutes <= 7 * 60 + 30) {
    return 'refusing deploy during the morning scan window (04:30–07:30 SGT)';
  }
  return null;
}

function redact(text, hook) {
  const raw = String(text || '');
  return hook ? raw.split(hook).join('[deploy-hook]') : raw;
}

function originRepo() {
  const url = git(['remote', 'get-url', 'origin']);
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) throw new Error('origin is not a GitHub repository');
  return `${match[1]}/${match[2]}`;
}

function ciGreen(sha) {
  const repo = originRepo();
  const raw = execFileSync('gh', ['api', `repos/${repo}/commits/${sha}/check-runs`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const runs = JSON.parse(raw).check_runs || [];
  if (!runs.length) return false;
  return runs.every(run => run.status === 'completed' && run.conclusion === 'success');
}

function appendLog(commit, result) {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '# Deploy log\n\n| Time (SGT) | Commit | Result |\n| --- | --- | --- |\n');
  }
  const parts = singaporeParts(new Date());
  const hour = String(Math.floor(parts.minutes / 60)).padStart(2, '0');
  const minute = String(parts.minutes % 60).padStart(2, '0');
  fs.appendFileSync(LOG_FILE, `| ${parts.key} ${hour}:${minute} | ${commit} | ${result} |\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function healthCommit() {
  const response = await fetch(`${HEALTH_URL}?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  const body = await response.json();
  return String(body.deployCommit || '');
}

async function main() {
  loadEnvFile();
  const hook = process.env.RENDER_DEPLOY_HOOK_URL || '';
  const window = refusalReason(new Date());
  if (window) {
    console.error(window);
    process.exit(1);
  }
  git(['fetch', 'origin', 'main']);
  const head = git(['rev-parse', 'HEAD']);
  const origin = git(['rev-parse', 'origin/main']);
  if (head !== origin) {
    console.error('refusing deploy: HEAD is not pushed to origin/main');
    process.exit(1);
  }
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.error('refusing deploy: working tree is not clean');
    process.exit(1);
  }
  if (!ciGreen(head)) {
    console.error('refusing deploy: CI is not green for HEAD');
    process.exit(1);
  }
  if (!hook) {
    console.error('refusing deploy: RENDER_DEPLOY_HOOK_URL is not set');
    process.exit(1);
  }
  let hookStatus = 0;
  try {
    const response = await fetch(hook, { method: 'POST' });
    hookStatus = response.status;
    await response.arrayBuffer().catch(() => {});
  } catch (error) {
    console.error('deploy hook request failed:', redact(error.message, hook));
    appendLog(head, 'hook failed');
    process.exit(1);
  }
  if (hookStatus < 200 || hookStatus >= 300) {
    console.error(`deploy hook returned HTTP ${hookStatus}`);
    appendLog(head, `hook HTTP ${hookStatus}`);
    process.exit(1);
  }
  const deadline = Date.now() + POLL_BUDGET_MS;
  let serving = '';
  while (Date.now() <= deadline) {
    try {
      serving = await healthCommit();
      if (serving === head) {
        appendLog(head, 'success');
        console.log(`deploy success ${head}`);
        return;
      }
    } catch (error) {
      console.error('health poll failed:', redact(error.message, hook));
    }
    if (Date.now() + POLL_MS > deadline) break;
    await sleep(POLL_MS);
  }
  appendLog(head, 'timeout');
  console.error(`deploy timeout; health is ${serving || 'unavailable'}, wanted ${head}`);
  process.exit(1);
}

if (require.main === module) {
  main().catch(error => {
    console.error(redact(error && error.stack ? error.stack : error, process.env.RENDER_DEPLOY_HOOK_URL));
    process.exit(1);
  });
}

module.exports = { refusalReason, singaporeParts };
