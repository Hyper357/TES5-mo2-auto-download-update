#!/usr/bin/env node
// v3.8 pipeline coordinator. Behavior is intentionally equivalent to v3.7; shared helpers reduce duplicated agent context.

const fs = require('fs');
const path = require('path');
const { scanModsDirectory } = require('./scripts/lib/mo2-reader');
const { generateFomodReport, formatFomodTips } = require('./scripts/lib/fomod-helper');
const { createLogger, classifyFailure, sanitizeString } = require('./scripts/lib/diagnostics');
const { parseStrict } = require('./scripts/lib/cli');
const { ensureDir, safeJson, saveJson, writeText } = require('./scripts/lib/fs-json');
const { parseManifestText, formatManifest } = require('./scripts/lib/manifest');
const { runNode, spawnNodeDetached } = require('./scripts/lib/process-runner');

const rootDir = __dirname;

function parseCli(argv) {
  return parseStrict(argv, {
    go: { type: 'boolean', flags: ['--go'], default: false },
    diagnose: { type: 'boolean', flags: ['--diagnose'], default: false },
    debug: { type: 'boolean', flags: ['--debug'], default: false },
    forceRefresh: { type: 'boolean', flags: ['--force-refresh', '--no-cache'], default: false },
    continueOnError: { type: 'boolean', flags: ['--continue-on-error'], default: false },
    reconnect: { type: 'boolean', flags: ['--no-reconnect'], value: false, default: true },
    openReview: { type: 'boolean', flags: ['--no-open-review'], value: false, default: true },
    maxAgeDays: { type: 'number', flags: ['--max-age-days'], default: 14, min: 1 },
    timeoutSec: { type: 'number', flags: ['--timeout-sec'], default: 1200, min: 1 },
    pollSec: { type: 'number', flags: ['--poll-sec'], default: 5, min: 1 },
    maxSubmitAttempts: { type: 'number', flags: ['--max-submit-attempts'], default: 2, min: 1 },
    retryDelaySec: { type: 'number', flags: ['--retry-delay-sec'], default: 5, min: 1 },
  });
}

function launchReviewServer(runDir) {
  const logFile = path.join(runDir, 'review-server-launch.log');
  const child = spawnNodeDetached([path.join(rootDir, 'scripts', 'review-server.js'), '--run', runDir], { cwd: rootDir, logFile });
  return { pid: child.pid, logFile };
}

async function run() {
  const cli = parseCli(process.argv.slice(2));
  const modsDir = cli.positional[0] || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
  const apiKeyFile = cli.positional[1] || process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key';
  const downloadsDir = process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads';
  const auxRegistry = process.env.MO2_AUX_REGISTRY || path.join(rootDir, 'config', 'aux-registry.tsv');
  const patchRelations = process.env.MO2_PATCH_RELATIONS || path.join(rootDir, 'config', 'patch-relations.tsv');
  const sevenzip = process.env.MO2_7Z || process.env.SEVENZIP || '';

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = ensureDir(path.join(rootDir, '.runtime', 'runs', stamp));
  const logger = createLogger(runDir, { debug: cli.debug, runId: stamp });

  console.log('========================================================');
  console.log('🛡️ Skyrim MO2 高精度更新流水线 v3.8');
  console.log(`模式: ${cli.diagnose ? 'DIAGNOSE' : (cli.go ? 'DOWNLOAD + DEFERRED REVIEW' : 'AUDIT')} | Debug=${cli.debug ? 'ON' : 'OFF'}`);
  console.log(`runDir: ${runDir}`);
  console.log('========================================================');
  logger.info('PIPELINE', 'pipeline started', { mode: cli.diagnose ? 'DIAGNOSE' : (cli.go ? 'DOWNLOAD' : 'AUDIT'), debug: cli.debug });

  const diagnoseArgs = [path.join(rootDir, 'scripts', 'diagnose.js'), '--mods-dir', modsDir, '--downloads', downloadsDir, '--api-key-file', apiKeyFile, '--run-dir', runDir];
  if (sevenzip) diagnoseArgs.push('--sevenzip', sevenzip);
  if (cli.debug) diagnoseArgs.push('--debug');

  if (cli.diagnose) {
    const diag = runNode(diagnoseArgs, { capture: true, allowFailure: true });
    process.stdout.write(diag.stdout);
    if (diag.stderr) process.stderr.write(diag.stderr);
    const parsed = safeJson(diag.stdout, {});
    logger[diag.ok ? 'info' : 'error']('DIAGNOSE', `standalone diagnosis ${parsed.health || (diag.ok ? 'HEALTHY' : 'FAILED')}`, { status: parsed.health || 'UNKNOWN' });
    if (!diag.ok) process.exitCode = 2;
    return;
  }

  if (cli.go) {
    console.log('\n[Preflight] 环境健康检查...');
    const diag = runNode(diagnoseArgs, { capture: true, allowFailure: true });
    const parsed = safeJson(diag.stdout, {});
    console.log(`  health=${parsed.health || 'UNKNOWN'} summary=${JSON.stringify(parsed.summary || {})}`);
    logger[diag.ok ? 'info' : 'error']('PREFLIGHT', `health=${parsed.health || 'UNKNOWN'}`, { status: parsed.health || 'UNKNOWN', summary: parsed.summary || {} });
    if (!diag.ok || parsed.health === 'UNHEALTHY') {
      const e = classifyFailure(diag.stderr || diag.stdout || 'preflight failed');
      logger.error('PREFLIGHT', 'real download blocked by environment health gate', { errorCode: e.code, layer: e.layer, action: e.action });
      throw new Error(`环境体检未通过，已阻止 --go。查看 ${path.join(runDir, 'diagnostics', 'environment.json')}`);
    }
  }

  const files = {
    rawManifest: path.join(runDir, 'manifest-raw.tsv'),
    plan: path.join(runDir, 'plan.json'),
    patchDiscovery: path.join(runDir, 'patch-discovery.json'),
    patchTasks: path.join(runDir, 'patch-discovery-tasks.tsv'),
    registryAudit: path.join(runDir, 'registry-audit.json'),
    finalManifest: path.join(runDir, 'manifest-final.tsv'),
    closure: path.join(runDir, 'closure.json'),
    reviewJson: path.join(runDir, 'review-queue.json'),
    reviewTsv: path.join(runDir, 'review-queue.tsv'),
    reviewCenterJson: path.join(runDir, 'review-center.json'),
    reviewCenterHtml: path.join(runDir, 'review-center.html'),
    reviewCenterConfig: path.join(runDir, 'review-center-config.json'),
    executionState: path.join(runDir, 'execution-state.json'),
    finalReport: path.join(runDir, 'final-report.json'),
  };

  console.log('\n[Step 1/9] Main File 精确选择；多分支页面直接标记人工复核...');
  const checkArgs = [path.join(rootDir, 'scripts', 'check-outdated.js'), modsDir, apiKeyFile, '--out', files.rawManifest, '--report', files.plan];
  if (cli.forceRefresh) checkArgs.push('--force-refresh');
  runNode(checkArgs);
  logger.info('SCAN', 'planning scan completed', { report: files.plan });

  console.log('\n[Step 2/9] Patch Discovery Graph：自动项 + 延期人工项全部扫描...');
  const discoveryRun = runNode([
    path.join(rootDir, 'scripts', 'discover-all-patches.js'), files.plan, modsDir,
    '--registry', auxRegistry, '--relations', patchRelations,
    '--max-age-days', String(cli.maxAgeDays), '--out', files.patchDiscovery, '--tasks', files.patchTasks,
  ], { capture: true });
  const discoverySummary = safeJson(discoveryRun.stdout, {});
  console.log(`  targets=${discoverySummary.targets || 0} complete=${discoverySummary.complete || 0} held=${discoverySummary.held || 0} unresolved=${discoverySummary.unresolvedCandidates || 0}`);
  logger.info('PATCH_DISCOVERY', 'patch graph built', { ...discoverySummary, report: files.patchDiscovery, tasks: files.patchTasks });

  console.log('\n[Step 3/9] 审计 REQUIRED aux 的精确 modId/fileId/version...');
  const registryArgs = [path.join(rootDir, 'scripts', 'audit-registry.js'), auxRegistry, apiKeyFile, '--out', files.registryAudit];
  if (cli.forceRefresh) registryArgs.push('--force-refresh');
  const registryAuditRun = runNode(registryArgs, { capture: true });
  const registryAudit = safeJson(registryAuditRun.stdout, {});
  console.log(`  registry audit: ${JSON.stringify(registryAudit.counts || {})}`);

  console.log('\n[Step 4/9] 强制 Patch Discovery + PATCH / TRANSLATION 闭合...');
  const closureRun = runNode([
    path.join(rootDir, 'scripts', 'closure-gate.js'), files.rawManifest, auxRegistry,
    '--plan', files.plan, '--patch-discovery', files.patchDiscovery, '--registry-audit', files.registryAudit,
    '--max-age-days', String(cli.maxAgeDays), '--out', files.finalManifest, '--report', files.closure,
  ], { capture: true });
  const closureSummary = safeJson(closureRun.stdout, {});
  console.log(`  appendedAux=${closureSummary.appendedAux || 0} holds=${closureSummary.holdClosure || 0}`);

  console.log('\n[Step 5/9] 生成 Agent review queue + 人工 Review Center...');
  runNode([path.join(rootDir, 'scripts', 'build-review-queue.js'), files.plan, files.closure, '--patch-discovery', files.patchDiscovery, '--out', files.reviewJson, '--tsv', files.reviewTsv]);
  const centerRun = runNode([path.join(rootDir, 'scripts', 'build-review-center.js'), files.plan, files.patchDiscovery, files.closure, '--out', files.reviewCenterJson, '--html', files.reviewCenterHtml], { capture: true });
  const centerSummary = safeJson(centerRun.stdout, { items: 0, counts: {} });
  saveJson(files.reviewCenterConfig, {
    generatedAt: new Date().toISOString(), modsDir, downloadsDir, apiKeyFile, sevenzip, debug: cli.debug,
    timeoutSec: cli.timeoutSec, pollSec: cli.pollSec,
  });
  console.log(`  humanReview=${centerSummary.items || 0} | ${files.reviewCenterHtml}`);
  logger.info('REVIEW_CENTER', 'human review center generated', { items: centerSummary.items || 0, html: files.reviewCenterHtml });

  const rows = parseManifestText(fs.readFileSync(files.finalManifest, 'utf8'));
  const byAction = new Map();
  for (const row of rows) byAction.set(row.action, (byAction.get(row.action) || 0) + 1);
  const downloadRows = rows.filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const holdRows = rows.filter(r => /^HOLD_/.test(r.action || ''));

  console.log('\n[Step 6/9] 自动阶段门禁结果:');
  for (const [action, count] of [...byAction.entries()].sort()) console.log(`  ${action}: ${count}`);
  console.log(`  自动可下载=${downloadRows.length} | 延后人工复核=${centerSummary.items || 0}`);
  if (holdRows.length) for (const r of holdRows.slice(0, 20)) console.log(`  - ${r.action} | ${r.modId}:${r.fileId} | ${r.name}`);

  const rebuildCenter = () => runNode([
    path.join(rootDir, 'scripts', 'build-review-center.js'), files.plan, files.patchDiscovery, files.closure,
    '--auto-report', files.finalReport, '--out', files.reviewCenterJson, '--html', files.reviewCenterHtml,
  ], { capture: true, allowFailure: true });
  const maybeOpenReview = () => {
    if (!cli.go || !cli.openReview || !(centerSummary.items > 0)) return null;
    const launched = launchReviewServer(runDir);
    logger.info('REVIEW_CENTER', 'review server launched after automatic stage', { pid: launched.pid, logFile: launched.logFile });
    console.log(`\n🎛️ 已启动人工决策中心 pid=${launched.pid}；将使用你的默认浏览器打开。`);
    return launched;
  };

  if (!downloadRows.length) {
    saveJson(files.finalReport, {
      generatedAt: new Date().toISOString(), mode: cli.go ? 'DOWNLOAD' : 'AUDIT', runDir,
      downloadReady: 0, verified: 0, holds: holdRows.length, humanReview: centerSummary.items || 0,
      actions: Object.fromEntries(byAction), patchDiscovery: files.patchDiscovery, reviewCenter: files.reviewCenterHtml, logs: logger.files,
    });
    rebuildCenter();
    console.log('\n✅ 没有高置信自动下载项；复杂项目已全部留在 Review Center。');
    if (!cli.go) console.log(`打开只读报告: ${files.reviewCenterHtml}\n可操作模式: npm run review -- --run "${runDir}"`);
    else maybeOpenReview();
    return;
  }

  const runManifest = path.join(runDir, 'run.tsv');
  writeText(runManifest, formatManifest(downloadRows.map(r => ({ ...r, action: 'DOWNLOAD' }))));
  console.log(`\n通过全部门禁的精确自动 DOWNLOAD 项: ${downloadRows.length}`);
  if (!cli.go) {
    saveJson(files.finalReport, {
      generatedAt: new Date().toISOString(), mode: 'AUDIT', runDir,
      downloadReady: downloadRows.length, holds: holdRows.length, humanReview: centerSummary.items || 0,
      actions: Object.fromEntries(byAction), reviewCenter: files.reviewCenterHtml, logs: logger.files,
    });
    rebuildCenter();
    console.log(`\n🔎 AUDIT 完成。自动项=${downloadRows.length}，人工复核=${centerSummary.items || 0}。`);
    console.log(`只读 HTML: ${files.reviewCenterHtml}\n可操作模式: npm run review -- --run "${runDir}"`);
    return;
  }

  console.log('\n[Step 7/9] 自动处理高置信事务：MAIN → PATCH(es) → TRANSLATION...');
  const execArgs = [
    path.join(rootDir, 'scripts', 'execute-plan.js'), runManifest,
    '--downloads', downloadsDir, '--installed-dir', modsDir, '--api-key-file', apiKeyFile,
    '--state', files.executionState, '--run-dir', runDir,
    '--timeout-sec', String(cli.timeoutSec), '--poll-sec', String(cli.pollSec),
    '--max-submit-attempts', String(cli.maxSubmitAttempts), '--retry-delay-sec', String(cli.retryDelaySec),
  ];
  if (sevenzip) execArgs.push('--sevenzip', sevenzip);
  if (cli.reconnect) execArgs.push('--reconnect');
  if (cli.continueOnError) execArgs.push('--continue-on-error');
  if (cli.debug) execArgs.push('--debug');
  const execRun = runNode(execArgs, { capture: true, allowFailure: true });
  process.stdout.write(execRun.stdout);
  if (execRun.stderr) process.stderr.write(execRun.stderr);
  const execSummary = safeJson(execRun.stdout, { ok: execRun.ok });
  if (!execRun.ok) {
    const e = classifyFailure(execRun.stderr || execRun.stdout);
    logger.error('EXECUTOR', 'transaction executor returned failure', { errorCode: e.code, layer: e.layer, action: e.action });
  }

  console.log('\n[Step 8/9] 全局 verify 自动阶段...');
  const verifyArgs = [path.join(rootDir, 'scripts', 'nexus-autodl.js'), 'verify', runManifest, '--downloads', downloadsDir, '--json'];
  if (sevenzip) verifyArgs.push('--sevenzip', sevenzip);
  const verifyRun = runNode(verifyArgs, { capture: true, allowFailure: true });
  const verifyRows = safeJson(verifyRun.stdout, []);
  const verifyCounts = {};
  for (const r of Array.isArray(verifyRows) ? verifyRows : []) verifyCounts[r.status] = (verifyCounts[r.status] || 0) + 1;

  const localMods = scanModsDirectory(modsDir);
  const fomodTips = formatFomodTips(generateFomodReport(localMods, downloadRows.map(r => ({ modId: r.modId }))));
  let tipsFile = null;
  if (fomodTips) {
    tipsFile = path.join(runDir, 'fomod-install-tips.txt');
    writeText(tipsFile, fomodTips);
  }
  const verified = verifyCounts.VERIFIED || 0;
  const failed = downloadRows.length - verified;
  saveJson(files.finalReport, {
    generatedAt: new Date().toISOString(), mode: 'DOWNLOAD', runDir,
    requested: downloadRows.length, verified, failed, execution: execSummary, verifyCounts,
    holds: holdRows.length, humanReview: centerSummary.items || 0, actions: Object.fromEntries(byAction),
    patchDiscovery: files.patchDiscovery, patchTasks: files.patchTasks, reviewCenter: files.reviewCenterHtml,
    executionState: files.executionState, fomodTips: tipsFile, logs: logger.files,
    failedItems: path.join(runDir, 'diagnostics', 'failed-items.json'),
  });
  rebuildCenter();
  logger[failed ? 'error' : 'info']('PIPELINE', failed ? 'automatic stage completed with non-VERIFIED items' : 'automatic stage completed successfully', {
    requested: downloadRows.length, verified, failed, humanReview: centerSummary.items || 0,
  });

  console.log('\n[Step 9/9] 自动阶段汇报 + 延后人工决策...');
  console.log(`✅ 自动阶段 requested=${downloadRows.length}, VERIFIED=${verified}, failed/not-verified=${failed}`);
  console.log(`🎛️ 人工复核项目=${centerSummary.items || 0} | ${files.reviewCenterHtml}`);
  maybeOpenReview();
  if (failed > 0 || !execRun.ok) {
    console.log('⚠️ 自动阶段存在未 VERIFIED 项；Review Center 不会把这些失败当作成功。');
    process.exitCode = 2;
  }
}

run().catch(err => {
  const msg = sanitizeString(err.message);
  console.error(`\n❌ Pipeline aborted: ${msg}`);
  process.exit(1);
});
