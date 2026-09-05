#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue, hasFlag } = require('./lib/cli');
const { loadJson } = require('./lib/fs-json');
const { findLatestRun } = require('./lib/runtime');

const rootDir = path.resolve(__dirname, '..');

function compactItem(x) {
  const e = x.updateEligibility || {};
  return {
    modId: String(x.modId || ''),
    name: x.name || x.latestName || '',
    profileState: x.profileState || 'UNKNOWN',
    action: x.action || '',
    eligibility: e.state || 'UNKNOWN',
    reason: e.reason || x.reason || '',
    mo2ArrowHint: !!e.mo2Hint?.wouldShowUpdateArrow,
    installedFileId: x.localFileId || x.fileId || e.installed?.fileId || '',
    installedVersion: e.installed?.version || x.localApiVersion || x.installedVersion || '',
    targetFileId: e.newerCandidates?.[0]?.fileId || x.latestFileId || '',
    targetVersion: e.newerCandidates?.[0]?.version || x.latestVersion || '',
    mo2NewestVersion: e.mo2Hint?.newestVersion || x.newestVersion || '',
  };
}

function main() {
  const requested = argValue(process.argv, '--run', '');
  const runDir = requested ? path.resolve(requested) : findLatestRun(rootDir, d => fs.existsSync(path.join(d, 'plan.json')));
  if (!runDir) {
    console.error('No run with plan.json found. Run an AUDIT first.');
    process.exit(2);
  }
  const plan = loadJson(path.join(runDir, 'plan.json'), { items: [] });
  const groups = { UPDATE_CONFIRMED: [], MO2_HINT_FALSE_POSITIVE: [], UPDATE_IGNORED: [], UPDATE_UNCERTAIN: [], CURRENT_CONFIRMED: [], OTHER: [] };
  for (const item of plan.items || []) {
    const row = compactItem(item);
    if (groups[row.eligibility]) groups[row.eligibility].push(row);
    else groups.OTHER.push(row);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    runDir,
    counts: Object.fromEntries(Object.entries(groups).map(([k,v]) => [k, v.length])),
    confirmedUpdates: groups.UPDATE_CONFIRMED,
    mo2FalsePositives: groups.MO2_HINT_FALSE_POSITIVE,
    ignoredUpdates: groups.UPDATE_IGNORED,
    uncertain: groups.UPDATE_UNCERTAIN,
    current: hasFlag(process.argv, '--include-current') ? groups.CURRENT_CONFIRMED : undefined,
    other: groups.OTHER,
  };
  console.log(JSON.stringify(payload, null, hasFlag(process.argv, '--compact') ? 0 : 2));
}

main();
