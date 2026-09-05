'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateAndBuild, persistRememberedPolicies } = require('./review-download');
const { loadVariantPolicies, getVariantPolicy } = require('./lib/variant-policy');

const review = {
  items: [{
    id: 'mod:160675', modId: '160675', localFileId: '100', blockers: [],
    mainOptions: [
      { fileId: '100', name: 'Vanilla', version: '1.0', current: true, selectable: true, branchKey: 'VANILLA', tags: ['VANILLA'] },
      { fileId: '300', name: 'KS Hairdos HDT', version: '1.02.1', current: false, selectable: true, branchKey: 'HDT_SMP+KS_HAIRDOS', tags: ['HDT_SMP', 'KS_HAIRDOS'] },
    ],
    patchFamilies: [{
      family: 'KS_HAIRDOS_HDT_HOTFIX',
      candidates: [{ modId: '160675', fileId: '301', name: 'HDT Hotfix', version: '1.02.1', selectable: true }],
    }],
  }],
};

{
  const x = validateAndBuild(review, {
    'mod:160675': {
      mainFileId: '300',
      patches: { KS_HAIRDOS_HDT_HOTFIX: { decision: 'OBSOLETE' } },
    },
  });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(x.rows.length, 1);
  assert.strictEqual(x.rows[0].fileId, '300');
  assert.strictEqual(x.accepted[0].rememberMain, false);
}

{
  const x = validateAndBuild(review, {
    'mod:160675': {
      mainFileId: '300', rememberMain: true,
      patches: { KS_HAIRDOS_HDT_HOTFIX: { decision: 'DOWNLOAD', modId: '160675', fileId: '301' } },
    },
  });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(x.rows.length, 2);
  assert.match(x.rows[1].note, /closure:PATCH/);
  assert.strictEqual(x.accepted[0].rememberMain, true);
  assert.strictEqual(x.accepted[0].mainSelection.branchKey, 'HDT_SMP+KS_HAIRDOS');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-policy-'));
  try {
    const policyFile = path.join(dir, 'variant-policies.json');
    const updates = persistRememberedPolicies(x, policyFile);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].saved, true);
    assert.strictEqual(getVariantPolicy(loadVariantPolicies(policyFile), '160675').branchKey, 'HDT_SMP+KS_HAIRDOS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const x = validateAndBuild(review, { 'mod:160675': { mainFileId: '999999', patches: {} } });
  assert.ok(x.errors.some(e => e.code === 'REVIEW_SELECTION_INVALID'));
}

{
  const x = validateAndBuild(review, { 'mod:160675': { mainFileId: '300', patches: {} } });
  assert.ok(x.errors.some(e => e.code === 'REVIEW_PATCH_DECISION_REQUIRED'));
}

console.log('review download tests: OK');
