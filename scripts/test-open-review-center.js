#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveReviewCenter } = require('./open-review-center');

// Use an isolated fake project so the real .runtime/ is never touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-open-'));
try {
  assert.throws(() => resolveReviewCenter(tmp), /NO_RUN_FOUND/);

  const runDir = path.join(tmp, '.runtime', 'runs', '2026-01-01T00-00-00-000Z');
  fs.mkdirSync(runDir, { recursive: true });
  assert.throws(() => resolveReviewCenter(tmp), /REVIEW_CENTER_MISSING/);

  const html = path.join(runDir, 'review-center.html');
  fs.writeFileSync(html, '<html></html>');
  const found = resolveReviewCenter(tmp);
  assert.strictEqual(found.runDir, runDir);
  assert.strictEqual(found.html, html);

  // Explicit --run must win over the latest-run lookup.
  const older = path.join(tmp, '.runtime', 'runs', '2025-01-01T00-00-00-000Z');
  fs.mkdirSync(older, { recursive: true });
  fs.writeFileSync(path.join(older, 'review-center.html'), '<html>old</html>');
  assert.strictEqual(resolveReviewCenter(tmp, older).html, path.join(older, 'review-center.html'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('open review center tests: OK');
