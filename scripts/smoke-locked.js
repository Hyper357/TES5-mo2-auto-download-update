#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const path = require('path');
const { acquireExecutorLock, releaseExecutorLock } = require('./lib/download-guard');

const rootDir = path.resolve(__dirname, '..');
const lockFile = path.join(rootDir, '.runtime', 'state', 'download-executor.lock');
const lock = acquireExecutorLock(lockFile, { mode: 'SMOKE', runDir: path.join(rootDir, '.runtime', 'smoke') });
if (!lock.ok) {
  const o = lock.owner || {};
  console.error(`CONCURRENT_EXECUTOR: another executor is active pid=${o.pid || 'unknown'} runDir=${o.runDir || 'unknown'}`);
  process.exit(2);
}
try {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'smoke-direct-download.js'), ...process.argv.slice(2)], {
    cwd: rootDir, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = Number.isInteger(r.status) ? r.status : 2;
} finally {
  releaseExecutorLock(lock);
}
