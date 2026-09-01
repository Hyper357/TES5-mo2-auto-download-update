#!/usr/bin/env node
// index.js
// 统一一键更新维护总控流水线 (One-Command Automation Pipeline)

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { scanModsDirectory } = require('./scripts/lib/mo2-reader');
const { generateFomodReport, formatFomodTips } = require('./scripts/lib/fomod-helper');

const rootDir = __dirname;
const modsDir = process.argv[2] || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
const apiKeyFile = process.argv[3] || process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key';
const downloadsDir = process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads';

async function run() {
  console.log('========================================================');
  console.log('🚀 Skyrim MO2 自动更新维护总控流水线 (Pipeline)');
  console.log('========================================================');

  const today = new Date().toISOString().slice(0, 10);
  const manifestTsv = path.join(rootDir, `manifest-${today}.tsv`);

  // Step 1: 扫描并生成清单
  console.log('\n[Step 1/4] 执行智能并发扫描与变体画像审计...');
  const checkCmd = `node "${path.join(rootDir, 'scripts', 'check-outdated.js')}" "${modsDir}" "${apiKeyFile}" --out "${manifestTsv}"`;
  cp.execSync(checkCmd, { stdio: 'inherit' });

  // Step 2: 过滤待下载项
  const tsvLines = fs.readFileSync(manifestTsv, 'utf8').trim().split('\n');
  const downloadLines = tsvLines.filter(l => l.endsWith('\tDOWNLOAD'));
  console.log(`\n[Step 2/4] 甄别完成: 候选待下载项 ${downloadLines.length} 项 (其余自动归类跳过)`);

  if (downloadLines.length === 0) {
    console.log('✨ 本地所有 Mod 均已处于最新状态或处于安全保护中，无需下载！');
    return;
  }

  const runManifest = path.join(rootDir, `run-${today}.tsv`);
  fs.writeFileSync(runManifest, downloadLines.join('\n') + '\n', 'utf8');

  // Step 3: 触发小文件优先调度下载
  console.log('\n[Step 3/4] 启动浏览器会话并执行自适应流控批量下载...');
  const dlCmd = `node "${path.join(rootDir, 'scripts', 'nexus-autodl.js')}" dl "${runManifest}" --go --wait 2 --sort small-first --installed-dir "${modsDir}" --downloads "${downloadsDir}" --api-key-file "${apiKeyFile}" --reconnect`;
  try {
    cp.execSync(dlCmd, { stdio: 'inherit' });
  } catch (_) {
    console.log('⚠️ 下载批处理完成或触发断点保存。');
  }

  // Step 4: 完整性验收与 FOMOD 备忘生成
  console.log('\n[Step 4/4] 7-Zip 完整性解压测试与 FOMOD 安装备忘推导...');
  const verifyCmd = `node "${path.join(rootDir, 'scripts', 'nexus-autodl.js')}" verify "${runManifest}" --downloads "${downloadsDir}"`;
  const verifyOut = cp.execSync(verifyCmd, { encoding: 'utf8' });
  console.log(verifyOut);

  // FOMOD 安装选择备忘推导
  const localMods = scanModsDirectory(modsDir);
  const dlItems = downloadLines.map(l => ({ modId: l.split('\t')[0] }));
  const fomodReports = generateFomodReport(localMods, dlItems);
  const fomodTips = formatFomodTips(fomodReports);
  if (fomodTips) {
    console.log(fomodTips);
    fs.writeFileSync(path.join(rootDir, `fomod-install-tips-${today}.txt`), fomodTips, 'utf8');
  }

  console.log('\n🎉 一键维护流水线执行完毕！所有安装包均已在 downloads 目录就绪。');
}

run().catch(console.error);
