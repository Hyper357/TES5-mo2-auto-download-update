#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { loadJson, writeText } = require('./lib/fs-json');
const { parseManifestText, formatManifest } = require('./lib/manifest');
const { findLatestRun } = require('./lib/runtime');
const { runNode } = require('./lib/process-runner');
const { scanExactDownload } = require('./lib/download-guard');
const { buildEnvironmentGraph } = require('./lib/mo2-environment');
const { assessAuxRowEnvironment } = require('./lib/aux-applicability');
const {
  buildLocalIndex,
  localExecutionGuard,
  txOf,
  isTransactionMain,
  clampConcurrency,
} = require('./execute-plan');

const ROOT = path.resolve(__dirname, '..');

function intArg(argv, name, fallback, min, max) {
  const raw = argValue(argv, name, String(fallback));
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function groupDownloadRows(rows) {
  const groups = new Map();
  for (const row of rows.filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId)) {
    const tx = txOf(row);
    if (!groups.has(tx)) groups.set(tx, []);
    groups.get(tx).push(row);
  }
  return groups;
}

function runtimeConfig(runDir) {
  const saved = loadJson(path.join(runDir, 'review-center-config.json'), {});
  return {
    modsDir: saved.modsDir || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods',
    downloadsDir: saved.downloadsDir || process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads',
    apiKeyFile: saved.apiKeyFile || process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key',
    sevenzip: saved.sevenzip || process.env.MO2_7Z || process.env.SEVENZIP || '',
    timeoutSec: Number(saved.timeoutSec || 1200) || 1200,
  };
}

function chooseTransactions({ groups, count, modsDir, downloadsDir, environmentGraph = null }) {
  const localIndex = buildLocalIndex(modsDir);
  const graph = environmentGraph || buildEnvironmentGraph({ modsDir });
  const selected = [];
  const excluded = [];

  for (const [tx, list] of groups) {
    const main = list.find(row => isTransactionMain(row, tx));
    if (!main) {
      excluded.push({ tx, reason: 'TRANSACTION_MAIN_NOT_FOUND' });
      continue;
    }
    const guard = localExecutionGuard(main, localIndex, {
      installedDir: modsDir,
      requireExistingLocal: true,
    });
    if (guard.decision !== 'ALLOW') {
      excluded.push({ tx, modId: main.modId, name: main.name, reason: guard.reason, decision: guard.decision });
      continue;
    }
    const disk = scanExactDownload(downloadsDir, main.modId, main.fileId);
    if (disk.status === 'COMPLETE') {
      excluded.push({ tx, modId: main.modId, name: main.name, reason: 'TARGET_ARCHIVE_ALREADY_IN_DOWNLOADS', decision: 'SKIP' });
      continue;
    }
    if (disk.status === 'INFLIGHT') {
      excluded.push({ tx, modId: main.modId, name: main.name, reason: 'TARGET_ARCHIVE_INFLIGHT', decision: 'HOLD' });
      continue;
    }

    const kept = [main];
    const suppressedAux = [];
    let auxHold = null;
    for (const aux of list) {
      if (aux === main) continue;
      const applicability = assessAuxRowEnvironment(aux, graph);
      if (applicability.decision === 'SKIP') {
        suppressedAux.push({ modId: aux.modId, fileId: aux.fileId, name: aux.name, ...applicability });
        continue;
      }
      if (applicability.decision === 'HOLD') {
        auxHold = { modId: aux.modId, fileId: aux.fileId, name: aux.name, ...applicability };
        break;
      }
      kept.push(aux);
    }
    if (auxHold) {
      excluded.push({
        tx, modId: main.modId, name: main.name,
        reason: 'AUX_APPLICABILITY_UNPROVEN', decision: 'HOLD', aux: auxHold,
      });
      continue;
    }

    selected.push({ tx, list: kept, main, guard, suppressedAux });
    if (selected.length >= count) break;
  }
  return { selected, excluded };
}

function main(argv = process.argv.slice(2)) {
  const count = intArg(argv, '--count', 20, 1, 50);
  const concurrency = clampConcurrency(intArg(argv, '--concurrency', 2, 1, 3));
  const requestedRun = argValue(argv, '--run', '');
  const runDir = requestedRun
    ? path.resolve(requestedRun)
    : findLatestRun(ROOT, dir => fs.existsSync(path.join(dir, 'manifest-final.tsv')));
  if (!runDir) throw new Error('BATCH_SOURCE_RUN_NOT_FOUND: 找不到已有 manifest-final.tsv；请先完成一次 audit/update 扫描。');

  const sourceManifest = path.join(runDir, 'manifest-final.tsv');
  const rows = parseManifestText(fs.readFileSync(sourceManifest, 'utf8'));
  const groups = groupDownloadRows(rows);
  const cfg = runtimeConfig(runDir);

  const browser = runNode([path.join(ROOT, 'scripts', 'browser-manager.js'), 'assert'], { cwd: ROOT, capture: true, allowFailure: true });
  if (!browser.ok) throw new Error(`BATCH_BROWSER_NOT_MANAGED: ${browser.stderr || browser.stdout}`);
  runNode([path.join(ROOT, 'scripts', 'mo2-process-manager.js'), 'ensure', '--mods-dir', cfg.modsDir], { cwd: ROOT });

  const environmentGraph = buildEnvironmentGraph({ modsDir: cfg.modsDir });
  const choice = chooseTransactions({ groups, count, modsDir: cfg.modsDir, downloadsDir: cfg.downloadsDir, environmentGraph });
  if (!choice.selected.length) {
    throw new Error(`BATCH_NO_ELIGIBLE_TRANSACTIONS: source=${runDir} excluded=${choice.excluded.length}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const batchDir = path.join(ROOT, '.runtime', 'batches', stamp);
  fs.mkdirSync(batchDir, { recursive: true });
  const batchManifest = path.join(batchDir, 'batch.tsv');
  const stateFile = path.join(batchDir, 'execution-state.json');
  const selectedRows = choice.selected.flatMap(x => x.list.map(r => ({ ...r, action: 'DOWNLOAD' })));
  writeText(batchManifest, formatManifest(selectedRows));

  const selectionReport = {
    generatedAt: new Date().toISOString(),
    sourceRun: runDir,
    batchDir,
    requestedTransactions: count,
    selectedTransactions: choice.selected.length,
    selectedRows: selectedRows.length,
    concurrency,
    environmentProfile: environmentGraph.profile?.name || '',
    selected: choice.selected.map(x => ({
      tx: x.tx,
      modId: x.main.modId,
      fileId: x.main.fileId,
      name: x.main.name,
      localVersions: x.guard.localVersions || [],
      targetVersion: x.main.ver,
      companionRows: Math.max(0, x.list.length - 1),
      suppressedAuxNotApplicable: x.suppressedAux || [],
    })),
    excludedBeforeSelection: choice.excluded,
  };
  fs.writeFileSync(path.join(batchDir, 'selection.json'), JSON.stringify(selectionReport, null, 2), 'utf8');

  console.log('========================================================');
  console.log('🧪 MO2 SAFE BATCH UPDATE');
  console.log(`sourceRun=${runDir}`);
  console.log(`selectedTransactions=${choice.selected.length}/${count} rows=${selectedRows.length} concurrency=${concurrency}`);
  for (const item of selectionReport.selected) {
    console.log(`  ✓ ${item.modId}:${item.fileId} | ${item.name} | ${item.localVersions.join(',') || '?'} -> ${item.targetVersion}`);
    for (const aux of item.suppressedAuxNotApplicable || []) console.log(`    ↳ SKIP aux ${aux.modId}:${aux.fileId} ${aux.name} (${aux.reason})`);
  }
  console.log('========================================================');

  const args = [
    path.join(ROOT, 'scripts', 'execute-plan.js'), batchManifest,
    '--downloads', cfg.downloadsDir,
    '--installed-dir', cfg.modsDir,
    '--api-key-file', cfg.apiKeyFile,
    '--state', stateFile,
    '--run-dir', batchDir,
    '--timeout-sec', String(cfg.timeoutSec),
    '--max-submit-attempts', '2',
    '--download-concurrency', String(concurrency),
    '--continue-on-error',
  ];
  if (cfg.sevenzip) args.push('--sevenzip', cfg.sevenzip);

  const result = runNode(args, { cwd: ROOT, capture: true, allowFailure: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`\nBatch artifacts: ${batchDir}`);
  if (!result.ok) process.exitCode = Number.isInteger(result.status) ? result.status : 2;
}

if (require.main === module) {
  try { main(); }
  catch (err) {
    console.error(`BATCH_UPDATE_FAILED ${err.code || ''} ${String(err.message || err)}`);
    process.exit(1);
  }
}

module.exports = { groupDownloadRows, runtimeConfig, chooseTransactions, main };
