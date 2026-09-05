#!/usr/bin/env node
// index.js
// 高精度总控流水线：默认只审计；只有显式 --go 才提交下载。
// v3 核心：主文件选择门禁 + PATCH/TRANSLATION 闭合门禁 + 精确 fileId 下载 + 落盘验证。

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
const auxRegistry = process.env.MO2_AUX_REGISTRY || path.join(rootDir, 'config', 'aux-registry.tsv');
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
  console.log(`模式: ${go ? 'DOWNLOAD（仅通过全部门禁的精确 fileId）' : 'AUDIT（默认，不会下载）'}`);
  console.log('========================================================');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawManifest = path.join(rootDir, `manifest-raw-${stamp}.tsv`);
  const planJson = path.join(rootDir, `plan-${stamp}.json`);
  const finalManifest = path.join(rootDir, `manifest-final-${stamp}.tsv`);
  const closureJson = path.join(rootDir, `closure-${stamp}.json`);

  console.log('\n[Step 1/5] 扫描 MO2 + Nexus，并进行 fileId 锚定、产品线/变体判定...');
  const checkArgs = [
    path.join(rootDir, 'scripts', 'check-outdated.js'),
    modsDir,
    apiKeyFile,
    '--out', rawManifest,
    '--report', planJson,
  ];
  if (forceRefresh) checkArgs.push('--force-refresh');
  runNode(checkArgs);

  console.log('\n[Step 2/5] 强制 PATCH / TRANSLATION 闭合...');
  const closureOut = runNode([
    path.join(rootDir, 'scripts', 'closure-gate.js'),
    rawManifest,
    auxRegistry,
    '--out', finalManifest,
    '--report', closureJson,
  ], { capture: true });
  let closureSummary = null;
  try { closureSummary = JSON.parse(closureOut); } catch (_) {}
  if (closureSummary) {
    console.log(`  appendedAux=${closureSummary.appendedAux} holdClosure=${closureSummary.holdClosure}`);
  }
  console.log(`  registry: ${auxRegistry}`);

  const lines = fs.readFileSync(finalManifest, 'utf8').split(/\r?\n/).filter(Boolean);
  const rows = lines.map(parseTsvLine);
  const byAction = new Map();
  for (const row of rows) byAction.set(row.action, (byAction.get(row.action) || 0) + 1);

  console.log('\n[Step 3/5] 最终门禁结果:');
  for (const [action, count] of [...byAction.entries()].sort()) console.log(`  ${action}: ${count}`);
  console.log(`  选择证据: ${planJson}`);
  console.log(`  闭合证据: ${closureJson}`);
  console.log(`  最终清单: ${finalManifest}`);

  const downloadRows = rows.filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const holdRows = rows.filter(r => /^HOLD_/.test(r.action || ''));

  if (holdRows.length) {
    console.log(`\n⚠️ 有 ${holdRows.length} 项未通过安全门禁，不会被自动下载。`);
    for (const r of holdRows.slice(0, 25)) console.log(`  - ${r.action} | ${r.modId} | ${r.name} | ${r.note}`);
    if (holdRows.length > 25) console.log(`  ... 另有 ${holdRows.length - 25} 项，详见 JSON 报告。`);
  }

  if (!downloadRows.length) {
    console.log('\n✅ 当前没有通过全部门禁的下载项。未触发任何下载。');
    return;
  }

  const runManifest = path.join(rootDir, `run-${stamp}.tsv`);
  fs.writeFileSync(runManifest, downloadRows.map(r => [r.modId, r.name, r.ver, r.note, r.fileId, 'DOWNLOAD'].join('\t')).join('\n') + '\n', 'utf8');
  console.log(`\n通过全部门禁的精确 DOWNLOAD 项: ${downloadRows.length}`);
  console.log(`执行清单: ${runManifest}`);

  if (!go) {
    console.log('\n🔎 当前是 AUDIT 模式：到这里停止。');
    console.log('Pi Agent 必须先消除 HOLD：核验 Nexus Files/Requirements/Translations，并把结论写入 config/aux-registry.tsv。');
    console.log('只有 registry 对当前主版本同时给出 PATCH 与 TRANSLATION 的 NONE/REQUIRED 结论，主 MOD 才能进入下载队列。');
    return;
  }

  console.log('\n[Step 4/5] 提交精确 modId + fileId 到 MO2...');
  runNode([
    path.join(rootDir, 'scripts', 'nexus-autodl.js'), 'dl', runManifest,
    '--go', '--wait', '6', '--sort', 'small-first',
    '--installed-dir', modsDir,
    '--downloads', downloadsDir,
    '--api-key-file', apiKeyFile,
    '--reconnect',
  ]);

  console.log('\n[Step 5/5] 验证归档、.meta 与 7-Zip 完整性...');
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
