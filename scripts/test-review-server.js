'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decorateHtml, renderCurrentReviewHtml } = require('./review-server');

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

fs.rmSync(dir, { recursive: true, force: true });
console.log('review server tests: OK');
