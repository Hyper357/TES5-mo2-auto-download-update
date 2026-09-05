#!/usr/bin/env node
// index.js
// 高精度总控流水线：默认只审计；只有显式 --go 才提交下载。

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { scanModsDirectory } = require('./scripts/lib/mo2-reader');
const { generateFomodReport, formatFomodTips } = require('./scripts/lib/fomod-helper');

const rootDir = __dirname;
const cli = process.argv.slice(2);
const positional = cli.filter(x => !x.startsWith('--'));
const modsDir = positional[0] || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
const apiKeyFile = positional[1] || process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key';
const downloadsDir = process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads';
const go = cli.includes('--go');
const forceRefresh = cli.includes('--force-refresh');

function runNode(args, options = {}) {
  const r = cp.spawnSync(process.execPath, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    windowsHide: true,
  });
  if (r.status !== 0) {
    const detail = options.capture ? String(r.stderr || r.stdout || '').trim() : '';
    throw new Error(`命令失败: node ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return options.capture ? String(r.stdout || '') : '';
}

function parseTsvLine(line) {
  const [modId, name, ver, note, fileId, action] = line.split('\t');
  return { modId, name, ver, note, fileId, action };
}

async function run() {
  console.log('========================================================');
  console.log('🛡️ Skyrim MO2 高精度更新流水线 v3');
  console.log(`模式: ${go ? 'DOWNLOAD（仅高置信 DOWNLOAD 项）' : 'AUDIT（默认，不会下载）'}`);
  console.log('========================================================');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestTsv = path.join(rootDir, `manifest-${stamp}.tsv`);
  const planJson = path.join(rootDir, `plan-${stamp}.json`);

  console.log('\n[Step 1/4] 扫描 MO2 + Nexus，并进行 fileId 锚定与变体判定...');
  const checkArgs = [
    path.join(rootDir, 'scripts', 'check-outdated.js'),
    modsDir,
    apiKeyFile,
    '--out', manifestTsv,
    '--report', planJson,
  ];
  if (forceRefresh) checkArgs.push('--force-refresh');
  runNode(checkArgs);

  const lines = fs.readFileSync(manifestTsv, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows = lines.map(parseTsvLine);
  const byAction = new Map();
  for (const row of rows) byAction.set(row.action, (byAction.get(row.action) || 0) + 1);

  console.log('\n[Step 2/4] 决策门禁结果:');
  for (const [action, count] of [...byAction.entries()].sort()) console.log(`  ${action}: ${count}`);
  console.log(`  审计证据: ${planJson}`);
  console.log(`  完整清单: ${manifestTsv}`);

  const downloadRows = rows.filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const holdRows = rows.filter(r => /^HOLD_/.test(r.action || ''));

  if (holdRows.length) {
    console.log(`\n⚠️ 有 ${holdRows.length} 项被安全门禁拦截。它们不会被自动下载。`);
    for (const r of holdRows.slice(0, 20)) console.log(`  - ${r.action} | ${r.modId} | ${r.name} | ${r.note}`);
    if (holdRows.length > 20) console.log(`  ... 另有 ${holdRows.length - 20} 项，详见 plan JSON。`);
  }

  if (!downloadRows.length) {
    console.log('\n✅ 没有达到高置信自动下载门槛的更新项。未触发任何下载。');
    return;
  }

  const runManifest = path.join(rootDir, `run-${stamp}.tsv`);
  fs.writeFileSync(runManifest, downloadRows.map(r => [r.modId, r.name, r.ver, r.note, r.fileId, 'DOWNLOAD'].join('\t')).join('\n') + '\n', 'utf8');
  console.log(`\n高置信 DOWNLOAD 项: ${downloadRows.length}，执行清单: ${runManifest}`);

  if (!go) {
    console.log('\n🔎 当前是 AUDIT 模式：到这里停止。');
    console.log('Pi Agent 应先处理 HOLD_TRANSLATION / HOLD_PATCH / HOLD_MULTI_SOURCE / HOLD_AMBIGUOUS，再由用户或上层任务显式传 --go。');
    return;
  }

  console.log('\n[Step 3/4] 提交高置信文件到 MO2（精确 modId + fileId）...');
  runNode([
    path.join(rootDir, 'scripts', 'nexus-autodl.js'), 'dl', runManifest,
    '--go', '--wait', '6', '--sort', 'small-first',
    '--installed-dir', modsDir,
    '--downloads', downloadsDir,
    '--api-key-file', apiKeyFile,
    '--reconnect',
  ]);

  console.log('\n[Step 4/4] 验证归档与 .meta...');
  const verifyOut = runNode([
    path.join(rootDir, 'scripts', 'nexus-autodl.js'), 'verify', runManifest,
    '--downloads', downloadsDir,
  ], { capture: true });
  console.log(verifyOut);

  const verified = verifyOut.split(/\r?\n/).filter(l => /^VERIFIED\b/.test(l)).length;
  const nonVerified = downloadRows.length - verified;

  const localMods = scanModsDirectory(modsDir);
  const dlItems = downloadRows.map(r => ({ modId: r.modId }));
  const fomodTips = formatFomodTips(generateFomodReport(localMods, dlItems));
  if (fomodTips) {
    const tipsFile = path.join(rootDir, `fomod-install-tips-${stamp}.txt`);
    fs.writeFileSync(tipsFile, fomodTips, 'utf8');
    console.log(`FOMOD 备忘: ${tipsFile}`);
  }

  console.log(`\n✅ 本轮提交 ${downloadRows.length} 项；VERIFIED=${verified}；未完全验证=${nonVerified}。`);
  if (nonVerified > 0) console.log('⚠️ 未 VERIFIED 的归档不得安装；先按 verify 输出逐项处理。');
}

run().catch(err => {
  console.error(`\n❌ Pipeline aborted: ${err.message}`);
  process.exit(1);
});
