#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parseRegistry } = require('./lib/aux-registry');
const { normalizeVer } = require('./lib/semver');

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const cacheDir = path.join(__dirname, '.registry_cache');
fs.mkdirSync(cacheDir, { recursive: true });

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const registryFile = process.argv[2];
const keyFile = process.argv[3];
const outFile = argValue('--out');
const forceRefresh = process.argv.includes('--force-refresh');

function apiGet(modId, apiKey) {
  const cacheFile = path.join(cacheDir, `${modId}.json`);
  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const st = fs.statSync(cacheFile);
      if (Date.now() - st.mtimeMs < 6 * 3600 * 1000) {
        return Promise.resolve(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
      }
    } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.nexusmods.com',
      path: `/v1/games/skyrimspecialedition/mods/${modId}/files.json`,
      headers: {
        apikey: apiKey,
        Accept: 'application/json',
        'User-Agent': 'TES5-mo2-auto-download-update/3.1',
      },
      timeout: 15000,
      agent,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const parsed = JSON.parse(body);
          fs.writeFileSync(cacheFile, body, 'utf8');
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

async function main() {
  if (!registryFile) {
    console.error('用法: node audit-registry.js <registry.tsv> [apiKeyFile] --out audit.json [--force-refresh]');
    process.exit(2);
  }
  let apiKey = process.env.NEXUS_API_KEY || '';
  if (keyFile && fs.existsSync(keyFile)) apiKey = fs.readFileSync(keyFile, 'utf8').trim();
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
      try { data = await apiGet(modId, apiKey); }
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
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main().catch(err => {
  console.error(`registry audit failed: ${err.message}`);
  process.exit(1);
});
