#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scanExactDownload, loadLedger, shouldSuppressResubmit } = require('./lib/download-guard');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function compactDisk(s) {
  return {
    status: s.status,
    reason: s.reason || null,
    records: (s.records || []).map(r => ({
      fileName: r.fileName,
      archiveExists: r.archiveExists,
      archiveSize: r.archiveSize,
      unfinishedMeta: r.unfinishedMeta,
      unfinishedExists: r.unfinishedExists,
      unfinishedSize: r.unfinishedSize,
      version: r.meta?.version || '',
    })),
  };
}

function main() {
  const downloads = argValue('--downloads', process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads');
  const sharedStateDir = argValue('--shared-state-dir', path.resolve(__dirname, '..', '.runtime', 'state'));
  const ledgerFile = argValue('--ledger', path.join(sharedStateDir, 'submission-ledger.json'));
  const lockFile = argValue('--lock-file', path.join(sharedStateDir, 'download-executor.lock'));
  const ttlMin = Math.max(5, Number(argValue('--submission-ttl-min', '720')) || 720);
  const positional = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
  const modId = argValue('--mod-id', positional[0] || '');
  const fileId = argValue('--file-id', positional[1] || '');

  const ledger = loadLedger(ledgerFile);
  let lock = null;
  if (fs.existsSync(lockFile)) {
    try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
    catch { lock = { unreadable: true }; }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    downloads,
    ledgerFile,
    lockFile,
    executorLock: lock,
    ledgerSummary: Object.values(ledger.items || {}).reduce((acc, e) => {
      acc[e.status || 'UNKNOWN'] = (acc[e.status || 'UNKNOWN'] || 0) + 1;
      return acc;
    }, {}),
  };

  if (modId && fileId) {
    const key = `${modId}:${fileId}`;
    const disk = scanExactDownload(downloads, modId, fileId);
    const entry = ledger.items?.[key] || null;
    payload.target = {
      key,
      disk: compactDisk(disk),
      ledger: entry,
      resubmitGuard: shouldSuppressResubmit(entry, ttlMin * 60 * 1000),
    };
  } else {
    payload.activeLedgerItems = Object.entries(ledger.items || {})
      .filter(([, e]) => ['SUBMITTING', 'SUBMITTED', 'WAITING_EXISTING', 'VERIFY_TIMEOUT', 'POSSIBLY_SUBMITTED'].includes(e.status))
      .map(([key, e]) => ({ key, status: e.status, submittedAt: e.submittedAt || null, updatedAt: e.updatedAt || null, name: e.name || '' }));
  }

  console.log(JSON.stringify(payload, null, 2));
}

main();
