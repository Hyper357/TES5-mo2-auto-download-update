#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanExactDownload,
  loadLedger,
  saveLedger,
  patchLedgerEntry,
  shouldSuppressResubmit,
  acquireExecutorLock,
  releaseExecutorLock,
} = require('./lib/download-guard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-guard-test-'));
const downloads = path.join(root, 'downloads');
const stateDir = path.join(root, 'state');
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

function meta(modId, fileId, version = '1.0') {
  return `modID=${modId}\nfileID=${fileId}\nversion=${version}\nname=Example\n`;
}

try {
  // ABSENT when no metadata exists.
  let s = scanExactDownload(downloads, '100', '200');
  assert.strictEqual(s.status, 'ABSENT');

  // Exact .meta without complete archive means MO2 has/knows an in-flight item.
  const archive = path.join(downloads, 'Example-200.zip');
  fs.writeFileSync(`${archive}.meta`, meta('100', '200'));
  s = scanExactDownload(downloads, '100', '200');
  assert.strictEqual(s.status, 'INFLIGHT');
  assert.strictEqual(s.reason, 'META_WITHOUT_COMPLETE_ARCHIVE');

  // A non-empty archive with exact meta is COMPLETE.
  fs.writeFileSync(archive, Buffer.from('archive'));
  s = scanExactDownload(downloads, '100', '200');
  assert.strictEqual(s.status, 'COMPLETE');

  // Residual unfinished sidecar makes the exact target in-flight again; it must not be re-submitted.
  fs.writeFileSync(`${archive}.unfinished`, Buffer.from('partial'));
  s = scanExactDownload(downloads, '100', '200');
  assert.strictEqual(s.status, 'INFLIGHT');
  assert.strictEqual(s.reason, 'UNFINISHED_ARCHIVE');
  fs.unlinkSync(`${archive}.unfinished`);

  // .unfinished.meta alone is also authoritative in-flight evidence.
  fs.writeFileSync(path.join(downloads, 'Other-301.zip.unfinished.meta'), meta('101', '301'));
  s = scanExactDownload(downloads, '101', '301');
  assert.strictEqual(s.status, 'INFLIGHT');
  assert.strictEqual(s.reason, 'UNFINISHED_META');

  // Cross-run ledger suppresses a recent submission.
  const ledgerFile = path.join(stateDir, 'submission-ledger.json');
  const ledger = loadLedger(ledgerFile);
  patchLedgerEntry(ledger, '102', '302', {
    status: 'SUBMITTED',
    submittedAt: new Date().toISOString(),
    name: 'Recent target',
  });
  saveLedger(ledgerFile, ledger);
  const loaded = loadLedger(ledgerFile);
  let guard = shouldSuppressResubmit(loaded.items['102:302'], 60 * 60 * 1000);
  assert.strictEqual(guard.suppress, true);
  assert.strictEqual(guard.reason, 'LEDGER_SUBMITTED');

  // Old active entry eventually becomes stale and does not silently suppress forever.
  loaded.items['102:302'].submittedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  guard = shouldSuppressResubmit(loaded.items['102:302'], 60 * 60 * 1000);
  assert.strictEqual(guard.suppress, false);
  assert.strictEqual(guard.reason, 'LEDGER_STALE');

  // VERIFIED remains guarded until the user explicitly resolves missing archive evidence.
  loaded.items['102:302'].status = 'VERIFIED';
  guard = shouldSuppressResubmit(loaded.items['102:302'], 1);
  assert.strictEqual(guard.suppress, true);
  assert.strictEqual(guard.reason, 'LEDGER_VERIFIED');

  // Only one executor may own the global lock.
  const lockFile = path.join(stateDir, 'executor.lock');
  const first = acquireExecutorLock(lockFile, { runDir: 'run-a' });
  assert.strictEqual(first.ok, true);
  const second = acquireExecutorLock(lockFile, { runDir: 'run-b' });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(Number(second.owner.pid), process.pid);
  assert.strictEqual(releaseExecutorLock(first), true);
  const third = acquireExecutorLock(lockFile, { runDir: 'run-c' });
  assert.strictEqual(third.ok, true);
  assert.strictEqual(releaseExecutorLock(third), true);

  console.log('download guard tests: OK');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
