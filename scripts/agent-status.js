#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue, hasFlag } = require('./lib/cli');
const { loadJson, saveJson } = require('./lib/fs-json');
const { findLatestRun, latestReviewJob } = require('./lib/runtime');
const { managedSessionStatus } = require('./lib/browser-session');
const { defaultPolicyFile, loadVariantPolicies } = require('./lib/variant-policy');
const { compactEnvironmentSummary } = require('./lib/mo2-environment');

const rootDir = path.resolve(__dirname, '..');

function countTsvRows(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(x => x.trim() && !x.startsWith('#')).length;
}

function sourceHintsFor(code) {
  const c = String(code || '');
  if (/^(NXM_|DOM_|NEXUS_LOGIN|CDP_)/.test(c)) return ['search scripts/nexus-autodl.js for the errorCode/function', 'scripts/lib/browser-session.js'];
  if (/^(META_|FILEID_|VERSION_|ARCHIVE_|VERIFY_|SEVENZIP_)/.test(c)) return ['scripts/execute-plan.js', 'search scripts/nexus-autodl.js verify'];
  if (/^(MO2_DIALOG|MO2_UI)/.test(c)) return ['scripts/lib/mo2-ui-guard.js', 'scripts/mo2-ui.js', 'scripts/mo2-ui-state.ps1'];
  if (/^(MO2_QUEUE|MO2_DOWNLOAD|CONCURRENT_|LEDGER_)/.test(c)) return ['scripts/lib/download-guard.js', 'scripts/execute-plan.js'];
  if (/^(MO2_ENVIRONMENT|PROFILE_)/.test(c)) return ['scripts/lib/mo2-environment.js', 'npm run environment:status'];
  if (/UPDATE_ELIGIBILITY|METADATA_FALSE_POSITIVE|UPDATE_TARGET/.test(c)) return ['scripts/lib/update-eligibility.js', 'scripts/check-outdated.js', 'npm run updates:status'];
  if (/^VARIANT_POLICY/.test(c)) return ['scripts/lib/variant-policy.js', 'scripts/lib/variant-review.js', 'npm run variant:status'];
  if (/COMPONENT|RESOURCE|BODYSLIDE|PHYSICS|HOTFIX/.test(c)) return ['scripts/discover-patches.js', 'scripts/lib/component-discovery.js', 'scripts/lib/mo2-environment.js', 'scripts/closure-gate.js'];
  if (/^(CLOSURE_|REGISTRY_|VARIANT_|AMBIGUOUS_MAIN)/.test(c)) return ['scripts/closure-gate.js', 'scripts/lib/file-selector.js', 'scripts/lib/variant-review.js'];
  if (/PATCH/.test(c)) return ['scripts/discover-patches.js', 'scripts/lib/component-discovery.js', 'scripts/lib/patch-discovery.js', 'scripts/lib/mo2-environment.js'];
  return [];
}

function readRecentErrors(runDir, limit = 5) {
  const file = path.join(runDir, 'logs', 'errors.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
  return lines.map(line => {
    let e;
    try { e = JSON.parse(line); } catch { return { code: 'UNPARSEABLE_LOG_ENTRY', sourceHints: [] }; }
    const code = e.errorCode || e.code || e.error?.code || 'UNKNOWN';
    return {
      code,
      stage: e.stage || e.component || null,
      modId: e.modId || e.context?.modId || null,
      fileId: e.fileId || e.context?.fileId || null,
      status: e.status || null,
      action: e.action || e.error?.action || null,
      sourceHints: sourceHintsFor(code),
    };
  });
}

function ledgerSummary() {
  const stateDir = path.join(rootDir, '.runtime', 'state');
  const ledger = loadJson(path.join(stateDir, 'submission-ledger.json'), { items: {} });
  const counts = {};
  for (const item of Object.values(ledger.items || {})) {
    const status = item.status || 'UNKNOWN';
    counts[status] = (counts[status] || 0) + 1;
  }
  return { counts, executorLocked: fs.existsSync(path.join(stateDir, 'download-executor.lock')) };
}

function variantMemorySummary() {
  const file = defaultPolicyFile(rootDir);
  const doc = loadVariantPolicies(file);
  return { file, count: Object.keys(doc.policies || {}).length, updatedAt: doc.updatedAt || null };
}

function updateSummary(plan) {
  const counts = plan?.updateEligibilityCounts || {};
  return {
    enabled: !!plan?.updateEligibilityGate,
    confirmed: Number(counts.UPDATE_CONFIRMED || 0),
    review: Number(counts.HOLD_UPDATE_ELIGIBILITY || 0),
    metadataFalsePositive: Number(counts.SKIP_METADATA_FALSE_POSITIVE || 0),
    upToDate: Number(counts.SKIP_UP_TO_DATE || 0),
    ignored: Number(counts.SKIP_IGNORED_UPDATE || 0),
    counts,
  };
}

function pipelineState({ report, review, errors, componentTasks, updateReview = 0, latestJob }) {
  if (!report) return 'IN_PROGRESS_OR_ABORTED';
  if ((report.failed || 0) > 0 || errors.length) return 'ATTENTION';
  if (latestJob?.status === 'RUNNING') return 'REVIEW_DOWNLOAD_RUNNING';
  if (latestJob?.status === 'FAILED' || latestJob?.status === 'BLOCKED') return 'ATTENTION';
  if (updateReview > 0) return 'UPDATE_REVIEW_REQUIRED';
  if ((review.items || []).length > 0) return 'REVIEW_REQUIRED';
  if (componentTasks > 0) return 'COMPONENT_REVIEW_REQUIRED';
  if (report.mode === 'AUDIT' && (report.downloadReady || 0) > 0) return 'READY_FOR_GO';
  return 'COMPLETE';
}

function nextActions(state, summary) {
  const actions = [];
  if (summary.browser.state !== 'MANAGED') actions.push('npm run browser:start');
  if (summary.environment && !summary.environment.profileResolved) actions.push('MO2 active profile is unresolved; set MO2_PROFILE_NAME or MO2_PROFILE_DIR before relying on automatic applicability decisions.');
  if (summary.updates?.review > 0) actions.push('Run npm run updates:status and resolve UPDATE_REVIEW_REQUIRED before treating the mod as outdated.');
  if (state === 'ATTENTION') actions.push('Use errors[].sourceHints; do not read large source files wholesale.');
  if (summary.componentTasks > 0) actions.push('Process component discovery tasks before changing any HOLD; do not assume every candidate is REQUIRED.');
  if ((summary.review.total || 0) > 0) actions.push('Open Review Center with npm run review; do not guess complex variants/components.');
  if (state === 'READY_FOR_GO') actions.push('Await explicit user authorization before --go.');
  if (!actions.length) actions.push('No action required.');
  return actions;
}

async function buildStatus(runDir) {
  const report = loadJson(path.join(runDir, 'final-report.json'), null);
  const plan = loadJson(path.join(runDir, 'plan.json'), null);
  const updates = updateSummary(plan);
  const review = loadJson(path.join(runDir, 'review-center.json'), { counts: {}, items: [] });
  const environmentFile = path.join(runDir, 'mo2-environment.json');
  const environmentGraph = loadJson(environmentFile, null);
  const environment = compactEnvironmentSummary(environmentGraph);
  const errors = readRecentErrors(runDir, 5);
  const taskFile = path.join(runDir, 'patch-discovery-tasks.tsv');
  const componentTasks = countTsvRows(taskFile);
  const browser = await managedSessionStatus({ timeout: 800 }).catch(err => ({ state: 'ERROR', errorCode: err.code || 'BROWSER_STATUS_FAILED' }));
  const job = latestReviewJob(runDir);
  const summary = {
    version: 5,
    generatedAt: new Date().toISOString(),
    runDir,
    browser: { state: browser.state || 'UNKNOWN', managed: browser.state === 'MANAGED' },
    environment,
    updates,
    automatic: {
      mode: report?.mode || null,
      requested: Number(report?.requested ?? report?.downloadReady ?? report?.download ?? 0) || 0,
      verified: Number(report?.verified ?? 0) || 0,
      failed: Number(report?.failed ?? 0) || 0,
      holds: Number(report?.holds ?? 0) || 0,
    },
    review: {
      total: (review.items || []).length,
      variant: Number(review.counts?.variant || 0),
      component: Number(review.counts?.component ?? review.counts?.patch ?? 0),
      patch: Number(review.counts?.patch || 0),
      other: Number(review.counts?.other || 0),
      latestJob: job ? { status: job.status || 'UNKNOWN', jobDir: job.jobDir || null } : null,
    },
    variantMemory: variantMemorySummary(),
    componentTasks,
    patchTasks: componentTasks,
    errors,
    queue: ledgerSummary(),
    artifacts: {
      plan: plan ? path.join(runDir, 'plan.json') : null,
      environment: environmentGraph ? environmentFile : null,
      reviewCenter: fs.existsSync(path.join(runDir, 'review-center.html')) ? path.join(runDir, 'review-center.html') : null,
      failedItems: fs.existsSync(path.join(runDir, 'diagnostics', 'failed-items.json')) ? path.join(runDir, 'diagnostics', 'failed-items.json') : null,
      componentTasks: componentTasks ? taskFile : null,
      patchTasks: componentTasks ? taskFile : null,
    },
  };
  summary.state = pipelineState({ report, review, errors, componentTasks, updateReview: updates.review, latestJob: job });
  summary.nextActions = nextActions(summary.state, summary);
  return summary;
}

async function main() {
  const requested = argValue(process.argv, '--run', '');
  const runDir = requested ? path.resolve(requested) : findLatestRun(rootDir);
  if (!runDir || !fs.existsSync(runDir)) {
    const empty = { version: 5, generatedAt: new Date().toISOString(), state: 'NO_RUN', variantMemory: variantMemorySummary(), nextActions: ['Run an AUDIT first.'] };
    console.log(JSON.stringify(empty, null, hasFlag(process.argv, '--compact') ? 0 : 2));
    return;
  }
  const status = await buildStatus(runDir);
  const outFile = argValue(process.argv, '--out', path.join(rootDir, '.runtime', 'state', 'agent-status.json'));
  saveJson(outFile, status);
  console.log(JSON.stringify(status, null, hasFlag(process.argv, '--compact') ? 0 : 2));
}

if (require.main === module) {
  main().catch(err => { console.error(JSON.stringify({ state: 'STATUS_FAILED', error: err.message })); process.exit(1); });
}

module.exports = { buildStatus, pipelineState, readRecentErrors, sourceHintsFor, variantMemorySummary, updateSummary };
