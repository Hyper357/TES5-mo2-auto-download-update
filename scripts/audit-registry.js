#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseRegistry } = require('./lib/aux-registry');
const { normalizeVer } = require('./lib/semver');
const { argValue, hasFlag } = require('./lib/cli');
const { saveJson } = require('./lib/fs-json');
const { readApiKey, createFilesClient } = require('./lib/nexus-api');

const registryFile = process.argv[2];
const keyFile = process.argv[3];
const outFile = argValue(process.argv, '--out');
const forceRefresh = hasFlag(process.argv, '--force-refresh');
const api = createFilesClient({
  cacheDir: path.join(__dirname, '.registry_cache'),
  forceRefresh,
  maxSockets: 8,
});

async function main() {
  if (!registryFile) {
    console.error('用法: node audit-registry.js <registry.tsv> [apiKeyFile] --out audit.json [--force-refresh]');
    process.exit(2);
  }
  const apiKey = readApiKey(keyFile);
  if (!apiKey) throw new Error('缺少 Nexus API key');

  const rules = parseRegistry(registryFile);
  const required = rules.filter(r => r.status === 'REQUIRED');
  const byMod = new Map();
  for (const r of required) {
    if (!r.auxModId) continue;
    if (!byMod.has(r.auxModId)) byMod.set(r.auxModId, []);
    byMod.get(r.auxModId).push(r);
  }

  const audit = {};
  for (const r of rules) {
    if (r.status === 'NONE') audit[r.id] = { status: 'PASS_NONE' };
    else if (r.kind === 'SELF' && r.status === 'AUX') audit[r.id] = { status: 'PASS_AUX_EXEMPT' };
  }

  const entries = [...byMod.entries()];
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const [modId, modRules] = entries[cursor++];
      let data;
      try { data = await api.getFiles(modId, apiKey); }
      catch (e) {
        for (const r of modRules) audit[r.id] = { status: 'API_ERROR', error: e.message };
        continue;
      }
      const files = Array.isArray(data.files) ? data.files : [];
      for (const r of modRules) {
        if (!r.auxFileId || !r.auxVersion || !r.auxName) {
          audit[r.id] = { status: 'INVALID_RULE', reason: 'missing-exact-aux-fields' };
          continue;
        }
        const file = files.find(f => String(f.file_id) === String(r.auxFileId));
        if (!file) {
          audit[r.id] = { status: 'FILE_NOT_FOUND', auxModId: r.auxModId, auxFileId: r.auxFileId };
          continue;
        }
        if ([4, 7].includes(Number(file.category_id))) {
          audit[r.id] = { status: 'RETIRED', categoryId: file.category_id, category: file.category_name || '' };
          continue;
        }
        const expected = normalizeVer(r.auxVersion);
        const actual = normalizeVer(file.version || '');
        if (expected && actual && expected !== actual) {
          audit[r.id] = { status: 'VERSION_MISMATCH', expected: r.auxVersion, actual: file.version || '' };
          continue;
        }
        audit[r.id] = {
          status: 'PASS',
          auxModId: r.auxModId,
          auxFileId: String(file.file_id),
          version: file.version || '',
          name: file.name || '',
          categoryId: file.category_id,
          category: file.category_name || '',
          uploadedTime: file.uploaded_time || '',
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, entries.length)) }, () => worker()));
  const counts = {};
  for (const value of Object.values(audit)) counts[value.status] = (counts[value.status] || 0) + 1;
  const payload = { generatedAt: new Date().toISOString(), registry: registryFile, counts, rules: audit };
  if (outFile) saveJson(outFile, payload, { atomic: false });
  console.log(JSON.stringify(payload, null, 2));
}

main().catch(err => {
  console.error(`registry audit failed: ${err.message}`);
  process.exit(1);
});
