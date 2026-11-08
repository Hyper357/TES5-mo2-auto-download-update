#!/usr/bin/env node
'use strict';

// Localisation-lag report: which updated main mods have a local Chinese
// translation that may need to follow, and how risky that is.
//
// This window does NOT do localisation. It only hands the other window a
// machine-readable list: updated main mod, old -> new version, version bump
// class, the local translation folder that appears to belong to it, and a
// suggested priority.
//
// Usage:
//   node scripts/audit-localization.js [--run <runDir>] [--out <file.tsv>]
// Default run: the latest one. Updated rows = that run's run.tsv (auto items)
// plus rows whose action is DOWNLOAD in plan.json.

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { findLatestRun } = require('./lib/runtime');

const rootDir = path.resolve(__dirname, '..');
const modsDir = process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';

const TR_NAME = /(汉化|中文|简体|繁体|本地化|CHS|CHT|zh-?cn)/i;

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function productKeys(name) {
  const stop = new Set(['the', 'and', 'for', 'with', 'mod', 'se', 'ae', 'sse', 'chinese', 'chs', 'cn']);
  return norm(String(name || '').split(' — ')[0])
    .split(' ')
    .filter((t) => t.length >= 4 && !stop.has(t));
}

function bumpClass(from, to) {
  const a = String(from || '').match(/\d+(?:\.\d+)*/);
  const b = String(to || '').match(/\d+(?:\.\d+)*/);
  if (!a || !b) return 'UNKNOWN';
  const pa = a[0].split('.').map(Number);
  const pb = b[0].split('.').map(Number);
  if (pa[0] !== pb[0]) return 'MAJOR';
  if ((pa[1] || 0) !== (pb[1] || 0)) return 'MINOR';
  return 'PATCH';
}

function readUpdatedRows(runDir, planRows) {
  const out = new Map();
  const runTsv = path.join(runDir, 'run.tsv');
  if (fs.existsSync(runTsv)) {
    for (const line of fs.readFileSync(runTsv, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [modId, name, ver, , fileId] = line.split('\t');
      out.set(String(modId), { modId: String(modId), name: String(name || ''), targetVersion: String(ver || ''), targetFileId: String(fileId || '') });
    }
  }
  for (const r of planRows) {
    const id = String(r.modId || '');
    if (!id || out.has(id)) continue;
    if (String(r.action || '') !== 'DOWNLOAD') continue;
    const t = (r.updateEligibility || {}).target || {};
    out.set(id, { modId: id, name: String(r.name || ''), targetVersion: String(t.version || ''), targetFileId: String(t.fileId || '') });
  }
  return [...out.values()].map((row) => {
    const plan = planRows.find((r) => String(r.modId) === row.modId) || {};
    return { ...row, installedVersion: String(plan.installedVersion || ''), targetFileId: row.targetFileId || String(((plan.updateEligibility || {}).target || {}).fileId || '') };
  });
}

function readTranslationFolders() {
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && TR_NAME.test(d.name))
    .map((d) => {
      const meta = path.join(modsDir, d.name, 'meta.ini');
      let version = '';
      let modId = '';
      try {
        const text = fs.readFileSync(meta, 'utf8');
        version = (text.match(/^version=(.*)$/m) || [])[1] || '';
        modId = (text.match(/^modid=(.*)$/m) || [])[1] || '';
      } catch (_) { /* folder without meta.ini */ }
      return { folder: d.name, version, modId, keys: productKeys(d.name.replace(new RegExp('\\s*[—-]\\s*' + TR_NAME.source + '.*$', 'i'), '')) };
    });
}

function bestTranslationMatch(updated, translations) {
  const keys = productKeys(updated.name);
  let best = null;
  for (const t of translations) {
    const shared = keys.filter((k) => t.keys.includes(k));
    const score = keys.length ? shared.length / keys.length : 0;
    if (score >= 0.5 && (!best || score > best.score)) best = { ...t, score, shared };
  }
  return best;
}

function main() {
  const explicit = argValue(process.argv, '--run', '');
  const runDir = explicit ? path.resolve(explicit) : findLatestRun(rootDir);
  if (!runDir) throw new Error('NO_RUN_FOUND: run npm run audit first');
  const planFile = path.join(runDir, 'plan.json');
  if (!fs.existsSync(planFile)) throw new Error('PLAN_MISSING: ' + planFile);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const planRows = plan.rows || plan.items || [];
  const updated = readUpdatedRows(runDir, planRows);
  const translations = readTranslationFolders();

  const rows = updated.map((u) => {
    const bump = bumpClass(u.installedVersion, u.targetVersion);
    const match = bestTranslationMatch(u, translations);
    let risk = 'LOW';
    let suggest = '无需汉化（纯插件/材质/动画类，或本地无汉化）';
    if (match) {
      const trStale = !match.version || bumpClass(match.version, u.targetVersion) === 'PATCH' || true;
      risk = bump === 'MAJOR' ? 'HIGH' : 'MEDIUM';
      suggest = bump === 'MAJOR'
        ? '本体大版本跳跃，汉化大概率需要重做/核对 esp 记录'
        : '本体小版本更新，核对汉化是否覆盖新增文本';
      if (!trStale) risk = 'LOW';
    }
    return {
      modId: u.modId,
      name: String(u.name || '').split(' — ')[0].slice(0, 60),
      installedVersion: u.installedVersion,
      targetVersion: u.targetVersion,
      targetFileId: u.targetFileId,
      bump,
      translationFolder: match ? match.folder.slice(0, 70) : '',
      translationModId: match ? match.modId : '',
      translationVersion: match ? match.version : '',
      risk,
      suggest,
    };
  }).sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[a.risk] - { HIGH: 0, MEDIUM: 1, LOW: 2 }[b.risk]));

  const outFile = argValue(process.argv, '--out', path.join(rootDir, '.runtime', 'reports', `localization-lag-${path.basename(runDir)}.tsv`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const header = ['modId', 'name', 'installedVersion', 'targetVersion', 'targetFileId', 'bump', 'translationFolder', 'translationModId', 'translationVersion', 'risk', 'suggest'];
  const tsv = [header.join('\t')].concat(rows.map((r) => header.map((h) => String(r[h]).replace(/[\t\r\n]+/g, ' ')).join('\t'))).join('\n') + '\n';
  fs.writeFileSync(outFile, tsv, 'utf8');

  const count = (risk) => rows.filter((r) => r.risk === risk).length;
  console.log(`run: ${runDir}`);
  console.log(`updated main mods: ${rows.length} | local translation folders: ${translations.length}`);
  console.log(`risk HIGH ${count('HIGH')} / MEDIUM ${count('MEDIUM')} / LOW ${count('LOW')}`);
  console.log(`TSV: ${outFile}`);
  for (const r of rows.filter((x) => x.risk !== 'LOW').slice(0, 15)) {
    console.log(`  [${r.risk}] ${r.modId} ${r.name} ${r.installedVersion}->${r.targetVersion} | 汉化: ${r.translationFolder || '-'}`);
  }
}

if (require.main === module) {
  try { main(); } catch (err) { console.error('audit:localization failed: ' + err.message); process.exit(1); }
}

module.exports = { productKeys, bumpClass, bestTranslationMatch, readTranslationFolders, readUpdatedRows };
