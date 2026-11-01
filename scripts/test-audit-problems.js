#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildProblemReport, groupFor } = require('./audit-problems');

const row = (modId, action, reason, target) => ({
  modId,
  name: `Mod ${modId} — 中文标签 — 【分类】`,
  action,
  installedVersion: '1.0.0.0',
  localFileId: '100',
  updateEligibility: {
    status: reason === 'MO2_SIGNAL_WITH_NEWER_UNVERIFIED_FILE' ? 'HOLD_UPDATE_ELIGIBILITY' : action,
    reason,
    target: target ? { fileId: target, version: '1.1' } : null,
  },
});

const plan = {
  rows: [
    row('1', 'SKIP_UP_TO_DATE', 'NO_NEWER_EXACT_OR_COMPATIBLE_FILE', null),
    row('2', 'DOWNLOAD', 'NEXUS_EXACT_UPDATE_CHAIN', '201'),
    row('3', 'HOLD_UPDATE_ELIGIBILITY', 'MO2_SIGNAL_WITH_NEWER_UNVERIFIED_FILE', '203'),
    row('4', 'SKIP_METADATA_FALSE_POSITIVE', 'MO2_SIGNAL_WITHOUT_NEWER_EXACT_OR_COMPATIBLE_FILE', null),
    row('5', 'HOLD_UPDATE_ELIGIBILITY', 'LOCAL_FILE_IDENTITY_UNRESOLVED', null),
    row('6', 'HOLD_COMPONENT_DISCOVERY', 'NEXUS_EXACT_UPDATE_CHAIN', '206'),
    row('7', 'HOLD_UPDATE_ELIGIBILITY', 'WEAK_UPDATE_EVIDENCE_DEFERRED', '207'),
    row('8', 'HOLD_API_ERROR', 'API_ERROR', null),
    row('9', 'SKIP_IGNORED_UPDATE', 'MO2_IGNORED_VERSION_MATCHES_TARGET', null),
    row('10', 'HOLD_UPDATE_ELIGIBILITY', 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT', '210'),
  ],
};

const report = buildProblemReport({ plan, unscanned: ['a', 'b', 'c'], runDir: '/tmp/run' });

assert.strictEqual(report.totals.rows, 10);
assert.strictEqual(report.totals.autoDownload, 1, 'exact-chain download is not a problem');
assert.strictEqual(report.groups.SUSPECT_UPDATE.count, 1);
assert.strictEqual(report.groups.SUSPECT_UPDATE.items[0].targetFileId, '203');
assert.strictEqual(report.groups.DISMISSED_SIGNAL.count, 1);
assert.strictEqual(report.groups.IDENTITY.count, 1);
assert.strictEqual(report.groups.COMPONENT.count, 1);
assert.strictEqual(report.groups.WEAK_DEFERRED.count, 1);
assert.strictEqual(report.groups.API_BLIND.count, 1);
assert.strictEqual(report.groups.NO_MODID_BLIND.count, 3);
assert.strictEqual(report.groups.SAME_VERSION_CONFLICT.count, 1);
assert.strictEqual(report.groups.LOCAL_NEWER.count, 0);
assert.strictEqual(report.totals.exactTargets, 2, 'SUSPECT_UPDATE + WEAK_DEFERRED carry exact targets');

// Up-to-date rows never leak into the problem list.
assert.strictEqual(groupFor(plan.rows[0]), 'OTHER');

console.log('audit problems tests: OK');
