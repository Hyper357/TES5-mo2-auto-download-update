#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipelineState, readRecentErrors } = require('./agent-status');

assert.strictEqual(pipelineState({ report: null, review: { items: [] }, errors: [], patchTasks: 0, latestJob: null }), 'IN_PROGRESS_OR_ABORTED');
assert.strictEqual(pipelineState({ report: { mode: 'AUDIT', downloadReady: 2, failed: 0 }, review: { items: [] }, errors: [], patchTasks: 0, latestJob: null }), 'READY_FOR_GO');
assert.strictEqual(pipelineState({ report: { mode: 'DOWNLOAD', failed: 0 }, review: { items: [{}] }, errors: [], patchTasks: 0, latestJob: null }), 'REVIEW_REQUIRED');
assert.strictEqual(pipelineState({ report: { mode: 'DOWNLOAD', failed: 1 }, review: { items: [] }, errors: [], patchTasks: 0, latestJob: null }), 'ATTENTION');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-agent-status-'));
try {
  const logDir = path.join(tmp, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'errors.jsonl'), [
    JSON.stringify({ errorCode: 'NXM_EXPIRED', stage: 'DOWNLOAD', modId: '1', fileId: '2', action: 'refresh' }),
    JSON.stringify({ error: { code: 'META_MISMATCH', action: 'stop' }, context: { modId: '3', fileId: '4' } }),
  ].join('\n'));
  const errors = readRecentErrors(tmp, 5);
  assert.deepStrictEqual(errors[0], { code: 'NXM_EXPIRED', stage: 'DOWNLOAD', modId: '1', fileId: '2', status: null, action: 'refresh' });
  assert.strictEqual(errors[1].code, 'META_MISMATCH');
  assert.strictEqual(errors[1].modId, '3');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('agent-status tests: OK');
