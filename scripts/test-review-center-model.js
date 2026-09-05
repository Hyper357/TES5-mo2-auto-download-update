#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildReviewPayload } = require('./lib/review-center-model');
const { renderHtml, summarizeAutoReport } = require('./build-review-center');

const plan = { items: [{
  modId: '160675', name: 'Sassy SnW', localFileId: '100', latestFileId:'300', latestVersion:'2', latestName:'KS Hairdos HDT', action: 'HOLD_VARIANT_REVIEW',
  manualReview: {
    required: true, recommendedFileId: '300',
    options: [
      { fileId: '100', name: 'Vanilla', version: '1', current: true, branchKey: 'VANILLA' },
      { fileId: '300', name: 'KS Hairdos HDT', version: '2', current: false, branchKey: 'KS_HDT', tags: ['HDT_SMP'] },
    ],
  },
}] };
const discovery = { items: [{
  modId: '160675', mainFileId: '300', mainVersion:'2', mainName: 'Sassy SnW', complete: false, coverageProblems: [],
  unresolved: [
    { kind:'HOTFIX', key: 'same:400', family: 'HDT_HOTFIX', source: 'SAME_PAGE_FILE', fileId: '400', version: '2.0.1', name: 'HDT Hotfix' },
    { kind:'RESOURCE', key:'mod:500', family:'CUSTOM:FRAMEWORK', source:'REQUIREMENTS_FORWARD', auxModId:'500', fileId:'501', version:'3', name:'Required Framework', requiredHint:true },
  ],
}] };
const closure = { items: [] };

const autoSummary = summarizeAutoReport({ mode: 'DOWNLOAD', requested: 42, verified: 40, failed: 2, humanReview: 7 });
const payload = buildReviewPayload(plan, discovery, closure, { plan: 'plan.json', autoSummary });
assert.strictEqual(payload.items.length, 1);
assert.strictEqual(payload.counts.variant, 1);
assert.strictEqual(payload.counts.component, 1);
assert.strictEqual(payload.counts.patch, 1);
assert.strictEqual(payload.items[0].targetMainFileId, '300');
assert.strictEqual(payload.items[0].mainOptions.find(x => x.fileId === '300').recommended, true);
assert.strictEqual(payload.items[0].componentFamilies.length, 2);
assert.ok(payload.items[0].componentFamilies.some(x => x.kind === 'RESOURCE'));
assert.ok(payload.items[0].componentFamilies.some(x => x.kind === 'HOTFIX'));
assert.strictEqual(payload.items[0].patchFamilies[0].kind, 'HOTFIX');
assert.strictEqual(payload.items[0].componentFamilies.find(x => x.kind==='HOTFIX').candidates[0].modId, '160675');
assert.strictEqual(payload.items[0].componentFamilies.find(x => x.kind==='RESOURCE').candidates[0].modId, '500');
assert.strictEqual(payload.autoSummary.verified, 40);

const html = renderHtml(payload);
assert.match(html, /window\.REVIEW_DATA=/);
assert.match(html, /KS Hairdos HDT/);
assert.match(html, /Required Framework/);
assert.match(html, /HDT Hotfix/);
assert.match(html, /下载所有已确认项/);
assert.match(html, /Review Center|人工决策中心/);
assert.match(html, /data-auto-summary="embedded"/);
assert.ok(!html.includes('/*__STYLE__*/'));
assert.ok(!html.includes('/*__APP__*/'));
assert.ok(!html.includes('__AUTO_MARKER__'));

console.log('review-center model tests: OK');
