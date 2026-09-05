'use strict';

const assert = require('assert');
const { validateAndBuild } = require('./review-download');

const review = {
  items: [{
    id: 'mod:160675', modId: '160675', localFileId: '100', blockers: [],
    mainOptions: [
      { fileId: '100', name: 'Vanilla', version: '1.0', current: true, selectable: true },
      { fileId: '300', name: 'KS Hairdos HDT', version: '1.02.1', current: false, selectable: true, branchKey: 'KS_HAIRDOS+HDT_SMP' },
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
}

{
  const x = validateAndBuild(review, {
    'mod:160675': {
      mainFileId: '300',
      patches: { KS_HAIRDOS_HDT_HOTFIX: { decision: 'DOWNLOAD', modId: '160675', fileId: '301' } },
    },
  });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(x.rows.length, 2);
  assert.match(x.rows[1].note, /closure:PATCH/);
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
