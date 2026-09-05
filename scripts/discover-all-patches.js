#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const REVIEW_ACTIONS = new Set([
  'HOLD_VARIANT_REVIEW', 'HOLD_REVIEW', 'HOLD_AMBIGUOUS',
  'HOLD_LOW_CONFIDENCE', 'HOLD_SAME_VERSION_REPLACEMENT',
]);

function main() {
  const planFile = process.argv[2];
  const modsDir = process.argv[3];
  const outFile = argValue('--out');
  if (!planFile || !modsDir || !outFile) {
    console.error('Usage: node discover-all-patches.js <plan.json> <modsDir> --out patch-discovery.json [discover-patches options]');
    process.exit(2);
  }
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const transformed = {
    ...plan,
    items: (plan.items || []).map(item => REVIEW_ACTIONS.has(item.action) ? { ...item, discoveryOriginalAction: item.action, action: 'DOWNLOAD' } : item),
  };
  const tempPlan = path.join(path.dirname(outFile), 'plan-patch-discovery-view.json');
  fs.writeFileSync(tempPlan, JSON.stringify(transformed, null, 2), 'utf8');

  const childArgs = [path.join(__dirname, 'discover-patches.js'), tempPlan, modsDir];
  const passthrough = ['--registry','--relations','--max-age-days','--tasks'];
  for (const flag of passthrough) {
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1]) childArgs.push(flag, process.argv[i + 1]);
  }
  childArgs.push('--out', outFile);
  if (process.argv.includes('--no-browser')) childArgs.push('--no-browser');

  const r = cp.spawnSync(process.execPath, childArgs, { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.status || 0;
}

main();
