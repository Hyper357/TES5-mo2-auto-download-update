'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveJson } = require('./lib/fs-json');
const { executorLiveSnapshot, executorFailureSummary } = require('./lib/runtime');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-live-log-'));
try {
  const stateFile = path.join(dir, 'execution-state.json');
  saveJson(stateFile, {
    updatedAt: '2026-09-14T06:00:00.000Z',
    items: {
      '10:100': {
        modId: '10', fileId: '100', name: 'Verified Mod', status: 'VERIFIED',
      },
      '20:200': {
        modId: '20', fileId: '200', name: 'Broken Patch', status: 'DIRECT_DOWNLOAD_FAILED',
        attempts: [
          { attempt: 1, ok: false, errorCode: 'NXM_DOWNLOAD_CONTROL_MISSING' },
          { attempt: 2, ok: false, errorCode: 'NXM_EXTRACT_FAILED' },
        ],
      },
      '30:300': {
        modId: '30', fileId: '300', name: 'Downloading Mod', status: 'DIRECT_DOWNLOADING', attempt: 1, workerId: 0,
      },
    },
  });

  const runningJob = {
    status: 'RUNNING',
    jobDir: dir,
    state: stateFile,
    rows: [
      { modId: '10', fileId: '100' },
      { modId: '20', fileId: '200' },
      { modId: '30', fileId: '300' },
      { modId: '40', fileId: '400' },
    ],
  };

  const live = executorLiveSnapshot(runningJob);
  assert.strictEqual(live.planned, 4);
  assert.strictEqual(live.seen, 3);
  assert.strictEqual(live.verified, 1);
  assert.strictEqual(live.failedOrBlocked, 1);
  assert.strictEqual(live.active.length, 1);
  assert.strictEqual(live.active[0].exact, '30:300');
  assert.strictEqual(live.pending, 1);
  assert.strictEqual(live.failures.length, 1);
  assert.strictEqual(live.failures[0].exact, '20:200');
  assert.strictEqual(live.failures[0].errorCode, 'NXM_EXTRACT_FAILED');
  assert.strictEqual(live.failures[0].attempts.length, 2);

  const failed = executorFailureSummary({ ...runningJob, status: 'FAILED' });
  assert.strictEqual(failed.count, 1);
  assert.strictEqual(failed.primary.exact, '20:200');
  assert.strictEqual(failed.primary.errorCode, 'NXM_EXTRACT_FAILED');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('review live log tests: OK');
