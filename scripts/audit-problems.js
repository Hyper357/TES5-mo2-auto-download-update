#!/usr/bin/env node
'use strict';

// Proactive problem sweep for an audit run. The point is to stop hiding the
// rows that are neither "auto download" nor visible in the review queue: every
// row of an audit lands in exactly one problem group here, so the operator does
// not have to notice a missing update and come back and ask for it.
//
// This is a REPORT, never a decision: it never downloads and never changes the
// plan. It only says WHY a row is not auto-downloadable, and whether the exact
// target file is already known (-> safe to fetch) or needs a human call.

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { loadJson, saveJson } = require('./lib/fs-json');
const { findLatestRun } = require('./lib/runtime');

const rootDir = path.resolve(__dirname, '..');

const GROUPS = {
  SUSPECT_UPDATE: {
    label: '有更新，但只能人工确认',
    action: '可精确下载（target fileId 已附）',
    exact: true,
  },
  WEAK_DEFERRED: {
    label: '弱证据（同页有更新文件，未证明是同一 artefact）',
    action: '人工挑精确文件（ISS-001 边界）',
    exact: true,
  },
  AMBIGUOUS: {
    label: '多个并列候选，分不清该下哪个',
    action: '人工挑精确文件',
    exact: false,
  },
  COMPONENT: {
    label: '组件（补丁/热修/资源）未定，阻塞本体',
    action: '确认组件是否还需要，或等作者更新',
    exact: false,
  },
  VARIANT_CONFLICT: {
    label: '更新链指向不同分支（变体冲突）',
    action: '人工确认分支',
    exact: false,
  },
  RUNTIME_BLOCK: {
    label: '新文件要求更高运行时/SKSE',
    action: '确认是否要升级游戏版本（本机通常不要）',
    exact: false,
  },
  EDITION_BLOCK: {
    label: '版本分支不匹配（SE/AE/VR）',
    action: '人工确认分支',
    exact: false,
  },
  IDENTITY: {
    label: '本地文件身份无法确定（同 modId 多夹 / 装了 Nexus 上不存在的档）',
    action: '在 MO2 里核对安装来源',
    exact: false,
  },
  LOCAL_NEWER: {
    label: '本地版本比 Nexus 还新（改名/自打包常见）',
    action: '一般无需动作，确认即可',
    exact: false,
  },
  SAME_VERSION_REPLACEMENT: {
    label: '同版本换文件（作者重传）',
    action: '人工确认是否值得换',
    exact: true,
  },
  SAME_VERSION_CONFLICT: {
    label: '版本号相同但精确文件ID不同（作者重传/换档）',
    action: '通常已是最新，扫一眼即可',
    exact: false,
  },
  METADATA_DRIFT: {
    label: '元数据漂移（版本串和文件对不上，实际已最新）',
    action: '一般无需动作',
    exact: false,
  },
  DISMISSED_SIGNAL: {
    label: 'MO2 报更新，但页面上找不到更新的在架文件',
    action: '通常是 MO2 虚警，扫一眼即可',
    exact: false,
  },
  API_BLIND: {
    label: 'Nexus API 拒绝（403/私有/已删除）',
    action: '无法自动查，需手工看页面',
    exact: false,
  },
  NO_MODID_BLIND: {
    label: 'mod 没有 Nexus modId，从未参与审计',
    action: '补齐 meta.ini 的 modid 才能覆盖',
    exact: false,
  },
  OTHER: {
    label: '其它未归类原因',
    action: '人工看',
    exact: false,
  },
};

const REASON_GROUP = {
  MO2_SIGNAL_WITH_NEWER_UNVERIFIED_FILE: 'SUSPECT_UPDATE',
  WEAK_UPDATE_EVIDENCE_DEFERRED: 'WEAK_DEFERRED',
  MULTIPLE_NEWER_COMPATIBLE_FILES: 'AMBIGUOUS',
  NEXUS_UPDATE_CHAIN_VARIANT_CONFLICT: 'VARIANT_CONFLICT',
  TARGET_REQUIRES_NEWER_RUNTIME: 'RUNTIME_BLOCK',
  TARGET_EDITION_MISMATCH: 'EDITION_BLOCK',
  LOCAL_FILE_IDENTITY_UNRESOLVED: 'IDENTITY',
  LOCAL_INSTALLED_VERSION_CONTRADICTION: 'IDENTITY',
  LOCAL_MULTI_VERSION_IDENTITY: 'IDENTITY',
  LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT: 'SAME_VERSION_CONFLICT',
  LOCAL_VERSION_NEWER_THAN_TARGET: 'LOCAL_NEWER',
  SAME_VERSION_NEWER_FILE_REPLACEMENT: 'SAME_VERSION_REPLACEMENT',
  HIGH_CONFIDENCE_METADATA_DRIFT_UP_TO_DATE: 'METADATA_DRIFT',
  MO2_SIGNAL_WITHOUT_NEWER_EXACT_OR_COMPATIBLE_FILE: 'DISMISSED_SIGNAL',
  API_ERROR: 'API_BLIND',
};

function shortName(name) {
  return String(name || '').split(' — ')[0].trim();
}

function itemOf(row) {
  const ue = row.updateEligibility || {};
  const target = ue.target || null;
  return {
    modId: String(row.modId || ''),
    name: shortName(row.name || row.localName || ''),
    localFileId: String(row.localFileId || ''),
    installedVersion: row.installedVersion || '',
    targetFileId: target ? String(target.fileId || '') : '',
    targetVersion: target ? String(target.version || '') : '',
    reason: ue.reason || row.reason || '',
    action: row.action || '',
  };
}

function groupFor(row) {
  const ue = row.updateEligibility || {};
  if (row.action === 'HOLD_COMPONENT_DISCOVERY') return 'COMPONENT';
  if (ue.reason && REASON_GROUP[ue.reason]) return REASON_GROUP[ue.reason];
  if (row.action === 'HOLD_API_ERROR') return 'API_BLIND';
  if (row.action === 'SKIP_METADATA_FALSE_POSITIVE') return 'DISMISSED_SIGNAL';
  return 'OTHER';
}

function buildProblemReport({ plan, unscanned = [], runDir = '' }) {
  const rows = plan.rows || plan.items || [];
  const groups = {};
  for (const key of Object.keys(GROUPS)) {
    groups[key] = { ...GROUPS[key], key, count: 0, items: [] };
  }
  let inPlan = 0;
  for (const row of rows) {
    const ue = row.updateEligibility || {};
    // Rows that are simply up to date / ignored are not problems.
    if (row.action === 'SKIP_UP_TO_DATE' && !ue.reason) continue;
    if (ue.reason === 'NO_NEWER_EXACT_OR_COMPATIBLE_FILE') continue;
    if (ue.reason === 'MO2_IGNORED_VERSION_MATCHES_TARGET') continue;
    if (row.action === 'DOWNLOAD' || ue.status === 'UPDATE_CONFIRMED') {
      inPlan++;
      continue;
    }
    const key = groupFor(row);
    const g = groups[key];
    g.count++;
    if (g.items.length < 12) g.items.push(itemOf(row));
  }
  groups.NO_MODID_BLIND.count = unscanned.length;
  groups.NO_MODID_BLIND.items = unscanned.slice(0, 12).map((line) => ({ raw: String(line).slice(0, 120) }));

  const totals = {
    rows: rows.length,
    autoDownload: inPlan,
    problems: Object.values(groups).reduce((n, g) => n + g.count, 0),
    exactTargets: Object.values(groups)
      .filter((g) => g.exact)
      .reduce((n, g) => n + g.count, 0),
  };
  return { version: 1, generatedAt: new Date().toISOString(), runDir, totals, groups };
}

function latestRunDir(explicit) {
  if (explicit) return path.resolve(explicit);
  const latest = findLatestRun(rootDir);
  if (!latest) throw new Error('找不到任何 run 目录，先跑 npm run audit');
  return latest;
}

function main() {
  const runDir = latestRunDir(argValue(process.argv, '--run', ''));
  const plan = loadJson(path.join(runDir, 'plan.json'), null);
  if (!plan) throw new Error('run 目录里没有 plan.json: ' + runDir);
  const unscannedFile = path.join(runDir, 'unscanned-mods.tsv');
  const unscanned = fs.existsSync(unscannedFile)
    ? fs.readFileSync(unscannedFile, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const report = buildProblemReport({ plan, unscanned, runDir });
  const outFile = argValue(process.argv, '--out', '');
  if (outFile) saveJson(outFile, report);

  console.log('Problem sweep | ' + path.basename(runDir));
  console.log(`rows=${report.totals.rows} auto=${report.totals.autoDownload} problems=${report.totals.problems} exactTargets=${report.totals.exactTargets}`);
  for (const g of Object.values(report.groups)) {
    if (!g.count) continue;
    console.log(`\n[${g.key}] ${g.count} — ${g.label}`);
    console.log(`  action: ${g.action}`);
    for (const it of g.items.slice(0, 8)) {
      if (it.raw) { console.log('   · ' + it.raw); continue; }
      const tgt = it.targetFileId ? ` -> ${it.targetVersion || '?'} (file ${it.targetFileId})` : '';
      console.log(`   · ${it.modId} ${it.name.slice(0, 42)} | local ${it.installedVersion || '?'}${tgt}`);
    }
    if (g.count > 8) console.log(`   … +${g.count - 8} more`);
  }
  if (outFile) console.log('\nJSON: ' + path.resolve(outFile));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('audit-problems failed: ' + err.message);
    process.exit(1);
  }
}

module.exports = { GROUPS, REASON_GROUP, buildProblemReport, groupFor, itemOf, shortName, latestRunDir };
