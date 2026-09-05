'use strict';

const fs = require('fs');
const { normalizeVer } = require('./semver');

const V2_COLUMNS = [
  'mainModId', 'mainFileId', 'mainVersion', 'kind', 'status',
  'auxModId', 'auxFileId', 'auxVersion', 'auxName',
  'checkedAt', 'evidence', 'note',
];

function clean(v) {
  return String(v || '').trim();
}

function ruleId(rule, index = 0) {
  return [
    rule.mainModId || '?', rule.mainFileId || '*', rule.mainVersion || '*',
    rule.kind || '?', rule.status || '?', rule.auxModId || '-', rule.auxFileId || '-', index,
  ].join(':');
}

function parseRegistryText(text) {
  const rows = [];
  let index = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const parts = line.split('\t').map(clean);
    let row;
    if (parts.length >= V2_COLUMNS.length) {
      row = Object.fromEntries(V2_COLUMNS.map((k, i) => [k, parts[i] || '']));
      row.schema = 2;
    } else {
      // v1 legacy:
      // mainModId mainVersion kind status auxModId auxFileId auxVersion auxName note
      const [mainModId, mainVersion, kind, status, auxModId, auxFileId, auxVersion, auxName, note] = parts;
      row = {
        mainModId, mainFileId: '', mainVersion, kind, status,
        auxModId, auxFileId, auxVersion, auxName,
        checkedAt: '', evidence: 'legacy-v1', note,
        schema: 1,
      };
    }
    row.mainVersion = row.mainVersion || '*';
    row.mainFileId = row.mainFileId || '*';
    row.kind = clean(row.kind).toUpperCase();
    row.status = clean(row.status).toUpperCase();
    row.id = ruleId(row, index++);
    if (row.mainModId && row.kind && row.status) rows.push(row);
  }
  return rows;
}

function parseRegistry(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parseRegistryText(fs.readFileSync(file, 'utf8'));
}

function versionMatches(ruleVersion, actualVersion) {
  const r = clean(ruleVersion);
  if (!r || r === '*' || /^any$/i.test(r)) return true;
  return normalizeVer(r) === normalizeVer(actualVersion);
}

function fileMatches(ruleFileId, actualFileId) {
  const r = clean(ruleFileId);
  return !r || r === '*' || r === String(actualFileId || '');
}

function isFresh(rule, maxAgeDays = 14, now = Date.now()) {
  if (rule.kind === 'SELF' && rule.status === 'AUX') return { fresh: true, ageDays: 0 };
  if (!rule.checkedAt) return { fresh: false, ageDays: Infinity, reason: 'missing-checkedAt' };
  const ts = Date.parse(rule.checkedAt);
  if (!Number.isFinite(ts)) return { fresh: false, ageDays: Infinity, reason: 'invalid-checkedAt' };
  const ageDays = (now - ts) / 86400000;
  if (ageDays < -1) return { fresh: false, ageDays, reason: 'checkedAt-in-future' };
  return { fresh: ageDays <= maxAgeDays, ageDays, reason: ageDays <= maxAgeDays ? 'fresh' : 'stale' };
}

function findRules(rules, { mainModId, mainFileId, mainVersion }) {
  return (rules || []).filter(rule =>
    String(rule.mainModId) === String(mainModId) &&
    fileMatches(rule.mainFileId, mainFileId) &&
    versionMatches(rule.mainVersion, mainVersion)
  );
}

function serializeV2(rule) {
  return V2_COLUMNS.map(k => clean(rule[k])).join('\t');
}

module.exports = {
  V2_COLUMNS,
  ruleId,
  parseRegistryText,
  parseRegistry,
  versionMatches,
  fileMatches,
  isFresh,
  findRules,
  serializeV2,
};
