#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipelineState, readRecentErrors, sourceHintsFor, updateSummary } = require('./agent-status');

assert.strictEqual(pipelineState({ report: null, review: { items: [] }, errors: [], componentTasks: 0, updateReview: 0, latestJob: null }), 'IN_PROGRESS_OR_ABORTED');
assert.strictEqual(pipelineState({ report: { mode: 'AUDIT', downloadReady: 2, failed: 0 }, review: { items: [] }, errors: [], componentTasks: 0, updateReview: 0, latestJob: null }), 'READY_FOR_GO');
assert.strictEqual(pipelineState({ report: { mode: 'DOWNLOAD', failed: 0 }, review: { items: [] }, errors: [], componentTasks: 0, updateReview: 2, latestJob: null }), 'UPDATE_REVIEW_REQUIRED');
assert.strictEqual(pipelineState({ report: { mode: 'DOWNLOAD', failed: 0 }, review: { items: [{}] }, errors: [], componentTasks: 0, updateReview: 0, latestJob: null }), 'REVIEW_REQUIRED');
assert.strictEqual(pipelineState({ report: { mode: 'DOWNLOAD', failed: 0 }, review: { items: [] }, errors: [], componentTasks: 2, updateReview: 0, latestJob: null }), 'COMPONENT_REVIEW_REQUIRED');
assert.strictEqual(pipelineState({ report: { mode: 'DOWNLOAD', failed: 1 }, review: { items: [] }, errors: [], componentTasks: 0, updateReview: 0, latestJob: null }), 'ATTENTION');
assert.ok(sourceHintsFor('NXM_EXPIRED')[0].includes('nexus-autodl.js'));
assert.ok(sourceHintsFor('META_MISMATCH').includes('scripts/execute-plan.js'));
assert.ok(sourceHintsFor('HOLD_COMPONENT_DISCOVERY').includes('scripts/lib/component-discovery.js'));
assert.ok(sourceHintsFor('PROFILE_UNRESOLVED').includes('scripts/lib/mo2-environment.js'));
assert.ok(sourceHintsFor('MO2_ENVIRONMENT_MISMATCH').includes('npm run environment:status'));
assert.ok(sourceHintsFor('HOLD_UPDATE_ELIGIBILITY').includes('scripts/lib/update-eligibility.js'));
assert.ok(sourceHintsFor('METADATA_FALSE_POSITIVE').includes('npm run updates:status'));

const us = updateSummary({ updateEligibilityGate: true, updateEligibilityCounts: {
  UPDATE_CONFIRMED: 7,
  HOLD_UPDATE_ELIGIBILITY: 2,
  SKIP_METADATA_FALSE_POSITIVE: 5,
  SKIP_UP_TO_DATE: 80,
  SKIP_IGNORED_UPDATE: 1,
} });
assert.strictEqual(us.enabled, true);
assert.strictEqual(us.confirmed, 7);
assert.strictEqual(us.review, 2);
assert.strictEqual(us.metadataFalsePositive, 5);
assert.strictEqual(us.upToDate, 80);
assert.strictEqual(us.ignored, 1);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-agent-status-'));
try {
  const logDir = path.join(tmp, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'errors.jsonl'), [
    JSON.stringify({ errorCode: 'NXM_EXPIRED', stage: 'DOWNLOAD', modId: '1', fileId: '2', action: 'refresh' }),
    JSON.stringify({ error: { code: 'META_MISMATCH', action: 'stop' }, context: { modId: '3', fileId: '4' } }),
  ].join('\n'));
  const errors = readRecentErrors(tmp, 5);
  assert.strictEqual(errors[0].code, 'NXM_EXPIRED');
  assert.strictEqual(errors[0].stage, 'DOWNLOAD');
  assert.strictEqual(errors[0].modId, '1');
  assert.strictEqual(errors[0].fileId, '2');
  assert.strictEqual(errors[0].action, 'refresh');
  assert.ok(errors[0].sourceHints[0].includes('nexus-autodl.js'));
  assert.strictEqual(errors[1].code, 'META_MISMATCH');
  assert.strictEqual(errors[1].modId, '3');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('agent-status tests: OK');
