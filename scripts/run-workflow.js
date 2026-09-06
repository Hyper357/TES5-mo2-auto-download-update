#!/usr/bin/env node
'use strict';

const path = require('path');
const { runNode } = require('./lib/process-runner');
const { configureDirectNxmTarget } = require('./lib/mo2-nxm');

const rootDir = path.resolve(__dirname, '..');

const MODE = Object.freeze({
  UPDATE: 'update',
  AUDIT: 'audit',
});

function buildIndexArgs(mode, extraArgs = []) {
  const extras = Array.from(extraArgs || []);
  if (![MODE.UPDATE, MODE.AUDIT].includes(mode)) {
    throw new Error(`未知 workflow mode: ${mode}`);
  }
  if (mode === MODE.AUDIT && extras.includes('--go')) {
    throw new Error('audit 模式禁止 --go；需要真实下载请运行 npm run update');
  }

  // Managed-browser workflow owns reconnect/recovery. Do not let the historical
  // nexus-autodl Edge reconnect path silently spawn a second browser on port 9222.
  const fixed = mode === MODE.UPDATE
    ? ['--go', '--debug', '--continue-on-error', '--force-refresh', '--no-reconnect']
    : ['--force-refresh'];

  return [path.join(rootDir, 'index.js'), ...fixed, ...extras];
}

function workflowDescription(mode) {
  if (mode === MODE.UPDATE) {
    return {
      title: 'FULL UPDATE',
      summary: '管理浏览器 + MO2 → 全量扫描 → Update Eligibility → Main/Variant → Component Closure → 自动下载安全项 → VERIFIED → Review Center',
      noMidstreamConfirmation: true,
      continueOnItemError: true,
      realDownload: true,
    };
  }
  return {
    title: 'AUDIT ONLY',
    summary: '管理浏览器 → 全量扫描 → Update Eligibility → Main/Variant → Component Closure → 生成报告；不真实下载',
    noMidstreamConfirmation: true,
    continueOnItemError: false,
    realDownload: false,
  };
}

function positionalModsDir(extraArgs = []) {
  const list = Array.from(extraArgs || []);
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] || '');
    if (!a.startsWith('-')) return a;
    if (['--max-age-days','--timeout-sec','--poll-sec','--max-submit-attempts','--retry-delay-sec'].includes(a)) i++;
  }
  return process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
}

function main(argv = process.argv.slice(2)) {
  const mode = String(argv[0] || MODE.UPDATE).toLowerCase();
  const extraArgs = argv.slice(1);
  const desc = workflowDescription(mode);

  console.log('========================================================');
  console.log(`🚀 MO2 ${desc.title}`);
  console.log(desc.summary);
  if (desc.realDownload) {
    console.log('授权语义：本命令本身即代表真实下载授权；通过全部安全门禁的项目无需再次询问。');
    console.log('复杂/不确定项目自动延期到 Review Center；单项失败不会中断其余安全项。');
  } else {
    console.log('只审计，不提交真实 NXM 下载。');
  }
  console.log('========================================================');

  console.log('\n[Workflow] 确保项目管理浏览器已启动...');
  runNode([path.join(rootDir, 'scripts', 'browser-manager.js'), 'start'], { cwd: rootDir });
  runNode([path.join(rootDir, 'scripts', 'browser-manager.js'), 'assert'], { cwd: rootDir });

  if (mode === MODE.UPDATE) {
    const modsDir = positionalModsDir(extraArgs);
    console.log('\n[Workflow] 确保 Mod Organizer 2 已运行...');
    runNode([path.join(rootDir, 'scripts', 'mo2-process-manager.js'), 'ensure', '--mods-dir', modsDir], { cwd: rootDir });

    // Prefer ModOrganizer.exe itself as the NXM target. MO2 natively accepts an
    // nxm:// command-line argument and forwards it to the already-running primary
    // instance. This avoids deriving nxmhandler.exe from the repository directory.
    const nxm = configureDirectNxmTarget({ modsDir });
    if (!nxm.ok) throw new Error(`MO2_EXE_NOT_FOUND: 无法从 modsDir=${modsDir} 解析 ModOrganizer.exe`);
    console.log(`[Workflow] NXM 交接目标: ${nxm.executable}`);
  }

  console.log(`\n[Workflow] 启动 ${desc.title} 流水线...`);
  const result = runNode(buildIndexArgs(mode, extraArgs), {
    cwd: rootDir,
    allowFailure: true,
  });

  if (!result.ok) {
    console.error(`\n⚠️ ${desc.title} 已结束，exit=${result.status ?? 'unknown'}。请先看 npm run agent:status；不要把已 VERIFIED 项整批重跑。`);
    process.exitCode = Number.isInteger(result.status) ? result.status : 2;
    return;
  }

  console.log(`\n✅ ${desc.title} 流水线已执行到终点。`);
  if (mode === MODE.UPDATE) {
    console.log('高置信项目已自动处理；需要人工选择的项目已由 Review Center 接管。');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\n❌ workflow failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { MODE, buildIndexArgs, workflowDescription, positionalModsDir, main };
