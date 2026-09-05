#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue, hasFlag } = require('./lib/cli');
const { loadJson } = require('./lib/fs-json');
const { findLatestRun } = require('./lib/runtime');

const rootDir = path.resolve(__dirname, '..');

function compact(item) {
  const e = item.updateEligibility || {};
  return {
    priority: Number(e.priority || 0),
    modId: String(item.modId || ''),
    name: item.name || item.latestName || '',
    profileState: item.profileState || 'UNKNOWN',
    status: e.status || item.action || 'UNKNOWN',
    reason: e.reason || item.reason || '',
    mo2Signal: !!e.mo2?.signal,
    mo2Reason: e.mo2?.reason || '',
    localFileId: item.localFileId || item.fileId || '',
    localVersion: item.localApiVersion || item.installedVersion || '',
    targetFileId: e.target?.fileId || item.latestFileId || '',
    targetVersion: e.target?.version || item.latestVersion || '',
    evidence: e.evidence || [],
  };
}

function build(plan) {
  const rows = (plan.items || []).map(compact).sort((a, b) => b.priority - a.priority || Number(a.modId) - Number(b.modId));
  return {
    generatedAt: new Date().toISOString(),
    planGeneratedAt: plan.generatedAt || null,
    total: rows.length,
    counts: plan.updateEligibilityCounts || rows.reduce((acc, x) => { acc[x.status] = (acc[x.status] || 0) + 1; return acc; }, {}),
    confirmed: rows.filter(x => x.status === 'UPDATE_CONFIRMED'),
    review: rows.filter(x => x.status === 'HOLD_UPDATE_ELIGIBILITY'),
    ignored: rows.filter(x => x.status === 'SKIP_IGNORED_UPDATE'),
    metadataFalsePositive: rows.filter(x => x.status === 'SKIP_METADATA_FALSE_POSITIVE'),
    upToDate: rows.filter(x => x.status === 'SKIP_UP_TO_DATE'),
  };
}

function printHuman(s, limit) {
  console.log('========================================================');
  console.log('🔎 Update Eligibility Status');
  console.log('========================================================');
  console.log(`总 MOD: ${s.total}`);
  console.log(`✅ 确认真更新: ${s.confirmed.length}`);
  console.log(`⚠ 需要人工确认更新资格: ${s.review.length}`);
  console.log(`⏸ MO2 Ignore: ${s.ignored.length}`);
  console.log(`🟡 MO2 metadata 假阳性: ${s.metadataFalsePositive.length}`);
  console.log(`✓ 已是当前版本: ${s.upToDate.length}`);

  if (s.confirmed.length) {
    console.log('\n[优先更新]');
    for (const x of s.confirmed.slice(0, limit)) {
      const yellow = x.mo2Signal ? '🟨' : '🟦';
      console.log(`${yellow} P${x.priority} | ${x.modId} | ${x.name}`);
      console.log(`   ${x.localFileId || '?'} v${x.localVersion || '?'} -> ${x.targetFileId || '?'} v${x.targetVersion || '?'} | ${x.reason}`);
    }
  }

  if (s.review.length) {
    console.log('\n[更新资格待确认]');
    for (const x of s.review.slice(0, limit)) console.log(`⚠ P${x.priority} | ${x.modId} | ${x.name} | ${x.reason}`);
  }

  if (s.metadataFalsePositive.length) {
    console.log('\n[MO2 metadata 假阳性：不会进入下载流程]');
    for (const x of s.metadataFalsePositive.slice(0, Math.min(limit, 20))) console.log(`🟡 ${x.modId} | ${x.name} | ${x.mo2Reason}`);
  }
}

function main() {
  const requestedPlan = argValue(process.argv, '--plan', '');
  let planFile = requestedPlan ? path.resolve(requestedPlan) : '';
  if (!planFile) {
    const run = findLatestRun(rootDir);
    if (run) planFile = path.join(run, 'plan.json');
  }
  if (!planFile || !fs.existsSync(planFile)) {
    console.error('没有找到 plan.json。请先运行一次 AUDIT。');
    process.exit(2);
  }
  const plan = loadJson(planFile, null);
  if (!plan) throw new Error(`无法读取 ${planFile}`);
  const summary = build(plan);
  summary.plan = planFile;
  if (hasFlag(process.argv, '--json')) console.log(JSON.stringify(summary, null, 2));
  else printHuman(summary, Number(argValue(process.argv, '--limit', '50')) || 50);
}

if (require.main === module) main();
module.exports = { build, compact };
