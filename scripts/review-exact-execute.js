#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function readExplicitRows(manifest) {
  if (!manifest || !fs.existsSync(manifest)) return [];
  return fs.readFileSync(manifest, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const cols = line.split('\t');
      return {
        note: String(cols[3] || ''),
        action: String(cols[5] || '').trim().toUpperCase(),
      };
    });
}

function isExplicitReviewManifest(manifest) {
  const rows = readExplicitRows(manifest);
  return rows.length > 0 && rows.every(row =>
    row.action === 'DOWNLOAD' && /(?:^|;\s*)user-selected-nexus-file(?:;|$)/i.test(row.note)
  );
}

function rewriteInstalledDir(args) {
  const forwarded = [...args];
  const manifest = forwarded[0];
  if (!isExplicitReviewManifest(manifest)) return { args: forwarded, changed: false, contextDir: '' };

  const installedIndex = forwarded.indexOf('--installed-dir');
  if (installedIndex < 0 || installedIndex + 1 >= forwarded.length) {
    throw new Error('REVIEW_EXACT_EXECUTOR_MISSING_INSTALLED_DIR');
  }

  const runIndex = forwarded.indexOf('--run-dir');
  const runDir = runIndex >= 0 && runIndex + 1 < forwarded.length
    ? path.resolve(forwarded[runIndex + 1])
    : path.dirname(path.resolve(manifest));
  const contextDir = path.join(runDir, 'explicit-review-download-context');
  fs.mkdirSync(contextDir, { recursive: true });

  // Review Center exact-file picks are already constrained by its immutable exact allow-list
  // and update-eligibility gate. They are download-only actions, not an automatic local
  // replacement decision. Using an empty local context here prevents unrelated MO2 folders
  // that share one Nexus modId (for example several independent patch modules/versions)
  // from being misclassified as LOCAL_MULTI_VERSION_IDENTITY. Final exact fileId download
  // verification and all Nexus/API/browser/download safety checks remain unchanged.
  forwarded[installedIndex + 1] = contextDir;
  return { args: forwarded, changed: true, contextDir };
}

function main() {
  const forwarded = process.argv.slice(2);
  const rewritten = rewriteInstalledDir(forwarded);
  const executePlan = path.join(__dirname, 'execute-plan.js');
  const r = cp.spawnSync(process.execPath, [executePlan, ...rewritten.args], {
    env: process.env,
    windowsHide: true,
    stdio: 'inherit',
  });
  if (r.error) throw r.error;
  process.exitCode = Number.isInteger(r.status) ? r.status : 1;
}

if (require.main === module) {
  try { main(); }
  catch (err) {
    console.error(`REVIEW_EXACT_EXECUTOR_FAILED ${String(err.message || err)}`);
    process.exit(1);
  }
}

module.exports = {
  readExplicitRows,
  isExplicitReviewManifest,
  rewriteInstalledDir,
};
