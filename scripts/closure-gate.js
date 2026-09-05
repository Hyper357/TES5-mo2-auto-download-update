#!/usr/bin/env node
'use strict';

// 强制“主 MOD — Patch — 汉化”闭合。
// registry TSV:
// mainModId<TAB>mainVersion<TAB>kind<TAB>status<TAB>auxModId<TAB>auxFileId<TAB>auxVersion<TAB>auxName<TAB>note
// kind: PATCH | TRANSLATION | SELF
// status: NONE | REQUIRED | AUX
// - NONE: 已核验该主版本不需要/不存在该类附属项
// - REQUIRED: 必须下载精确 auxModId + auxFileId（gate 自动追加到最终 manifest）
// - SELF/AUX: 当前 modId 本身就是汉化/补丁/附属页，不再递归要求它自己的闭合

const fs = require('fs');
const path = require('path');
const { normalizeVer } = require('./lib/semver');

function parseManifest(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(line => {
      const [modId, name, ver, note, fileId, action] = line.split('\t').map(x => (x || '').trim());
      return { modId, name, ver, note, fileId, action: action || 'HOLD_REVIEW' };
    });
}

function parseRegistry(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const [mainModId, mainVersion, kind, status, auxModId, auxFileId, auxVersion, auxName, note] = line.split('\t').map(x => (x || '').trim());
    if (!mainModId || !kind || !status) continue;
    rows.push({
      mainModId, mainVersion: mainVersion || '*', kind: kind.toUpperCase(), status: status.toUpperCase(),
      auxModId, auxFileId, auxVersion, auxName, note,
    });
  }
  return rows;
}

function versionMatches(rule, actual) {
  if (!rule || rule === '*' || /^any$/i.test(rule)) return true;
  return normalizeVer(rule) === normalizeVer(actual);
}

function key(modId, fileId) {
  return `${String(modId)}:${String(fileId)}`;
}

function lineOf(r) {
  return [r.modId, r.name, r.ver, r.note, r.fileId, r.action].join('\t');
}

function main() {
  const manifest = process.argv[2];
  const registry = process.argv[3] || path.resolve(__dirname, '..', 'config', 'aux-registry.tsv');
  const outIdx = process.argv.indexOf('--out');
  const reportIdx = process.argv.indexOf('--report');
  const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  const reportFile = reportIdx >= 0 ? process.argv[reportIdx + 1] : null;

  if (!manifest || !outFile) {
    console.error('用法: node closure-gate.js <manifest.tsv> [registry.tsv] --out <final.tsv> [--report closure.json]');
    process.exit(2);
  }

  const rows = parseManifest(manifest);
  const rules = parseRegistry(registry);
  const finalRows = [];
  const appended = [];
  const report = [];
  const known = new Set(rows.filter(r => r.modId && r.fileId).map(r => key(r.modId, r.fileId)));
  const closureEligible = new Set(['DOWNLOAD', 'HOLD_PATCH', 'HOLD_TRANSLATION']);

  for (const row of rows) {
    if (!closureEligible.has(row.action)) {
      finalRows.push(row);
      report.push({ modId: row.modId, fileId: row.fileId, action: row.action, closure: 'NOT_APPLICABLE' });
      continue;
    }

    const originalAction = row.action;
    const relevant = rules.filter(x => String(x.mainModId) === String(row.modId) && versionMatches(x.mainVersion, row.ver));
    const selfAux = relevant.some(x => x.kind === 'SELF' && x.status === 'AUX');
    if (selfAux) {
      const released = { ...row, action: 'DOWNLOAD', note: `${row.note || ''}; closure=AUX_EXEMPT`.replace(/^;\s*/, '') };
      finalRows.push(released);
      report.push({ modId: row.modId, fileId: row.fileId, originalAction, action: 'DOWNLOAD', closure: 'AUX_EXEMPT' });
      continue;
    }

    const missingKinds = [];
    const invalidRules = [];
    const required = [];

    for (const kind of ['PATCH', 'TRANSLATION']) {
      const kindRules = relevant.filter(x => x.kind === kind);
      if (!kindRules.length) {
        missingKinds.push(kind);
        continue;
      }
      for (const rule of kindRules) {
        if (rule.status === 'NONE') continue;
        if (rule.status !== 'REQUIRED') {
          invalidRules.push(`${kind}:bad-status:${rule.status}`);
          continue;
        }
        if (!rule.auxModId || !rule.auxFileId || !rule.auxVersion || !rule.auxName) {
          invalidRules.push(`${kind}:missing-exact-aux-fields`);
          continue;
        }
        required.push(rule);
      }
    }

    if (missingKinds.length || invalidRules.length) {
      const reasons = [];
      if (missingKinds.length) reasons.push(`未完成附属核验:${missingKinds.join('+')}`);
      if (invalidRules.length) reasons.push(`registry错误:${invalidRules.join(',')}`);
      const held = {
        ...row,
        action: 'HOLD_CLOSURE',
        note: `${row.note || ''}; ${reasons.join('; ')}`.replace(/^;\s*/, ''),
      };
      finalRows.push(held);
      report.push({
        modId: row.modId, fileId: row.fileId, originalAction, action: held.action,
        closure: 'FAILED', missingKinds, invalidRules,
      });
      continue;
    }

    const released = {
      ...row,
      action: 'DOWNLOAD',
      note: `${row.note || ''}; closure=PASS`.replace(/^;\s*/, ''),
    };
    finalRows.push(released);

    for (const rule of required) {
      const k = key(rule.auxModId, rule.auxFileId);
      if (known.has(k)) continue;
      const aux = {
        modId: rule.auxModId,
        name: rule.auxName,
        ver: rule.auxVersion,
        note: `closure:${rule.kind} for ${row.modId} v${row.ver}${rule.note ? `; ${rule.note}` : ''}`,
        fileId: rule.auxFileId,
        action: 'DOWNLOAD',
      };
      finalRows.push(aux);
      appended.push(aux);
      known.add(k);
    }

    report.push({
      modId: row.modId, fileId: row.fileId, originalAction, action: 'DOWNLOAD', closure: 'PASS',
      requiredAux: required.map(x => ({ kind: x.kind, modId: x.auxModId, fileId: x.auxFileId, version: x.auxVersion, name: x.auxName })),
    });
  }

  fs.writeFileSync(outFile, finalRows.map(lineOf).join('\n') + '\n', 'utf8');
  const payload = {
    generatedAt: new Date().toISOString(),
    registry,
    totalInput: rows.length,
    totalOutput: finalRows.length,
    appendedAux: appended.length,
    holdClosure: finalRows.filter(r => r.action === 'HOLD_CLOSURE').length,
    items: report,
  };
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
