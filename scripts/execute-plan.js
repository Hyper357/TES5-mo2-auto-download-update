#!/usr/bin/env node
'use strict';

// 精确执行器：逐项提交 -> 轮询落盘 -> verify -> 持久化状态。
// 不自动重试签名下载；失败后标记并阻断同一 tx 的后续文件，避免错误扩散。

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function parseManifest(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(line => {
      const [modId, name, ver, note, fileId, action] = line.split('\t').map(x => (x || '').trim());
      return { modId, name, ver, note, fileId, action: action || 'HOLD_REVIEW' };
    });
}

function lineOf(r) {
  return [r.modId, r.name, r.ver, r.note, r.fileId, r.action].join('\t');
}

function txOf(row) {
  const m = String(row.note || '').match(/(?:^|;\s*)tx=([^;\s]+)/);
  return m ? m[1] : `${row.modId}:${row.fileId}`;
}

function rootKey(tx) {
  return tx;
}

function priority(row, tx) {
  const own = `${row.modId}:${row.fileId}`;
  if (own === rootKey(tx)) return 0;
  if (/closure:PATCH/i.test(row.note || '')) return 1;
  if (/closure:TRANSLATION/i.test(row.note || '')) return 2;
  return 3;
}

function loadState(file) {
  if (!file || !fs.existsSync(file)) return { version: 1, items: {}, transactions: {} };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { version: 1, items: {}, transactions: {} }; }
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function runNode(args) {
  const r = cp.spawnSync(process.execPath, args, {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyVerify(result) {
  const s = result?.status || 'UNKNOWN';
  if (s === 'VERIFIED') return 'VERIFIED';
  if (['MISSING_META', 'INCOMPLETE'].includes(s)) return 'PENDING';
  if (/^VERIFY_SEVENZIP_NOT_FOUND$/.test(s)) return 'FATAL_ENV';
  if (/MISMATCH|ARCHIVE_TEST_FAILED|VERIFY_ARCHIVE_TEST_FAILED/.test(s)) return 'FATAL_FILE';
  return 'PENDING';
}

async function verifyUntil({ tempManifest, autodl, downloads, sevenzip, timeoutSec, pollSec }) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const args = [autodl, 'verify', tempManifest, '--downloads', downloads, '--json'];
    if (sevenzip) args.push('--sevenzip', sevenzip);
    const r = runNode(args);
    if (r.ok) {
      try {
        const parsed = JSON.parse(r.stdout);
        last = Array.isArray(parsed) ? parsed[0] : parsed;
        const cls = classifyVerify(last);
        if (cls === 'VERIFIED') return { ok: true, result: last };
        if (cls.startsWith('FATAL_')) return { ok: false, fatal: true, result: last };
      } catch (_) {
        last = { status: 'VERIFY_OUTPUT_INVALID', sample: r.stdout.slice(0, 500) };
      }
    } else {
      last = { status: 'VERIFY_COMMAND_FAILED', stderr: r.stderr.slice(0, 500) };
    }
    await sleep(Math.max(1, pollSec) * 1000);
  }
  return { ok: false, fatal: false, timeout: true, result: last };
}

async function main() {
  const manifest = process.argv[2];
  if (!manifest) {
    console.error('用法: node execute-plan.js <run.tsv> --downloads DIR --installed-dir DIR --api-key-file FILE --state state.json');
    process.exit(2);
  }

  const downloads = argValue('--downloads');
  const installedDir = argValue('--installed-dir');
  const apiKeyFile = argValue('--api-key-file');
  const stateFile = argValue('--state', path.resolve(process.cwd(), 'execution-state.json'));
  const sevenzip = argValue('--sevenzip');
  const timeoutSec = Number(argValue('--timeout-sec', '1200')) || 1200;
  const pollSec = Number(argValue('--poll-sec', '5')) || 5;
  const continueOnError = process.argv.includes('--continue-on-error');
  const reconnect = process.argv.includes('--reconnect');
  const autodl = path.join(__dirname, 'nexus-autodl.js');

  for (const [name, value] of [['downloads', downloads], ['installed-dir', installedDir], ['api-key-file', apiKeyFile]]) {
    if (!value) throw new Error(`缺少 --${name}`);
  }

  const rows = parseManifest(manifest).filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const groups = new Map();
  for (const row of rows) {
    const tx = txOf(row);
    if (!groups.has(tx)) groups.set(tx, []);
    groups.get(tx).push(row);
  }
  for (const [tx, list] of groups) list.sort((a, b) => priority(a, tx) - priority(b, tx));

  const state = loadState(stateFile);
  state.manifest = path.resolve(manifest);
  state.startedAt = state.startedAt || new Date().toISOString();
  let failed = 0;
  let verified = 0;
  let skipped = 0;

  for (const [tx, list] of groups) {
    state.transactions[tx] = state.transactions[tx] || { status: 'RUNNING', items: [] };
    let txFailed = false;

    for (const row of list) {
      const itemKey = `${row.modId}:${row.fileId}`;
      if (state.items[itemKey]?.status === 'VERIFIED') {
        skipped++;
        state.transactions[tx].items.push(itemKey);
        continue;
      }
      if (txFailed) {
        state.items[itemKey] = { ...row, tx, status: 'BLOCKED_BY_TX_FAILURE', updatedAt: new Date().toISOString() };
        saveState(stateFile, state);
        continue;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-mo2-tx-'));
      const one = path.join(tmpDir, 'one.tsv');
      fs.writeFileSync(one, lineOf(row) + '\n', 'utf8');

      state.items[itemKey] = { ...row, tx, status: 'SUBMITTING', updatedAt: new Date().toISOString() };
      state.transactions[tx].items.push(itemKey);
      saveState(stateFile, state);

      const dlArgs = [
        autodl, 'dl', one, '--go', '--limit', '1', '--wait', '0',
        '--downloads', downloads, '--installed-dir', installedDir,
        '--api-key-file', apiKeyFile,
      ];
      if (reconnect) dlArgs.push('--reconnect');
      if (sevenzip) dlArgs.push('--sevenzip', sevenzip);

      const submitted = runNode(dlArgs);
      state.items[itemKey].submit = {
        ok: submitted.ok,
        status: submitted.status,
        stdout: submitted.stdout.slice(-2000),
        stderr: submitted.stderr.slice(-2000),
      };
      state.items[itemKey].status = submitted.ok ? 'SUBMITTED' : 'SUBMIT_FAILED';
      state.items[itemKey].updatedAt = new Date().toISOString();
      saveState(stateFile, state);

      if (!submitted.ok || /\b(ERROR|VERIFY-FAIL|VARIANT-MISMATCH|NOT-FOUND|NO-NXM-EXTRACTED)\b/i.test(submitted.stdout)) {
        state.items[itemKey].status = 'SUBMIT_FAILED';
        txFailed = true;
        failed++;
        saveState(stateFile, state);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        if (!continueOnError) break;
        continue;
      }

      const vr = await verifyUntil({ tempManifest: one, autodl, downloads, sevenzip, timeoutSec, pollSec });
      state.items[itemKey].verify = vr.result || null;
      state.items[itemKey].status = vr.ok ? 'VERIFIED' : (vr.timeout ? 'VERIFY_TIMEOUT' : 'VERIFY_FAILED');
      state.items[itemKey].updatedAt = new Date().toISOString();
      saveState(stateFile, state);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

      if (vr.ok) verified++;
      else {
        failed++;
        txFailed = true;
        if (!continueOnError) break;
      }
    }

    state.transactions[tx].status = txFailed ? 'FAILED' : 'VERIFIED';
    state.transactions[tx].updatedAt = new Date().toISOString();
    saveState(stateFile, state);
  }

  const payload = {
    stateFile,
    transactions: groups.size,
    items: rows.length,
    verified,
    skippedVerified: skipped,
    failed,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(`execute-plan failed: ${err.message}`);
  process.exit(1);
});
