'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
  decorateHtml,
  renderCurrentReviewHtml,
  reviewRuntimeOwner,
  reviewExecutionEnv,
  ensureDownloadPrerequisites,
} = require('./review-server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-server-test-'));
fs.writeFileSync(path.join(dir, 'final-report.json'), JSON.stringify({
  mode: 'DOWNLOAD', requested: 42, verified: 40, failed: 2, humanReview: 7,
}), 'utf8');
const html = '<html><body><div id="root"></div></body></html>';
const out = decorateHtml(html, dir);
assert.match(out, /本轮自动阶段汇报/);
assert.match(out, /自动请求 42/);
assert.match(out, /VERIFIED 40/);
assert.match(out, /失败\/未验证 2/);
assert.match(out, /延后人工复核 7/);
assert.ok(out.indexOf('本轮自动阶段汇报') < out.indexOf('<div id="root">'));

// Reopening an old run must not serve the generated HTML/JS snapshot from that run.
// The immutable review JSON remains the evidence source, while the current repository
// assets provide the interactive UI so an old page cannot drift from the current API.
const htmlFile = path.join(dir, 'review-center.html');
const reviewFile = path.join(dir, 'review-center.json');
fs.writeFileSync(htmlFile, '<html><body>STALE-UI-MARKER</body></html>', 'utf8');
fs.writeFileSync(reviewFile, JSON.stringify({
  generatedAt: '2026-09-01T00:00:00.000Z',
  items: [],
  counts: {},
}), 'utf8');
const current = renderCurrentReviewHtml(dir, htmlFile, reviewFile);
assert.ok(!current.includes('STALE-UI-MARKER'));
assert.match(current, /MO2 更新文件选择器/);
assert.match(current, /下载所选文件/);
assert.match(current, /window\.REVIEW_DATA=/);
assert.match(current, /本轮自动阶段汇报/);
assert.match(current, /pollReviewJob/);
assert.match(current, /repairSavedReviewState/);
assert.match(current, /pathname === '\/api\/download'/);
assert.match(current, /undefined:undefined/);
assert.match(current, /已忽略上一轮遗留的选择校验日志/);
assert.match(current, /已清理 .* 个无效旧选择/);
assert.match(current, /NEXUS_API：HTTP 429/);
assert.match(current, /API Key 被拒绝/);
assert.ok(current.indexOf('repairSavedReviewState') < current.indexOf('const D = window.REVIEW_DATA'), 'saved-state repair must install before app restore runs');
for (const match of current.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1]);
}

// A Review Center run recovered from another repo copy must keep using the runtime
// owner's managed browser binary/port instead of silently switching to the fresh clone.
const repoRoot = path.join(dir, 'repo-owner');
const recoveredRun = path.join(repoRoot, '.runtime', 'runs', '2026-09-13T000000');
fs.mkdirSync(path.join(repoRoot, '.runtime', 'state'), { recursive: true });
fs.mkdirSync(recoveredRun, { recursive: true });
fs.writeFileSync(path.join(repoRoot, '.runtime', 'state', 'browser-port.json'), JSON.stringify({ port: 9333 }), 'utf8');
assert.strictEqual(reviewRuntimeOwner(recoveredRun), repoRoot);
const recoveredEnv = reviewExecutionEnv(recoveredRun, {});
assert.strictEqual(recoveredEnv.MO2_BROWSER_ROOT, path.join(repoRoot, '.runtime', 'browser'));
assert.strictEqual(recoveredEnv.MO2_CDP_PORT, '9333');

// Download submission must prepare the same prerequisites as the full update workflow.
const calls = [];
const fakeRunner = (args, options) => {
  calls.push({ args, options });
  return { ok: true, status: 0, stdout: '{}', stderr: '' };
};
const prepared = ensureDownloadPrerequisites({ modsDir: 'E:\\SkyrimAE\\mo2\\mods' }, recoveredRun, fakeRunner);
assert.strictEqual(prepared.ok, true);
assert.deepStrictEqual(prepared.completed, ['BROWSER_START', 'BROWSER_ASSERT', 'MO2_ENSURE']);
assert.strictEqual(calls.length, 3);
assert.strictEqual(calls[0].args.at(-1), 'start');
assert.strictEqual(calls[1].args.at(-1), 'assert');
assert.ok(calls[2].args.includes('ensure'));
assert.ok(calls[2].args.includes('--mods-dir'));
assert.strictEqual(calls[0].options.env.MO2_CDP_PORT, '9333');

const failed = ensureDownloadPrerequisites({ modsDir: 'E:\\SkyrimAE\\mo2\\mods' }, recoveredRun, () => ({
  ok: false, status: 2, stdout: '', stderr: 'CDP_UNAVAILABLE: browser is not ready',
}));
assert.strictEqual(failed.ok, false);
assert.strictEqual(failed.stage, 'BROWSER_START');
assert.match(failed.error, /CDP_UNAVAILABLE/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('review server tests: OK');
