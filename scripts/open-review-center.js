#!/usr/bin/env node
'use strict';

// Open the read-only Review Center HTML of a run in the operator's browser.
//
// The audit itself only prints the path (index.js: "只读 HTML: ..."), which
// means the operator has to copy it by hand every round. That got missed and
// the human had to ask "why don't you give me the HTML anymore?". So:
// `npm run review:open` opens the latest run, or a specific one with --run.

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { findLatestRun } = require('./lib/runtime');
const { openDefault } = require('./lib/process-runner');

const rootDir = path.resolve(__dirname, '..');

function resolveReviewCenter(root, explicitRun = '') {
  const runDir = explicitRun ? path.resolve(explicitRun) : findLatestRun(root);
  if (!runDir) throw new Error('NO_RUN_FOUND: 还没有任何 run，先跑 npm run audit');
  const html = path.join(runDir, 'review-center.html');
  if (!fs.existsSync(html)) {
    throw new Error(`REVIEW_CENTER_MISSING: ${html}（该 run 没有生成只读 Review Center）`);
  }
  return { runDir, html };
}

function main() {
  const explicit = argValue(process.argv, '--run', '');
  const noOpen = process.argv.includes('--no-open');
  const { runDir, html } = resolveReviewCenter(rootDir, explicit);
  console.log(`run:  ${runDir}`);
  console.log(`html: ${html}`);
  if (noOpen) return;
  const opened = openDefault(html);
  console.log(opened ? 'opened in default browser' : 'could not launch a browser; open the path above manually');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('review:open failed: ' + err.message);
    process.exit(1);
  }
}

module.exports = { resolveReviewCenter };
