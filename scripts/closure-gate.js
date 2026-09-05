#!/usr/bin/env node
'use strict';

// Main -> Patch families -> Translation closure gate.
// v3.6 adds a strict discovery invariant: if reverse Requirements/description coverage is incomplete,
// or any discovered patch candidate is unresolved, MAIN cannot be released.

const fs = require('fs');
const path = require('path');
const { parseRegistry, findRules, isFresh } = require('./lib/aux-registry');

function argValue(name, fallback = '') { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
function parseManifest(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(line => {
    const [modId, name, ver, note, fileId, action] = line.split('\t').map(x => (x || '').trim());
    return { modId, name, ver, note, fileId, action: action || 'HOLD_REVIEW' };
  });
}
function key(modId, fileId) { return `${String(modId)}:${String(fileId)}`; }
function lineOf(r) { return [r.modId, r.name, r.ver, r.note, r.fileId, r.action].join('\t'); }
function loadJson(file, fallback) { if (!file || !fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
function planMap(plan) {
  const map = new Map();
  for (const item of plan?.items || []) { const fid = item.latestFileId || item.fileId || ''; if (item.modId && fid) map.set(key(item.modId, fid), item); }
  return map;
}
function discoveryMap(discovery) {
  const map = new Map();
  for (const item of discovery?.items || []) if (item.modId && item.mainFileId) map.set(key(item.modId, item.mainFileId), item);
  return map;
}
function evidenceCandidates(planItem, kind) {
  if (!planItem?.aux) return [];
  return kind === 'PATCH' ? (planItem.aux.patches || []) : (planItem.aux.translations || []);
}

function main() {
  const manifest = process.argv[2];
  const registryFile = process.argv[3] || path.resolve(__dirname, '..', 'config', 'aux-registry.tsv');
  const outFile = argValue('--out');
  const reportFile = argValue('--report');
  const planFile = argValue('--plan');
  const auditFile = argValue('--registry-audit');
  const discoveryFile = argValue('--patch-discovery');
  const maxAgeDays = Number(argValue('--max-age-days', '14')) || 14;
  const allowLegacy = process.argv.includes('--allow-legacy-registry');
  if (!manifest || !outFile) {
    console.error('Usage: node closure-gate.js <manifest.tsv> [registry.tsv] --out final.tsv [--plan plan.json] [--patch-discovery patch-discovery.json] [--registry-audit audit.json]');
    process.exit(2);
  }

  const rows = parseManifest(manifest);
  const rules = parseRegistry(registryFile);
  const plan = loadJson(planFile, { items: [] });
  const audit = loadJson(auditFile, { rules: {} });
  const discovery = loadJson(discoveryFile, { items: [] });
  const plans = planMap(plan);
  const discoveries = discoveryMap(discovery);
  const requireAudit = !!auditFile;
  const requireDiscovery = !!discoveryFile;

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
    const tx = key(row.modId, row.fileId);
    const p = plans.get(tx) || null;
    const pd = discoveries.get(tx) || null;
    const relevant = findRules(rules, { mainModId: row.modId, mainFileId: row.fileId, mainVersion: row.ver });
    const selfAux = relevant.some(r => r.kind === 'SELF' && r.status === 'AUX');
    if (selfAux) {
      const released = { ...row, action: 'DOWNLOAD', note: `${row.note || ''}; tx=${tx}; closure=AUX_EXEMPT`.replace(/^;\s*/, '') };
      finalRows.push(released);
      report.push({ modId: row.modId, fileId: row.fileId, originalAction, action: 'DOWNLOAD', closure: 'AUX_EXEMPT', tx });
      continue;
    }

    // v3.6: patch discovery is an independent hard gate before registry closure.
    const patchDiscoveryFailures = [];
    if (requireDiscovery) {
      if (!pd) patchDiscoveryFailures.push('missing-discovery-record');
      else {
        for (const x of pd.coverageProblems || []) patchDiscoveryFailures.push(`coverage:${x.source}:${x.status}`);
        for (const c of pd.unresolved || []) patchDiscoveryFailures.push(`unresolved:${c.family || 'GENERAL'}:${c.key || c.auxModId || c.fileId || c.name}`);
        if (!pd.complete && !patchDiscoveryFailures.length) patchDiscoveryFailures.push('discovery-not-complete');
      }
    }
    if (patchDiscoveryFailures.length) {
      const held = {
        ...row,
        action: 'HOLD_PATCH_DISCOVERY',
        note: `${row.note || ''}; tx=${tx}; patch discovery incomplete: ${patchDiscoveryFailures.slice(0, 12).join(',')}`.replace(/^;\s*/, ''),
      };
      finalRows.push(held);
      report.push({
        modId: row.modId, fileId: row.fileId, originalAction, action: held.action, tx,
        closure: 'FAILED', patchDiscovery: pd || null, patchDiscoveryFailures,
      });
      continue;
    }

    const missingKinds = [];
    const invalidRules = [];
    const conflicts = [];
    const staleRules = [];
    const required = [];

    for (const kind of ['PATCH', 'TRANSLATION']) {
      const kindRules = relevant.filter(r => r.kind === kind);
      const discoveryProvesNoPatch = kind === 'PATCH' && requireDiscovery && pd?.complete && (pd.candidateCount || 0) === 0;
      if (!kindRules.length) {
        if (!discoveryProvesNoPatch) missingKinds.push(kind);
        continue;
      }

      const statuses = new Set(kindRules.map(r => r.status));
      if (statuses.has('NONE') && statuses.has('REQUIRED')) conflicts.push(`${kind}:NONE+REQUIRED`);
      const candidates = evidenceCandidates(p, kind);
      if (!requireDiscovery && candidates.length && kindRules.every(r => r.status === 'NONE')) conflicts.push(`${kind}:scanner-found-${candidates.length}-candidate(s)-but-registry=NONE`);
      if (kind === 'PATCH' && requireDiscovery && (pd?.candidateCount || 0) > 0 && statuses.has('NONE')) conflicts.push('PATCH:blanket-NONE-not-allowed-when-discovery-has-candidates');

      for (const rule of kindRules) {
        if (!allowLegacy && rule.schema < 2) { invalidRules.push(`${kind}:legacy-v1-rule:${rule.id}`); continue; }
        if (!allowLegacy && (!rule.mainFileId || rule.mainFileId === '*')) { invalidRules.push(`${kind}:rule-not-bound-to-mainFileId:${rule.id}`); continue; }
        const fresh = isFresh(rule, maxAgeDays);
        if (!fresh.fresh) { staleRules.push(`${kind}:${rule.id}:${fresh.reason}`); continue; }

        if (rule.status === 'NONE') {
          if (!rule.evidence || /^legacy/i.test(rule.evidence)) invalidRules.push(`${kind}:NONE-without-evidence:${rule.id}`);
          continue;
        }

        if (kind === 'PATCH' && ['NOT_APPLICABLE', 'ALREADY_INCLUDED', 'OBSOLETE'].includes(rule.status)) {
          if (rule.schema < 3 || !rule.family) invalidRules.push(`PATCH:${rule.status}-requires-v3-family:${rule.id}`);
          if (!rule.evidence) invalidRules.push(`PATCH:${rule.status}-without-evidence:${rule.id}`);
          continue;
        }

        if (rule.status !== 'REQUIRED') { invalidRules.push(`${kind}:bad-status:${rule.status}:${rule.id}`); continue; }
        if (kind === 'PATCH' && rule.schema >= 3 && !rule.family) { invalidRules.push(`PATCH:REQUIRED-missing-family:${rule.id}`); continue; }
        if (!rule.auxModId || !rule.auxFileId || !rule.auxVersion || !rule.auxName) { invalidRules.push(`${kind}:missing-exact-aux-fields:${rule.id}`); continue; }
        if (requireAudit) {
          const ar = audit?.rules?.[rule.id];
          if (!ar || ar.status !== 'PASS') { invalidRules.push(`${kind}:registry-audit-${ar?.status || 'MISSING'}:${rule.id}`); continue; }
        }
        required.push(rule);
      }
    }

    if (missingKinds.length || invalidRules.length || conflicts.length || staleRules.length) {
      const reasons = [];
      if (missingKinds.length) reasons.push(`missing:${missingKinds.join('+')}`);
      if (conflicts.length) reasons.push(`conflict:${conflicts.join(',')}`);
      if (staleRules.length) reasons.push(`stale:${staleRules.join(',')}`);
      if (invalidRules.length) reasons.push(`invalid:${invalidRules.join(',')}`);
      const held = { ...row, action: conflicts.length ? 'HOLD_CLOSURE_CONFLICT' : 'HOLD_CLOSURE', note: `${row.note || ''}; tx=${tx}; ${reasons.join('; ')}`.replace(/^;\s*/, '') };
      finalRows.push(held);
      report.push({ modId: row.modId, fileId: row.fileId, originalAction, action: held.action, tx, closure: 'FAILED', missingKinds, invalidRules, conflicts, staleRules, scannerEvidence: p?.aux || null, patchDiscovery: pd || null });
      continue;
    }

    const released = { ...row, action: 'DOWNLOAD', note: `${row.note || ''}; tx=${tx}; closure=PASS; patchDiscovery=${requireDiscovery ? 'PASS' : 'LEGACY'}`.replace(/^;\s*/, '') };
    finalRows.push(released);
    for (const rule of required) {
      const k = key(rule.auxModId, rule.auxFileId);
      if (known.has(k)) continue;
      const aux = { modId: rule.auxModId, name: rule.auxName, ver: rule.auxVersion, note: `tx=${tx}; closure:${rule.kind}${rule.family ? `:${rule.family}` : ''} for ${row.modId}:${row.fileId} v${row.ver}${rule.note ? `; ${rule.note}` : ''}`, fileId: rule.auxFileId, action: 'DOWNLOAD' };
      finalRows.push(aux); appended.push(aux); known.add(k);
    }
    report.push({ modId: row.modId, fileId: row.fileId, originalAction, action: 'DOWNLOAD', tx, closure: 'PASS', patchDiscovery: pd || null, requiredAux: required.map(r => ({ id: r.id, kind: r.kind, family: r.family || '', modId: r.auxModId, fileId: r.auxFileId, version: r.auxVersion, name: r.auxName })) });
  }

  fs.writeFileSync(outFile, finalRows.map(lineOf).join('\n') + '\n', 'utf8');
  const payload = { generatedAt: new Date().toISOString(), registry: registryFile, plan: planFile || null, patchDiscovery: discoveryFile || null, registryAudit: auditFile || null, maxAgeDays, allowLegacy, totalInput: rows.length, totalOutput: finalRows.length, appendedAux: appended.length, holdClosure: finalRows.filter(r => /^HOLD_(?:CLOSURE|PATCH_DISCOVERY)/.test(r.action)).length, items: report };
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
