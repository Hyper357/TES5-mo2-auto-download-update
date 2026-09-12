#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildBrief, queryMod, textBrief } = require('./agent-brief');

const plan = {
  total: 5,
  updateEligibilityCounts: {
    UPDATE_CONFIRMED: 2,
    HOLD_UPDATE_ELIGIBILITY: 2,
    SKIP_METADATA_FALSE_POSITIVE: 1,
    SKIP_UP_TO_DATE: 0,
  },
  items: [
    { modId: '1', name: 'Safe', action: 'DOWNLOAD', localFileId: '10', latestFileId: '11', latestVersion: '2.0' },
    { modId: '2', name: 'Hold A', action: 'HOLD_UPDATE_ELIGIBILITY', reason: 'LOCAL_FILE_IDENTITY_UNRESOLVED', localFileId: '', latestFileId: '' },
    { modId: '3', name: 'Hold B', action: 'HOLD_UPDATE_ELIGIBILITY', reason: 'LOCAL_FILE_IDENTITY_UNRESOLVED', localFileId: '30', latestFileId: '31' },
    { modId: '4', name: 'Variant', action: 'HOLD_VARIANT_REVIEW', reason: 'MULTI_VARIANT_REVIEW', localFileId: '40', latestFileId: '41', manualReview: { type: 'MULTI_VARIANT', required: true } },
    { modId: '5', name: 'False', action: 'SKIP_METADATA_FALSE_POSITIVE', reason: 'METADATA_ONLY' },
  ],
};
const report = { mode: 'DOWNLOAD', requested: 1, verified: 1, failed: 0 };
const review = {
  items: [
    { modId: '4', localName: 'Variant', reviewClass: 'actionable', action: 'HOLD_VARIANT_REVIEW', localFileId: '40', targetMainFileId: '41', recentNexusFiles: [{ fileId: '41' }], blockers: ['choose variant'] },
    { modId: '2', localName: 'Hold A', reviewClass: 'eligibility', action: 'HOLD_UPDATE_ELIGIBILITY', blockers: ['identity unknown'] },
  ],
};

const brief = buildBrief({ runDir: '/tmp/runs/r1', plan, report, review });
assert.strictEqual(brief.runId, 'r1');
assert.strictEqual(brief.summary.total, 5);
assert.strictEqual(brief.summary.updateConfirmed, 2);
assert.strictEqual(brief.summary.verified, 1);
assert.strictEqual(brief.summary.reviewActionable, 1);
assert.deepStrictEqual(brief.topHoldReasons[0], { key: 'LOCAL_FILE_IDENTITY_UNRESOLVED', count: 2 });
assert.ok(brief.nextCommands.includes('npm run review'));
assert.match(textBrief(brief), /confirmed=2/);
assert.ok(textBrief(brief).split('\n').length <= 5, 'default brief must remain tiny');

const mod = queryMod({ modId: '4', plan, review });
assert.strictEqual(mod.found, true);
assert.strictEqual(mod.plan.length, 1);
assert.strictEqual(mod.review.length, 1);
assert.strictEqual(mod.plan[0].targetFileId, '41');
assert.strictEqual(mod.review[0].recentFileCount, 1);

const missing = queryMod({ modId: '999', plan, review });
assert.strictEqual(missing.found, false);
assert.deepStrictEqual(missing.plan, []);
assert.deepStrictEqual(missing.review, []);

console.log('agent brief tests: OK');
