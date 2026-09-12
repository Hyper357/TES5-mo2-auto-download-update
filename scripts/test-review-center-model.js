#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildReviewPayload } = require('./lib/review-center-model');
const { renderHtml, summarizeAutoReport, recentNexusFilesForItem } = require('./build-review-center');

const environment = {
  version: 1,
  profileResolved: true,
  profileUsableForApplicability: true,
  profileName: 'Default',
  profileSource: 'MODORGANIZER_INI',
  summary: { enabledMods: 1500, disabledMods: 400 },
  uiWarningTrustedForUpdateDecision: false,
};
const plan = { environment, updateEligibilityCounts: { UPDATE_CONFIRMED: 12, HOLD_UPDATE_ELIGIBILITY: 4 }, items: [{
  modId: '160675', name: 'Sassy SnW', profileState:'ENABLED', localFileId: '100', latestFileId:'300', latestVersion:'2', latestName:'KS Hairdos HDT', action: 'HOLD_VARIANT_REVIEW',
  manualReview: {
    required: true, recommendedFileId: '300',
    options: [
      { fileId: '100', name: 'Vanilla', version: '1', current: true, branchKey: 'VANILLA' },
      { fileId: '300', name: 'KS Hairdos HDT', version: '2', current: false, branchKey: 'KS_HDT', tags: ['HDT_SMP'] },
    ],
  },
}] };
const discovery = { environment, items: [{
  modId: '160675', mainFileId: '300', mainVersion:'2', mainName: 'Sassy SnW', complete: false, coverageProblems: [], advisoryCoverage:[{source:'requirementsReverse',status:'SECTION_NOT_PROVEN'}],
  candidates:[{kind:'PATCH',source:'REQUIREMENTS_REVERSE',relevance:{blocking:false,disposition:'NON_BLOCKING_REVERSE_UNINSTALLED'}}],
  unresolved: [
    { kind:'HOTFIX', key: 'same:400', family: 'HDT_HOTFIX', source: 'SAME_PAGE_FILE', fileId: '400', version: '2.0.1', name: 'HDT Hotfix', relevance:{blocking:true,disposition:'BLOCKING_DISCOVERED'} },
    { kind:'RESOURCE', key:'mod:500', family:'CUSTOM:FRAMEWORK', source:'REQUIREMENTS_FORWARD', auxModId:'500', fileId:'501', version:'3', name:'Required Framework', requiredHint:true,
      relevance:{blocking:true,disposition:'BLOCKING_REQUIRED'},
      environmentDecision:{resolved:false,status:'UNRESOLVED',confidence:'high',reason:'REQUIRED_DEPENDENCY_DISABLED',evidence:['Required Framework']} },
  ],
}] };
const closure = { items: [] };

const autoSummary = summarizeAutoReport({ mode: 'DOWNLOAD', requested: 42, verified: 40, failed: 2, humanReview: 7 });
const payload = buildReviewPayload(plan, discovery, closure, { plan: '.runtime/runs/test-run/plan.json', autoSummary, environment });
assert.strictEqual(payload.items.length, 1);
assert.strictEqual(payload.counts.actionable, 1);
assert.strictEqual(payload.counts.eligibility, 0);
assert.strictEqual(payload.counts.variant, 1);
assert.strictEqual(payload.counts.component, 1);
assert.strictEqual(payload.counts.patch, 1);
assert.strictEqual(payload.updateSummary.UPDATE_CONFIRMED, 12);
assert.strictEqual(payload.nonBlockingEvidence, 1);
assert.strictEqual(payload.environment.profileName, 'Default');
assert.strictEqual(payload.environment.uiWarningTrustedForUpdateDecision, false);
assert.strictEqual(payload.items[0].reviewClass, 'actionable');
assert.strictEqual(payload.items[0].profileState, 'ENABLED');
assert.strictEqual(payload.items[0].targetMainFileId, '300');
assert.strictEqual(payload.items[0].mainOptions.find(x => x.fileId === '300').recommended, true);
assert.strictEqual(payload.items[0].componentFamilies.length, 2);
assert.ok(payload.items[0].componentFamilies.some(x => x.kind === 'RESOURCE'));
assert.ok(payload.items[0].componentFamilies.some(x => x.kind === 'HOTFIX'));
assert.strictEqual(payload.items[0].patchFamilies[0].kind, 'HOTFIX');
assert.strictEqual(payload.items[0].componentFamilies.find(x => x.kind==='HOTFIX').candidates[0].modId, '160675');
assert.strictEqual(payload.items[0].componentFamilies.find(x => x.kind==='HOTFIX').candidates[0].relevance.disposition, 'BLOCKING_DISCOVERED');
const resourceCandidate = payload.items[0].componentFamilies.find(x => x.kind==='RESOURCE').candidates[0];
assert.strictEqual(resourceCandidate.modId, '500');
assert.strictEqual(resourceCandidate.environmentDecision.reason, 'REQUIRED_DEPENDENCY_DISABLED');
assert.strictEqual(resourceCandidate.environmentDecision.resolved, false);
assert.strictEqual(payload.autoSummary.verified, 40);

// Review Center must show the author's recent active Nexus files by upload time,
// while always retaining current/recommended files for context even if they fall outside the limit.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-cache-'));
try {
  fs.writeFileSync(path.join(cacheDir, '160675.json'), JSON.stringify({ files: [
    { file_id: 100, name: 'Installed Vanilla', file_name: 'vanilla.zip', version: '1', category_id: 1, category_name: 'MAIN', uploaded_time: '2026-01-01T00:00:00Z' },
    { file_id: 200, name: 'Optional Hair Pack', file_name: 'optional.zip', version: '2.1', category_id: 3, category_name: 'OPTIONAL', uploaded_time: '2026-09-10T00:00:00Z' },
    { file_id: 300, name: 'KS Hairdos HDT', file_name: 'main.zip', version: '2', category_id: 1, category_name: 'MAIN', uploaded_time: '2026-09-09T00:00:00Z' },
    { file_id: 400, name: 'Older Active File', file_name: 'older.zip', version: '1.9', category_id: 5, category_name: 'MISC', uploaded_time: '2026-09-08T00:00:00Z' },
    { file_id: 999, name: 'Archived Newer File', file_name: 'archived.zip', version: '9', category_id: 7, category_name: 'OLD', uploaded_time: '2026-09-12T00:00:00Z' },
  ] }), 'utf8');
  const recent = recentNexusFilesForItem(payload.items[0], { cacheDir, limit: 2 });
  assert.strictEqual(recent.source, 'NEXUS_API_CACHE');
  assert.deepStrictEqual(recent.files.map(x => x.fileId), ['200', '300', '100']);
  assert.strictEqual(recent.files.find(x => x.fileId === '100').current, true);
  assert.strictEqual(recent.files.find(x => x.fileId === '100').selectable, false);
  assert.strictEqual(recent.files.find(x => x.fileId === '300').recommended, true);
  assert.ok(!recent.files.some(x => x.fileId === '999'));
  payload.items[0].recentNexusFiles = recent.files;
  payload.items[0].recentNexusFilesSource = recent.source;
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

const html = renderHtml(payload);
assert.match(html, /window\.REVIEW_DATA=/);
assert.match(html, /KS Hairdos HDT/);
assert.match(html, /Required Framework/);
assert.match(html, /REQUIRED_DEPENDENCY_DISABLED/);
assert.match(html, /Default/);
assert.match(html, /HDT Hotfix/);
assert.match(html, /下载所选文件/);
assert.match(html, /更新文件选择器/);
assert.match(html, /选择下载/);
assert.match(html, /file-checkbox/);
assert.ok(!html.includes('data-main-choice'));
assert.ok(!html.includes('data-component-decision'));
assert.match(html, /data-auto-summary="embedded"/);
assert.ok(!html.includes('/*__STYLE__*/'));
assert.ok(!html.includes('/*__APP__*/'));
assert.ok(!html.includes('__AUTO_MARKER__'));

console.log('review-center model tests: OK');