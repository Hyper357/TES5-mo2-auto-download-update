'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

function readApiKey(keyFile) {
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
  if (keyFile && fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  return '';
}

// A 403 "Mod not available" is NOT a transient failure: the mod is hidden from
// the API (adult/blocked/deleted). Retrying it every hour burns no quota but
// used to turn ~700 permanently-unavailable mods into HOLD_API_ERROR rows, which
// ISS-010 then (correctly) reported as an untrustworthy audit. Classify it
// separately so the verdict stays honest.
function classifyApiError(status, body) {
  const text = String(body || '');
  if (status === 403 && /mod not available/i.test(text)) return 'API_MOD_UNAVAILABLE';
  if (status === 429) return 'API_RATE_LIMITED';
  if (status === 403) return 'API_FORBIDDEN';
  if (status === 404) return 'API_NOT_FOUND';
  return `API_HTTP_${status}`;
}

function createFilesClient({
  cacheDir,
  forceRefresh = false,
  ttlMs = 6 * 3600 * 1000,
  unavailableTtlMs = 24 * 3600 * 1000,
  maxSockets = 8,
  timeoutMs = 15000,
  userAgent = 'TES5-mo2-auto-download-update/3.8',
  game = 'skyrimspecialedition',
} = {}) {
  if (!cacheDir) throw new Error('createFilesClient requires cacheDir');
  fs.mkdirSync(cacheDir, { recursive: true });
  const agent = new https.Agent({ keepAlive: true, maxSockets });

  function unavailableMarker(modId) {
    return path.join(cacheDir, `${modId}.unavailable.json`);
  }

  function cachedUnavailable(modId) {
    if (forceRefresh) return null;
    const file = unavailableMarker(modId);
    if (!fs.existsSync(file)) return null;
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs >= unavailableTtlMs) return null;
      const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
      const err = new Error(marker.message || 'Mod not available');
      err.statusCode = Number(marker.statusCode || 403);
      err.code = String(marker.code || 'API_MOD_UNAVAILABLE');
      return err;
    } catch { return null; }
  }

  function cached(modId) {
    const file = path.join(cacheDir, `${modId}.json`);
    if (forceRefresh || !fs.existsSync(file)) return null;
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs >= ttlMs) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  }

  function staleCached(modId) {
    const file = path.join(cacheDir, `${modId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.defineProperty(parsed, '__stale', { value: true, enumerable: false });
      return parsed;
    } catch { return null; }
  }

  function getFiles(modId, apiKey) {
    const hit = cached(modId);
    if (hit) return Promise.resolve(hit);
    const knownUnavailable = cachedUnavailable(modId);
    if (knownUnavailable) return Promise.reject(knownUnavailable);
    const key = String(apiKey || '').trim();
    if (!key) return Promise.reject(new Error('缺少 Nexus API key'));
    const cacheFile = path.join(cacheDir, `${modId}.json`);

    // A rate-limited (429) or server-erroring API must not erase a row that we
    // already hold data for: serve the stale cache with a `__stale` flag so the
    // audit stays usable (and still says the data is old) instead of turning
    // hundreds of rows into HOLD_API_ERROR (ISS-012).
    const retryable = (code) => code === 'API_RATE_LIMITED' || /^API_HTTP_5/.test(code || '');
    const fallback = () => {
      const stale = staleCached(modId);
      return stale || null;
    };

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
            const code = classifyApiError(res.statusCode, body);
            const message = code === 'API_MOD_UNAVAILABLE'
              ? `Mod not available: ${modId}`
              : `HTTP ${res.statusCode}`;
            const err = Object.assign(new Error(message), {
              statusCode: res.statusCode,
              code,
              body: String(body || '').slice(0, 200),
            });
            // Remember permanent "mod not available" so the next run does not
            // requery ~700 of them and does not mistake them for throttling.
            if (code === 'API_MOD_UNAVAILABLE') {
              try {
                fs.writeFileSync(unavailableMarker(modId), JSON.stringify({
                  code, statusCode: res.statusCode, message, at: new Date().toISOString(),
                }), 'utf8');
              } catch { /* cache write is best-effort */ }
            }
            const stale = retryable(code) ? fallback() : null;
            return stale ? resolve(stale) : reject(err);
          }
          try {
            const parsed = JSON.parse(body);
            fs.writeFileSync(cacheFile, body, 'utf8');
            try { fs.unlinkSync(unavailableMarker(modId)); } catch { /* no marker */ }
            resolve(parsed);
          } catch (err) { reject(err); }
        });
      });
      const onSoftFailure = (err) => {
        const stale = fallback();
        if (stale) resolve(stale); else reject(err);
      };
      req.on('error', onSoftFailure);
      req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    });
  }

  return { getFiles };
}

module.exports = { readApiKey, createFilesClient, classifyApiError };

