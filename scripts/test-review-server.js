'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decorateHtml } = require('./review-server');

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

fs.rmSync(dir, { recursive: true, force: true });
console.log('review server tests: OK');
