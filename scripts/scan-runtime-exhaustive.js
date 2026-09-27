#!/usr/bin/env node
// 穷尽式 runtime 兼容性扫描：对全部有 Nexus modid 的 mod，读取其所有
// Nexus 文件的描述（本地缓存，零 API 成本），提取 runtime/SKSE 版本要求，
// 找出与本地环境（1.6.1170 / SKSE 2.2.6）冲突的文件。
//
// 用法: node scripts/scan-runtime-exhaustive.js [--out <report.tsv>] [--md <report.md>]

'use strict';

const fs = require('fs');
const path = require('path');
const { scanModsDirectory } = require('./lib/mo2-reader');
const { createFilesClient } = require('./lib/nexus-api');
const { parseRequiredRuntimes, runtimeCompatRejects, defaultLocalRuntime } = require('./lib/runtime-compat');

const modsDir = 'E:/SkyrimAE/mo2/mods';
const cacheDir = path.join(__dirname, '.api_cache');
const LOCAL = defaultLocalRuntime();

function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function cleanDesc(d) {
  return String(d || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function scanFile(mod, f, role) {
  const desc = cleanDesc(f.description);
  if (!desc) return [];
  const out = [];
  // runtime 要求（描述为准）
  for (const r of runtimeCompatRejects(desc)) {
    out.push({
      modId: mod.modId, modName: mod.folderName, fileId: f.file_id, fileVersion: String(f.version || ''),
      role, kind: r.reason, required: r.required, local: r.local, evidence: r.evidence || '',
      quote: r.quote || desc.slice(0, 120),
    });
  }
  // SKSE 要求（同样只信描述；runtimeCompatRejects 已含 SKSE，这里补充独立列出）
  const p = parseRequiredRuntimes(desc);
  const minSkse = p.skseVersions.length ? p.skseVersions.reduce((a, b) => (parseFloat(b) > parseFloat(a) ? a : b)) : null;
  void minSkse; // SKSE 拒绝已由 runtimeCompatRejects 输出
  return out;
}

async function main() {
  const mods = scanModsDirectory(modsDir);
  const byId = new Map();
  for (const m of mods) if (!byId.has(String(m.modId))) byId.set(String(m.modId), m);

  const client = createFilesClient({ cacheDir, ttlMs: 6 * 3600 * 1000, forceRefresh: false, game: 'skyrimspecialedition' });
  const rows = [];
  let noCache = 0;
  let scanned = 0;

  for (const [modId, mod] of byId) {
    const cacheFile = path.join(cacheDir, `${modId}.json`);
    if (!fs.existsSync(cacheFile)) { noCache++; continue; }
    let data;
    try { data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { noCache++; continue; }
    const files = Array.isArray(data.files) ? data.files : [];
    const installed = new Set((mod.installedFiles || []).map(String));
    // 最新活跃文件 = category_id 在活跃集内的 uploaded_time 最大者
    const active = files.filter(f => [1, 2, 3, 5].includes(Number(f.category_id)));
    let latestId = null;
    if (active.length) {
      latestId = active.reduce((a, b) => (new Date(b.uploaded_time || 0) > new Date(a.uploaded_time || 0) ? b : a)).file_id;
    }
    scanned++;
    for (const f of files) {
      const role = installed.has(String(f.file_id)) ? 'INSTALLED' : (String(f.file_id) === String(latestId) ? 'LATEST' : 'OTHER');
      rows.push(...scanFile(mod, f, role));
    }
  }

  // 只保留有行动意义的：INSTALLED（当前可能在踩坑）与 LATEST（更新会踩坑）
  const action = rows.filter(r => r.role === 'INSTALLED' || r.role === 'LATEST');
  const byKind = {};
  for (const r of action) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

  console.error(`扫描 mod=${byId.size} 有缓存=${scanned} 无缓存=${noCache}`);
  console.error(`描述含版本要求的文件行=${rows.length}，其中 INSTALLED/LATEST=${action.length}`);
  console.error(`分类: ${JSON.stringify(byKind)}`);

  const outFile = argValue('--out', path.join(__dirname, '..', '.runtime', 'runtime-exhaustive.tsv'));
  const lines = ['modId\tmodName\trole\tkind\trequired\tlocal\tfileId\tfileVersion\tevidence\tquote'];
  for (const r of action) {
    lines.push([r.modId, String(r.modName || '').replace(/\t/g, ' '), r.role, r.kind, r.required, r.local, r.fileId, String(r.fileVersion || ''), r.evidence, String(r.quote || '').replace(/\t/g, ' ')].join('\t'));
  }
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.error(`报告: ${outFile}`);

  // markdown 摘要
  const mdFile = argValue('--md', '');
  if (mdFile) {
    const md = ['# 穷尽式 Runtime 扫描报告', '', `- 环境: Skyrim ${LOCAL.runtime} / SKSE ${LOCAL.skse}`, `- 扫描范围: ${byId.size} 个 mod（有缓存 ${scanned}），全部文件描述`, `- 命中: INSTALLED/LATEST 共 ${action.length} 条`, ''];
    const groups = {};
    for (const r of action) (groups[`${r.role}|${r.kind}`] = groups[`${r.role}|${r.kind}`] || []).push(r);
    for (const key of Object.keys(groups).sort()) {
      md.push(`## ${key}`, '', '| MOD | 目标版本 | 要求 | 原文 |', '|---|---|---|---|');
      for (const r of groups[key]) md.push(`| ${r.modName.slice(0, 44)} | ${r.fileVersion} | ${r.required} | ${String(r.quote).slice(0, 100)} |`);
      md.push('');
    }
    fs.writeFileSync(mdFile, md.join('\n'), 'utf8');
    console.error(`摘要: ${mdFile}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
