'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildFailureReport,
  renderFailureLog,
  writeFailureArtifacts,
} = require('./lib/review-failure-log');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-failure-log-'));
try {
  const reviewRun = path.join(root, 'run');
  const jobDir = path.join(reviewRun, 'review-jobs', '2026-09-13T140000');
  fs.mkdirSync(jobDir, { recursive: true });
  const stateFile = path.join(jobDir, 'execution-state.json');
  const state = {
    items: {
      '150386:643721': {
        modId: '150386', fileId: '643721', name: 'VD - Dialogue Expansion - Windhelm Patch', ver: '2.0',
        status: 'DIRECT_DOWNLOAD_FAILED', tx: 'review:150386:selected-files', workerId: 1,
        attempts: [
          { attempt: 1, ok: false, errorCode: 'NXM_DOWNLOAD_CONTROL_MISSING' },
          { attempt: 2, ok: false, errorCode: 'NXM_EXTRACT_FAILED' },
        ],
      },
      '150386:643722': {
        modId: '150386', fileId: '643722', name: 'Dependent patch', ver: '2.0',
        status: 'BLOCKED_BY_TX_FAILURE', tx: 'review:150386:selected-files',
      },
      '57863:123': {
        modId: '57863', fileId: '123', name: 'sztkUtilAE', ver: '1.0', status: 'VERIFIED',
      },
    },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

  const report = buildFailureReport(state, { jobId: 'job', jobDir, stateFile, exitCode: 1 });
  assert.strictEqual(report.summary.total, 3);
  assert.strictEqual(report.summary.verified, 1);
  assert.strictEqual(report.summary.failedOrBlocked, 2);
  assert.strictEqual(report.failures[0].exact, '150386:643721');
  assert.strictEqual(report.failures[0].errorCode, 'NXM_EXTRACT_FAILED');
  assert.match(renderFailureLog(report), /150386:643721/);
  assert.match(renderFailureLog(report), /NXM_EXTRACT_FAILED/);

  const artifacts = writeFailureArtifacts({ stateFile, jobDir, exitCode: 1 });
  assert.ok(artifacts);
  assert.strictEqual(fs.existsSync(artifacts.jsonFile), true);
  assert.strictEqual(fs.existsSync(artifacts.logFile), true);
  assert.strictEqual(fs.existsSync(artifacts.historyFile), true);
  const saved = JSON.parse(fs.readFileSync(artifacts.jsonFile, 'utf8'));
  assert.strictEqual(saved.failures[0].name, 'VD - Dialogue Expansion - Windhelm Patch');
  assert.strictEqual(saved.failures[0].errorCode, 'NXM_EXTRACT_FAILED');
  const text = fs.readFileSync(artifacts.logFile, 'utf8');
  assert.match(text, /failedOrBlocked=2/);
  assert.match(text, /VD - Dialogue Expansion - Windhelm Patch/);
  const history = fs.readFileSync(artifacts.historyFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].failures[0].exact, '150386:643721');

  // Local identity HOLDs must preserve the precise guard reason for later debugging.
  const local = buildFailureReport({ items: {
    '150386:643721': {
      modId: '150386', fileId: '643721', name: 'Windhelm Patch', status: 'HOLD_LOCAL_IDENTITY_CONFLICT',
      localExecutionGuard: { reason: 'LOCAL_MULTI_VERSION_IDENTITY', localVersions: ['1.0', '2.0'], targetVersion: '3.0' },
    },
  }});
  assert.strictEqual(local.failures[0].errorCode, 'LOCAL_MULTI_VERSION_IDENTITY');
  assert.deepStrictEqual(local.failures[0].localIdentity.localVersions, ['1.0', '2.0']);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('review failure log tests: OK');
