'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

function readApiKey(keyFile) {
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
  if (keyFile && fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  return '';
}

function createFilesClient({
  cacheDir,
  forceRefresh = false,
  ttlMs = 6 * 3600 * 1000,
  maxSockets = 8,
  timeoutMs = 15000,
  userAgent = 'TES5-mo2-auto-download-update/3.8',
  game = 'skyrimspecialedition',
} = {}) {
  if (!cacheDir) throw new Error('createFilesClient requires cacheDir');
  fs.mkdirSync(cacheDir, { recursive: true });
  const agent = new https.Agent({ keepAlive: true, maxSockets });

  function cached(modId) {
    const file = path.join(cacheDir, `${modId}.json`);
    if (forceRefresh || !fs.existsSync(file)) return null;
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs >= ttlMs) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  }

  function getFiles(modId, apiKey) {
    const hit = cached(modId);
    if (hit) return Promise.resolve(hit);
    const key = String(apiKey || '').trim();
    if (!key) return Promise.reject(new Error('缺少 Nexus API key'));
    const cacheFile = path.join(cacheDir, `${modId}.json`);

    return new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'api.nexusmods.com',
        path: `/v1/games/${game}/mods/${modId}/files.json`,
        headers: { apikey: key, Accept: 'application/json', 'User-Agent': userAgent },
        timeout: timeoutMs,
        agent,
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
          }
          try {
            const parsed = JSON.parse(body);
            fs.writeFileSync(cacheFile, body, 'utf8');
            resolve(parsed);
          } catch (err) { reject(err); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    });
  }

  return { getFiles };
}

module.exports = { readApiKey, createFilesClient };
