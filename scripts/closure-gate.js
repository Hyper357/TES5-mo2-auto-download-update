#!/usr/bin/env node
'use strict';

// Main -> required component families -> Translation closure gate.
// v3.9 phase 2 generalizes the old Patch-only discovery invariant to all explicit component candidates.

const fs = require('fs');
const path = require('path');
const { parseRegistry, findRules, isFresh } = require('./lib/aux-registry');
const { COMPONENT_KINDS } = require('./lib/component-discovery');

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
  for (const item of plan?.items || []) {
    const fid = item.latestFileId || item.fileId || '';
    if (item.modId && fid) map.set(key(item.modId, fid), item);
  }
  return map;
}
function discoveryMap(discovery) {
  const map = new Map();
  for (const item of discovery?.items || []) if (item.modId && item.mainFileId) map.set(key(item.modId, item.mainFileId), item);
  return map;
}
function evidenceCandidates(planItem, kind) {
  if (!planItem?.aux) return [];
  if (kind === 'PATCH') return planItem.aux.patches || [];
  if (kind === 'TRANSLATION') return planItem.aux.translations || [];
  return (planItem.aux.components || []).filter(x => String(x.kind || '').toUpperCase() === kind);
}
function candidateCountsByKind(pd) {
  if (pd?.candidateCountsByKind) return pd.candidateCountsByKind;
  const out = {};
  for (const c of pd?.candidates || []) {
    const k = String(c.kind || 'PATCH').toUpperCase();
    out[k] = (out[k] || 0) + 1;
  }
  if (!Object.keys(out).length && Number(pd?.candidateCount || 0) > 0) out.PATCH = Number(pd.candidateCount || 0);
  return out;
}
function rulesByFamily(kindRules) {
  const map = new Map();
  for (const r of kindRules) {
    const family = r.family || '*';
    if (!map.has(family)) map.set(family, []);
    map.get(family).push(r);
  }
  return map;
}

function main() {
  const manifest = process.argv[2];
  const registryFile = process.argv[3] || path.resolve(__dirname, '..', 'config', 'aux-registry.tsv');
  const outFile = argValue('--out');
  const reportFile = argValue('--report');
  const planFile = argValue('--plan');
  const auditFile = argValue('--registry-audit');
  // Keep the old flag name for CLI compatibility; content may now be generalized component discovery.
  const discoveryFile = argValue('--component-discovery', argValue('--patch-discovery'));
  const maxAgeDays = Number(argValue('--max-age-days', '14')) || 14;
  const allowLegacy = process.argv.includes('--allow-legacy-registry');
  if (!manifest || !outFile) {
    console.error('Usage: node closure-gate.js <manifest.tsv> [registry.tsv] --out final.tsv [--plan plan.json] [--component-discovery discovery.json] [--registry-audit audit.json]');
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
  const closureEligible = new Set(['DOWNLOAD', 'HOLD_PATCH', 'HOLD_TRANSLATION', 'HOLD_COMPONENT']);

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

    const discoveryFailures = [];
    if (requireDiscovery) {
      if (!pd) discoveryFailures.push('missing-discovery-record');
      else {
        for (const x of pd.coverageProblems || []) discoveryFailures.push(`coverage:${x.source}:${x.status}`);
        for (const c of pd.unresolved || []) discoveryFailures.push(`unresolved:${c.kind || 'PATCH'}:${c.family || 'GENERAL'}:${c.key || c.auxModId || c.fileId || c.name}`);
        if (!pd.complete && !discoveryFailures.length) discoveryFailures.push('discovery-not-complete');
      }
    }
    if (discoveryFailures.length) {
      const held = {
        ...row,
        action: 'HOLD_COMPONENT_DISCOVERY',
        note: `${row.note || ''}; tx=${tx}; component discovery incomplete: ${discoveryFailures.slice(0, 16).join(',')}`.replace(/^;\s*/, ''),
      };
      finalRows.push(held);
      report.push({
        modId: row.modId,
        fileId: row.fileId,
        originalAction,
        action: held.action,
        tx,
        closure: 'FAILED',
        componentDiscovery: pd || null,
        patchDiscovery: pd || null,
        componentDiscoveryFailures: discoveryFailures,
        patchDiscoveryFailures: discoveryFailures,
      });
      continue;
    }

    const missingKinds = [];
    const invalidRules = [];
    const conflicts = [];
    const staleRules = [];
    const required = [];
    const counts = candidateCountsByKind(pd);

    // Translation remains an explicit baseline decision because independent translation pages cannot always be proven by the Files API alone.
    const kindsToCheck = new Set(['TRANSLATION']);
    for (const kind of COMPONENT_KINDS) if ((counts[kind] || 0) > 0) kindsToCheck.add(kind);
    for (const r of relevant) if (COMPONENT_KINDS.includes(r.kind)) kindsToCheck.add(r.kind);

    for (const kind of kindsToCheck) {
      const kindRules = relevant.filter(r => r.kind === kind);
      const candidateCount = Number(counts[kind] || 0);
      const discoveryProvesEmpty = requireDiscovery && pd?.complete && candidateCount === 0;
      if (!kindRules.length) {
        if (kind === 'TRANSLATION' || !discoveryProvesEmpty) missingKinds.push(kind);
        continue;
      }

      const statuses = new Set(kindRules.map(r => r.status));
      if (statuses.has('NONE') && statuses.has('REQUIRED')) conflicts.push(`${kind}:NONE+REQUIRED`);
      if (candidateCount > 0 && statuses.has('NONE')) conflicts.push(`${kind}:blanket-NONE-not-allowed-when-discovery-has-candidates`);
      const scannerCandidates = evidenceCandidates(p, kind);
      if (!requireDiscovery && scannerCandidates.length && kindRules.every(r => r.status === 'NONE')) conflicts.push(`${kind}:scanner-found-${scannerCandidates.length}-candidate(s)-but-registry=NONE`);

      for (const [family, familyRules] of rulesByFamily(kindRules)) {
        const resolvedStatuses = [...new Set(familyRules.map(r => r.status).filter(x => ['REQUIRED','NOT_APPLICABLE','ALREADY_INCLUDED','OBSOLETE'].includes(x)))];
        if (resolvedStatuses.length > 1) conflicts.push(`${kind}:${family}:multiple-decisions=${resolvedStatuses.join('+')}`);
      }

      for (const rule of kindRules) {
        if (!allowLegacy && rule.schema < 2) { invalidRules.push(`${kind}:legacy-v1-rule:${rule.id}`); continue; }
        if (!allowLegacy && (!rule.mainFileId || rule.mainFileId === '*')) { invalidRules.push(`${kind}:rule-not-bound-to-mainFileId:${rule.id}`); continue; }
        const fresh = isFresh(rule, maxAgeDays);
        if (!fresh.fresh) { staleRules.push(`${kind}:${rule.id}:${fresh.reason}`); continue; }

        if (rule.status === 'NONE') {
          if (candidateCount > 0) invalidRules.push(`${kind}:NONE-with-discovered-candidates:${rule.id}`);
          if (!rule.evidence || /^legacy/i.test(rule.evidence)) invalidRules.push(`${kind}:NONE-without-evidence:${rule.id}`);
          continue;
        }

        if (['NOT_APPLICABLE', 'ALREADY_INCLUDED', 'OBSOLETE'].includes(rule.status)) {
          if (kind !== 'TRANSLATION' && (rule.schema < 3 || !rule.family)) invalidRules.push(`${kind}:${rule.status}-requires-v3-family:${rule.id}`);
          if (!rule.evidence) invalidRules.push(`${kind}:${rule.status}-without-evidence:${rule.id}`);
          continue;
        }

        if (rule.status !== 'REQUIRED') { invalidRules.push(`${kind}:bad-status:${rule.status}:${rule.id}`); continue; }
        if (kind !== 'TRANSLATION' && rule.schema >= 3 && !rule.family) { invalidRules.push(`${kind}:REQUIRED-missing-family:${rule.id}`); continue; }
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
      const held = {
        ...row,
        action: conflicts.length ? 'HOLD_CLOSURE_CONFLICT' : 'HOLD_COMPONENT_CLOSURE',
        note: `${row.note || ''}; tx=${tx}; ${reasons.join('; ')}`.replace(/^;\s*/, ''),
      };
      finalRows.push(held);
      report.push({
        modId: row.modId,
        fileId: row.fileId,
        originalAction,
        action: held.action,
        tx,
        closure: 'FAILED',
        missingKinds,
        invalidRules,
        conflicts,
        staleRules,
        scannerEvidence: p?.aux || null,
        componentDiscovery: pd || null,
        patchDiscovery: pd || null,
      });
      continue;
    }

    const released = {
      ...row,
      action: 'DOWNLOAD',
      note: `${row.note || ''}; tx=${tx}; closure=PASS; componentDiscovery=${requireDiscovery ? 'PASS' : 'LEGACY'}`.replace(/^;\s*/, ''),
    };
    finalRows.push(released);
    for (const rule of required) {
      const k = key(rule.auxModId, rule.auxFileId);
      if (known.has(k)) continue;
      const aux = {
        modId: rule.auxModId,
        name: rule.auxName,
        ver: rule.auxVersion,
        note: `tx=${tx}; closure:${rule.kind}${rule.family ? `:${rule.family}` : ''} for ${row.modId}:${row.fileId} v${row.ver}${rule.note ? `; ${rule.note}` : ''}`,
        fileId: rule.auxFileId,
        action: 'DOWNLOAD',
      };
      finalRows.push(aux);
      appended.push(aux);
      known.add(k);
    }
    report.push({
      modId: row.modId,
      fileId: row.fileId,
      originalAction,
      action: 'DOWNLOAD',
      tx,
      closure: 'PASS',
      componentDiscovery: pd || null,
      patchDiscovery: pd || null,
      requiredAux: required.map(r => ({ id: r.id, kind: r.kind, family: r.family || '', modId: r.auxModId, fileId: r.auxFileId, version: r.auxVersion, name: r.auxName })),
    });
  }

  fs.writeFileSync(outFile, finalRows.map(lineOf).join('\n') + '\n', 'utf8');
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: 'COMPONENT_CLOSURE',
    componentKinds: COMPONENT_KINDS,
    registry: registryFile,
    plan: planFile || null,
    componentDiscovery: discoveryFile || null,
    patchDiscovery: discoveryFile || null,
    registryAudit: auditFile || null,
    maxAgeDays,
    allowLegacy,
    totalInput: rows.length,
    totalOutput: finalRows.length,
    appendedAux: appended.length,
    appendedByKind: appended.reduce((acc, r) => {
      const m = String(r.note || '').match(/closure:([A-Z_]+)/i);
      const k = m ? m[1].toUpperCase() : 'UNKNOWN';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    holdClosure: finalRows.filter(r => /^HOLD_(?:COMPONENT|CLOSURE|PATCH_DISCOVERY)/.test(r.action)).length,
    items: report,
  };
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
