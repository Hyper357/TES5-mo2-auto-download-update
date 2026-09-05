#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildReviewPayload } = require('./lib/review-center-model');
const { renderHtml } = require('./build-review-center');

const plan = { items: [{
  modId: '160675', name: 'Sassy SnW', localFileId: '100', action: 'HOLD_VARIANT_REVIEW',
  manualReview: {
    required: true, recommendedFileId: '300',
    options: [
      { fileId: '100', name: 'Vanilla', version: '1', current: true, branchKey: 'VANILLA' },
      { fileId: '300', name: 'KS Hairdos HDT', version: '2', current: false, branchKey: 'KS_HDT', tags: ['HDT_SMP'] },
    ],
  },
}] };
const patch = { items: [{
  modId: '160675', mainFileId: '300', mainName: 'Sassy SnW', complete: false, coverageProblems: [],
  unresolved: [{ key: 'same:400', family: 'HDT_HOTFIX', source: 'SAME_PAGE_FILE', fileId: '400', version: '2.0.1', name: 'HDT Hotfix' }],
}] };
const closure = { items: [] };

const payload = buildReviewPayload(plan, patch, closure, { plan: 'plan.json' });
assert.strictEqual(payload.items.length, 1);
assert.strictEqual(payload.counts.variant, 1);
assert.strictEqual(payload.items[0].mainOptions.find(x => x.fileId === '300').recommended, true);
assert.strictEqual(payload.items[0].patchFamilies[0].candidates[0].selectable, true);
assert.strictEqual(payload.items[0].patchFamilies[0].candidates[0].modId, '160675');

const html = renderHtml(payload);
assert.match(html, /window\.REVIEW_DATA=/);
assert.match(html, /KS Hairdos HDT/);
assert.match(html, /下载所有已确认项/);
assert.match(html, /Review Center|人工决策中心/);
assert.ok(!html.includes('/*__STYLE__*/'));
assert.ok(!html.includes('/*__APP__*/'));

console.log('review-center model tests: OK');
