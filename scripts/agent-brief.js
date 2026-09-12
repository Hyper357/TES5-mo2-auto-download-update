#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue, hasFlag } = require('./lib/cli');
const { loadJson, saveJson } = require('./lib/fs-json');
const { findLatestRun } = require('./lib/runtime');

const rootDir = path.resolve(__dirname, '..');

function compactEligibility(e) {
  if (!e) return null;
  return {
    status: e.status || '',
    reason: e.reason || '',
    updateNeeded: !!e.updateNeeded,
    priority: Number(e.priority || 0),
    target: e.target ? {
      fileId: String(e.target.fileId || ''),
      version: e.target.version || '',
      name: e.target.name || '',
    } : null,
  };
}

function compactPlanItem(item) {
  return {
    modId: String(item.modId || ''),
    name: item.name || item.localName || item.latestName || '',
    action: item.action || '',
    reason: item.reason || item.updateEligibility?.reason || '',
    localFileId: String(item.localFileId || item.fileId || ''),
    targetFileId: String(item.latestFileId || item.targetMainFileId || item.updateEligibility?.target?.fileId || ''),
    installedVersion: item.installedVersion || item.localApiVersion || '',
    targetVersion: item.latestVersion || item.targetMainVersion || item.updateEligibility?.target?.version || '',
    updateEligibility: compactEligibility(item.updateEligibility),
    manualReview: item.manualReview ? {
      type: item.manualReview.type || '',
      required: item.manualReview.required !== false,
      reason: item.manualReview.reason || '',
    } : null,
    candidateCount: Array.isArray(item.candidates) ? item.candidates.length : 0,
  };
}

function compactReviewItem(item) {
  return {
    modId: String(item.modId || ''),
    name: item.localName || item.mainName || '',
    reviewClass: item.reviewClass || '',
    action: item.action || '',
    localFileId: String(item.localFileId || ''),
    targetMainFileId: String(item.targetMainFileId || ''),
    recentFileCount: Array.isArray(item.recentNexusFiles) ? item.recentNexusFiles.length : 0,
    blockers: (item.blockers || []).slice(0, 3),
  };
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items || []) {
    const key = String(keyFn(item) || 'UNKNOWN');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function topEntries(counts, limit = 8) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function buildBrief({ runDir, plan, report, review }) {
  const planItems = plan?.items || [];
  const reviewItems = review?.items || [];
  const actions = countBy(planItems, x => x.action);
  const holdReasons = countBy(planItems.filter(x => String(x.action || '').startsWith('HOLD_')), x => x.reason || x.updateEligibility?.reason);
  const reviewClasses = countBy(reviewItems, x => x.reviewClass || 'unknown');
  const updateCounts = plan?.updateEligibilityCounts || {};

  const brief = {
    version: 1,
    generatedAt: new Date().toISOString(),
    runId: path.basename(runDir || ''),
    runDir,
    summary: {
      total: Number(plan?.total || planItems.length || 0),
      updateConfirmed: Number(updateCounts.UPDATE_CONFIRMED || 0),
      holdUpdateEligibility: Number(updateCounts.HOLD_UPDATE_ELIGIBILITY || 0),
      metadataFalsePositive: Number(updateCounts.SKIP_METADATA_FALSE_POSITIVE || 0),
      upToDate: Number(updateCounts.SKIP_UP_TO_DATE || 0),
      requested: Number(report?.requested ?? report?.downloadReady ?? report?.download ?? 0) || 0,
      verified: Number(report?.verified || 0),
      failed: Number(report?.failed || 0),
      reviewTotal: reviewItems.length,
      reviewActionable: Number(reviewClasses.actionable || 0),
      reviewEligibility: Number(reviewClasses.eligibility || 0),
      reviewTechnical: Number(reviewClasses.technical || 0),
    },
    topActions: topEntries(actions, 10),
    topHoldReasons: topEntries(holdReasons, 10),
    nextCommands: [],
  };

  if (brief.summary.failed > 0) brief.nextCommands.push('npm run agent:status -- --compact');
  if (brief.summary.reviewActionable > 0) brief.nextCommands.push('npm run review');
  if (!brief.nextCommands.length) brief.nextCommands.push('No immediate manual action.');
  return brief;
}

function queryMod({ modId, plan, review }) {
  const id = String(modId || '').trim();
  const planItems = (plan?.items || []).filter(x => String(x.modId || '') === id).map(compactPlanItem);
  const reviewItems = (review?.items || []).filter(x => String(x.modId || '') === id).map(compactReviewItem);
  return {
    modId: id,
    found: planItems.length + reviewItems.length > 0,
    plan: planItems,
    review: reviewItems,
  };
}

function textBrief(doc) {
  const s = doc.summary || {};
  const lines = [
    `run=${doc.runId || 'none'}`,
    `total=${s.total || 0} confirmed=${s.updateConfirmed || 0} verified=${s.verified || 0} failed=${s.failed || 0}`,
    `holdEligibility=${s.holdUpdateEligibility || 0} review=${s.reviewTotal || 0} actionable=${s.reviewActionable || 0}`,
  ];
  if (doc.topHoldReasons?.length) lines.push(`topHolds=${doc.topHoldReasons.map(x => `${x.key}:${x.count}`).join(', ')}`);
  if (doc.nextCommands?.length) lines.push(`next=${doc.nextCommands.join(' | ')}`);
  return lines.join('\n');
}

function main() {
  const requestedRun = argValue(process.argv, '--run', '');
  const runDir = requestedRun ? path.resolve(requestedRun) : findLatestRun(rootDir);
  if (!runDir || !fs.existsSync(runDir)) {
    console.log(hasFlag(process.argv, '--json') ? JSON.stringify({ state: 'NO_RUN' }) : 'state=NO_RUN');
    return;
  }

  const plan = loadJson(path.join(runDir, 'plan.json'), { items: [] });
  const report = loadJson(path.join(runDir, 'final-report.json'), null);
  const review = loadJson(path.join(runDir, 'review-center.json'), { items: [] });
  const modId = argValue(process.argv, '--mod', '');

  if (modId) {
    const result = queryMod({ modId, plan, review });
    console.log(JSON.stringify(result, null, hasFlag(process.argv, '--compact') ? 0 : 2));
    return;
  }

  const brief = buildBrief({ runDir, plan, report, review });
  const outFile = argValue(process.argv, '--out', path.join(rootDir, '.runtime', 'state', 'agent-brief.json'));
  saveJson(outFile, brief);
  console.log(hasFlag(process.argv, '--json') ? JSON.stringify(brief, null, hasFlag(process.argv, '--compact') ? 0 : 2) : textBrief(brief));
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(`agent-brief failed: ${err.message}`); process.exit(1); }
}

module.exports = { compactPlanItem, compactReviewItem, buildBrief, queryMod, textBrief, topEntries };
