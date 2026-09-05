#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { loadJson, saveJson } = require('./lib/fs-json');
const { formatManifest } = require('./lib/manifest');
const { runNode } = require('./lib/process-runner');
const { defaultPolicyFile, rememberVariantPolicy } = require('./lib/variant-policy');

const rootDir = path.resolve(__dirname, '..');
const RESOLVED = new Set(['NOT_APPLICABLE', 'ALREADY_INCLUDED', 'OBSOLETE']);

function componentGroups(item) {
  if (item.componentFamilies?.length) return item.componentFamilies;
  return (item.patchFamilies || []).map(f => ({ kind: 'PATCH', key: `PATCH:${f.family}`, ...f }));
}

function componentDecision(decisionDoc, group) {
  const key = group.key || `${group.kind || 'PATCH'}:${group.family || 'GENERAL'}`;
  const fromComponents = decisionDoc?.components?.[key];
  if (fromComponents) return fromComponents;
  if ((group.kind || 'PATCH') === 'PATCH') return decisionDoc?.patches?.[group.family];
  return null;
}

function validateAndBuild(review, decisions) {
  const rows = [];
  const accepted = [];
  const ignored = [];
  const errors = [];

  for (const item of review.items || []) {
    const d = decisions?.[item.id];
    if (!d) continue;
    if (d.skip) { ignored.push({ itemId: item.id, reason: 'USER_SKIP' }); continue; }

    const groups = componentGroups(item);
    const hasAny = !!d.mainFileId || groups.some(g => componentDecision(d, g)?.decision);
    if (!hasAny) continue;

    const hardCoverageBlocker = (item.blockers || []).find(x => /覆盖不完整|coverage/i.test(x));
    if (hardCoverageBlocker) {
      errors.push({ itemId: item.id, code: 'REVIEW_BLOCKED_BY_DISCOVERY_COVERAGE', detail: hardCoverageBlocker });
      continue;
    }

    let selectedMain = null;
    if (item.mainOptions?.length) {
      if (!d.mainFileId) {
        errors.push({ itemId: item.id, code: 'REVIEW_MAIN_REQUIRED', detail: '该项目需要明确 Main 分支。' });
        continue;
      }
      selectedMain = item.mainOptions.find(o => o.selectable && String(o.fileId) === String(d.mainFileId));
      if (!selectedMain) {
        errors.push({ itemId: item.id, code: 'REVIEW_SELECTION_INVALID', detail: `Main fileId ${d.mainFileId} 不在允许候选中。` });
        continue;
      }
    }

    const componentRows = [];
    let componentError = false;
    for (const group of groups) {
      const kind = group.kind || 'PATCH';
      const family = group.family || 'GENERAL';
      const groupKey = group.key || `${kind}:${family}`;
      const cd = componentDecision(d, group);
      if (!cd?.decision) {
        errors.push({ itemId: item.id, code: 'REVIEW_COMPONENT_DECISION_REQUIRED', kind, family, detail: `每个未闭合 ${kind} component family 必须明确决定。` });
        componentError = true;
        continue;
      }
      if (cd.decision === 'SKIP_FOR_NOW') {
        ignored.push({ itemId: item.id, reason: `USER_SKIP_COMPONENT:${groupKey}` });
        componentError = true;
        continue;
      }
      if (RESOLVED.has(cd.decision)) continue;
      if (cd.decision !== 'DOWNLOAD') {
        errors.push({ itemId: item.id, code: 'REVIEW_SELECTION_INVALID', kind, family, detail: `未知 component decision=${cd.decision}` });
        componentError = true;
        continue;
      }
      const candidate = (group.candidates || []).find(c => c.selectable && String(c.modId) === String(cd.modId) && String(c.fileId) === String(cd.fileId));
      if (!candidate) {
        errors.push({ itemId: item.id, code: 'REVIEW_SELECTION_INVALID', kind, family, detail: `${kind} exact modId:fileId 不在允许候选中，或仍缺 exact fileId。` });
        componentError = true;
        continue;
      }
      componentRows.push({ ...candidate, kind, family, groupKey });
    }
    if (componentError) continue;

    const autoMain = !selectedMain && item.targetMainFileId ? {
      modId: String(item.modId),
      fileId: String(item.targetMainFileId),
      name: item.targetMainName || item.mainName || item.localName || `Mod ${item.modId}`,
      version: item.targetMainVersion || '',
      current: String(item.targetMainFileId) === String(item.localFileId || ''),
      branchKey: '',
      tags: [],
      automaticTarget: true,
    } : null;
    const mainTarget = selectedMain || autoMain;
    const txAnchor = mainTarget?.fileId || item.localFileId || item.modId;
    const tx = `review:${item.modId}:${txAnchor}`;

    if (mainTarget && !mainTarget.current) {
      rows.push({
        modId: String(item.modId),
        name: mainTarget.name,
        ver: mainTarget.version,
        note: `tx=${tx}; ${mainTarget.automaticTarget ? 'planner-main-released-after-component-review' : 'user-review-confirmed'}${mainTarget.branchKey ? `; branch=${mainTarget.branchKey}` : ''}`,
        fileId: String(mainTarget.fileId),
        action: 'DOWNLOAD',
      });
    }
    for (const c of componentRows) {
      rows.push({
        modId: String(c.modId),
        name: c.name,
        ver: c.version,
        note: `tx=${tx}; closure:${c.kind}; family=${c.family}; user-review-confirmed`,
        fileId: String(c.fileId),
        action: 'DOWNLOAD',
      });
    }

    accepted.push({
      itemId: item.id,
      tx,
      main: mainTarget ? mainTarget.fileId : null,
      automaticMain: !!autoMain,
      rememberMain: !!(d.rememberMain && selectedMain),
      mainSelection: selectedMain ? {
        modId: String(item.modId),
        fileId: String(selectedMain.fileId),
        name: selectedMain.name || '',
        version: selectedMain.version || '',
        branchKey: selectedMain.branchKey || '',
        tags: selectedMain.tags || [],
      } : null,
      components: componentRows.map(c => ({ kind: c.kind, family: c.family, exact: `${c.modId}:${c.fileId}` })),
      patches: componentRows.filter(c => c.kind === 'PATCH').map(c => `${c.modId}:${c.fileId}`),
    });
  }

  return { rows, accepted, ignored, errors };
}

function persistRememberedPolicies(built, policyFile) {
  const results = [];
  for (const accepted of built.accepted || []) {
    if (!accepted.rememberMain || !accepted.mainSelection) continue;
    const saved = rememberVariantPolicy(policyFile, accepted.mainSelection, { source: 'USER_REVIEW' });
    results.push({ itemId: accepted.itemId, ...saved });
  }
  return results;
}

function main() {
  const runDir = path.resolve(argValue(process.argv, '--run', process.argv[2] || ''));
  if (!runDir || !fs.existsSync(runDir)) throw new Error('缺少有效 --run <runDir>');
  const reviewFile = path.join(runDir, 'review-center.json');
  const decisionsFile = argValue(process.argv, '--decisions', path.join(runDir, 'review-decisions.json'));
  const configFile = path.join(runDir, 'review-center-config.json');
  const review = loadJson(reviewFile, { items: [] });
  const decisionsDoc = loadJson(decisionsFile, { decisions: {} });
  const config = loadJson(configFile, {});
  const built = validateAndBuild(review, decisionsDoc.decisions || decisionsDoc);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(runDir, 'review-jobs', stamp);
  fs.mkdirSync(jobDir, { recursive: true });
  const jobFile = path.join(jobDir, 'job.json');
  const manifest = path.join(jobDir, 'review-run.tsv');
  const state = path.join(jobDir, 'execution-state.json');
  const policyFile = config.variantPolicyFile || defaultPolicyFile(rootDir);
  let policyUpdates = [];
  const writeJob = extra => saveJson(jobFile, { generatedAt: new Date().toISOString(), runDir, jobDir, policyFile, policyUpdates, ...built, ...extra });

  if (built.errors.length) {
    writeJob({ status: 'BLOCKED', errors: built.errors });
    console.log(JSON.stringify({ ok: false, status: 'BLOCKED', jobDir, errors: built.errors }, null, 2));
    process.exit(2);
  }

  policyUpdates = persistRememberedPolicies(built, policyFile);

  if (!built.rows.length) {
    writeJob({ status: 'NO_DOWNLOADS' });
    console.log(JSON.stringify({ ok: true, status: 'NO_DOWNLOADS', jobDir, accepted: built.accepted, policyUpdates }, null, 2));
    return;
  }

  for (const k of ['modsDir', 'downloadsDir', 'apiKeyFile']) {
    if (!config[k]) throw new Error(`review-center-config 缺少 ${k}`);
  }

  const diagArgs = [path.join(__dirname, 'diagnose.js'), '--mods-dir', config.modsDir, '--downloads', config.downloadsDir, '--api-key-file', config.apiKeyFile, '--run-dir', jobDir];
  if (config.sevenzip) diagArgs.push('--sevenzip', config.sevenzip);
  const dr = runNode(diagArgs, { capture: true, allowFailure: true });
  if (!dr.ok) {
    writeJob({ status: 'PREFLIGHT_FAILED', stdout: dr.stdout || '', stderr: dr.stderr || '' });
    console.log(JSON.stringify({ ok: false, status: 'PREFLIGHT_FAILED', jobDir, policyUpdates }, null, 2));
    process.exit(2);
  }

  fs.writeFileSync(manifest, formatManifest(built.rows), 'utf8');
  writeJob({ status: 'RUNNING', manifest, state });

  const args = [path.join(__dirname, 'execute-plan.js'), manifest, '--downloads', config.downloadsDir, '--installed-dir', config.modsDir, '--api-key-file', config.apiKeyFile, '--state', state, '--run-dir', jobDir, '--reconnect'];
  if (config.sevenzip) args.push('--sevenzip', config.sevenzip);
  if (config.debug) args.push('--debug');
  if (config.timeoutSec) args.push('--timeout-sec', String(config.timeoutSec));
  if (config.pollSec) args.push('--poll-sec', String(config.pollSec));
  const er = runNode(args, { allowFailure: true });
  const finalStatus = er.ok ? 'COMPLETED' : 'FAILED';
  writeJob({ status: finalStatus, manifest, state, exitCode: er.status });
  if (!er.ok) process.exit(er.status || 1);
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(`review-download failed: ${err.message}`); process.exit(1); }
}

module.exports = { componentGroups, componentDecision, validateAndBuild, persistRememberedPolicies };
