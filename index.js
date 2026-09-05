#!/usr/bin/env node
// index.js
// v3.1 高精度总控：扫描证据 -> registry API 审计 -> Patch/汉化闭合 -> AI review queue -> 逐项事务下载 -> 最终验收。

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { scanModsDirectory } = require('./scripts/lib/mo2-reader');
const { generateFomodReport, formatFomodTips } = require('./scripts/lib/fomod-helper');

const rootDir = __dirname;

function parseCli(argv) {
  const out = {
    positional: [], go: false, forceRefresh: false, continueOnError: false,
    reconnect: true, maxAgeDays: 14, timeoutSec: 1200, pollSec: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--go') out.go = true;
    else if (a === '--force-refresh' || a === '--no-cache') out.forceRefresh = true;
    else if (a === '--continue-on-error') out.continueOnError = true;
    else if (a === '--no-reconnect') out.reconnect = false;
    else if (a === '--max-age-days') out.maxAgeDays = Number(argv[++i]) || 14;
    else if (a === '--timeout-sec') out.timeoutSec = Number(argv[++i]) || 1200;
    else if (a === '--poll-sec') out.pollSec = Number(argv[++i]) || 5;
    else if (a.startsWith('--')) throw new Error(`未知参数: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

function runNode(args, options = {}) {
  const r = cp.spawnSync(process.execPath, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    windowsHide: true,
  });
  const result = {
    ok: r.status === 0,
    status: r.status,
    stdout: options.capture ? String(r.stdout || '') : '',
    stderr: options.capture ? String(r.stderr || '') : '',
  };
  if (!result.ok && !options.allowFailure) {
    const detail = options.capture ? String(r.stderr || r.stdout || '').trim() : '';
    throw new Error(`命令失败: node ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function parseTsvLine(line) {
  const [modId, name, ver, note, fileId, action] = line.split('\t');
  return { modId, name, ver, note, fileId, action };
}

function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

async function run() {
  const cli = parseCli(process.argv.slice(2));
  const modsDir = cli.positional[0] || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
  const apiKeyFile = cli.positional[1] || process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key';
  const downloadsDir = process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads';
  const auxRegistry = process.env.MO2_AUX_REGISTRY || path.join(rootDir, 'config', 'aux-registry.tsv');
  const sevenzip = process.env.MO2_7Z || process.env.SEVENZIP || '';

  console.log('========================================================');
  console.log('🛡️ Skyrim MO2 高精度更新流水线 v3.1');
  console.log(`模式: ${cli.go ? 'DOWNLOAD（事务执行 + 每项 VERIFIED）' : 'AUDIT（默认，不会下载）'}`);
  console.log('========================================================');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(rootDir, '.runtime', 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });

  const rawManifest = path.join(runDir, 'manifest-raw.tsv');
  const planJson = path.join(runDir, 'plan.json');
  const registryAuditJson = path.join(runDir, 'registry-audit.json');
  const finalManifest = path.join(runDir, 'manifest-final.tsv');
  const closureJson = path.join(runDir, 'closure.json');
  const reviewJson = path.join(runDir, 'review-queue.json');
  const reviewTsv = path.join(runDir, 'review-queue.tsv');
  const executionState = path.join(runDir, 'execution-state.json');
  const finalReport = path.join(runDir, 'final-report.json');

  console.log('\n[Step 1/7] 扫描 MO2 + Nexus：锚定本地 fileId，选择主文件并收集附属证据...');
  const checkArgs = [
    path.join(rootDir, 'scripts', 'check-outdated.js'),
    modsDir, apiKeyFile,
    '--out', rawManifest,
    '--report', planJson,
  ];
  if (cli.forceRefresh) checkArgs.push('--force-refresh');
  runNode(checkArgs);

  console.log('\n[Step 2/7] 审计 aux-registry 中 REQUIRED 的精确 auxModId/fileId/version...');
  const registryArgs = [
    path.join(rootDir, 'scripts', 'audit-registry.js'),
    auxRegistry, apiKeyFile,
    '--out', registryAuditJson,
  ];
  if (cli.forceRefresh) registryArgs.push('--force-refresh');
  const registryAuditRun = runNode(registryArgs, { capture: true });
  const registryAudit = safeJson(registryAuditRun.stdout, {});
  console.log(`  registry audit: ${JSON.stringify(registryAudit.counts || {})}`);

  console.log('\n[Step 3/7] 强制 PATCH / TRANSLATION 证据闭合...');
  const closureRun = runNode([
    path.join(rootDir, 'scripts', 'closure-gate.js'),
    rawManifest, auxRegistry,
    '--plan', planJson,
    '--registry-audit', registryAuditJson,
    '--max-age-days', String(cli.maxAgeDays),
    '--out', finalManifest,
    '--report', closureJson,
  ], { capture: true });
  const closureSummary = safeJson(closureRun.stdout, {});
  console.log(`  appendedAux=${closureSummary.appendedAux || 0} holdClosure=${closureSummary.holdClosure || 0}`);

  console.log('\n[Step 4/7] 生成 Pi/AI Agent 专用 review queue...');
  runNode([
    path.join(rootDir, 'scripts', 'build-review-queue.js'),
    planJson, closureJson,
    '--out', reviewJson,
    '--tsv', reviewTsv,
  ]);

  const lines = fs.readFileSync(finalManifest, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows = lines.map(parseTsvLine);
  const byAction = new Map();
  for (const row of rows) byAction.set(row.action, (byAction.get(row.action) || 0) + 1);

  console.log('\n[Step 5/7] 最终门禁结果:');
  for (const [action, count] of [...byAction.entries()].sort()) console.log(`  ${action}: ${count}`);
  console.log(`  runDir: ${runDir}`);
  console.log(`  review queue: ${reviewTsv}`);

  const downloadRows = rows.filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const holdRows = rows.filter(r => /^HOLD_/.test(r.action || ''));
  if (holdRows.length) {
    console.log(`\n⚠️ ${holdRows.length} 项未通过门禁；它们不会进入真实下载。`);
    for (const r of holdRows.slice(0, 20)) console.log(`  - ${r.action} | ${r.modId}:${r.fileId} | ${r.name}`);
    if (holdRows.length > 20) console.log(`  ... 其余 ${holdRows.length - 20} 项详见 review queue。`);
  }

  if (!downloadRows.length) {
    fs.writeFileSync(finalReport, JSON.stringify({
      generatedAt: new Date().toISOString(), mode: 'AUDIT', runDir,
      download: 0, holds: holdRows.length, actions: Object.fromEntries(byAction),
    }, null, 2));
    console.log('\n✅ 没有通过全部门禁的下载项。未触发任何下载。');
    return;
  }

  const runManifest = path.join(runDir, 'run.tsv');
  fs.writeFileSync(runManifest, downloadRows.map(r => [r.modId, r.name, r.ver, r.note, r.fileId, 'DOWNLOAD'].join('\t')).join('\n') + '\n', 'utf8');
  console.log(`\n通过全部门禁的精确 DOWNLOAD 项: ${downloadRows.length}`);

  if (!cli.go) {
    fs.writeFileSync(finalReport, JSON.stringify({
      generatedAt: new Date().toISOString(), mode: 'AUDIT', runDir,
      downloadReady: downloadRows.length, holds: holdRows.length, actions: Object.fromEntries(byAction),
      reviewQueue: reviewJson,
    }, null, 2));
    console.log('\n🔎 AUDIT 模式结束。先让 Pi Agent 处理 review queue，再重新扫描。');
    console.log('registry 必须绑定目标 mainFileId，并提供新鲜 evidence；扫描证据与 NONE 冲突时不会放行。');
    return;
  }

  console.log('\n[Step 6/7] 按事务逐项提交，并在每个文件后等待 VERIFIED...');
  const execArgs = [
    path.join(rootDir, 'scripts', 'execute-plan.js'),
    runManifest,
    '--downloads', downloadsDir,
    '--installed-dir', modsDir,
    '--api-key-file', apiKeyFile,
    '--state', executionState,
    '--timeout-sec', String(cli.timeoutSec),
    '--poll-sec', String(cli.pollSec),
  ];
  if (sevenzip) execArgs.push('--sevenzip', sevenzip);
  if (cli.reconnect) execArgs.push('--reconnect');
  if (cli.continueOnError) execArgs.push('--continue-on-error');
  const execRun = runNode(execArgs, { capture: true, allowFailure: true });
  process.stdout.write(execRun.stdout);
  if (execRun.stderr) process.stderr.write(execRun.stderr);
  const execSummary = safeJson(execRun.stdout, { ok: execRun.ok });

  console.log('\n[Step 7/7] 对整个 run manifest 再做一次全局验收...');
  const verifyArgs = [
    path.join(rootDir, 'scripts', 'nexus-autodl.js'), 'verify', runManifest,
    '--downloads', downloadsDir, '--json',
  ];
  if (sevenzip) verifyArgs.push('--sevenzip', sevenzip);
  const verifyRun = runNode(verifyArgs, { capture: true, allowFailure: true });
  const verifyRows = safeJson(verifyRun.stdout, []);
  const verifyCounts = {};
  for (const r of Array.isArray(verifyRows) ? verifyRows : []) verifyCounts[r.status] = (verifyCounts[r.status] || 0) + 1;

  const localMods = scanModsDirectory(modsDir);
  const dlItems = downloadRows.map(r => ({ modId: r.modId }));
  const fomodTips = formatFomodTips(generateFomodReport(localMods, dlItems));
  let tipsFile = null;
  if (fomodTips) {
    tipsFile = path.join(runDir, 'fomod-install-tips.txt');
    fs.writeFileSync(tipsFile, fomodTips, 'utf8');
  }

  const verified = verifyCounts.VERIFIED || 0;
  const failed = downloadRows.length - verified;
  const report = {
    generatedAt: new Date().toISOString(), mode: 'DOWNLOAD', runDir,
    requested: downloadRows.length, verified, failed,
    execution: execSummary,
    verifyCounts,
    holds: holdRows.length,
    actions: Object.fromEntries(byAction),
    executionState,
    fomodTips: tipsFile,
  };
  fs.writeFileSync(finalReport, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n✅ 本轮 requested=${downloadRows.length}, VERIFIED=${verified}, failed/not-verified=${failed}`);
  console.log(`最终报告: ${finalReport}`);
  if (failed > 0 || !execRun.ok) {
    console.log('⚠️ 未 VERIFIED 的归档不得安装；按 execution-state.json 定点处理，不要整批重提。');
    process.exitCode = 2;
  }
}

run().catch(err => {
  console.error(`\n❌ Pipeline aborted: ${err.message}`);
  process.exit(1);
});
