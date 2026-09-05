'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = Number(process.env.MO2_CDP_PORT || 9222);
const PROFILE_ROOT = process.env.MO2_AUTOMATION_PROFILE
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'TES5-MO2-AutoUpdate', 'browser-profile');
const MARKER_FILE = '.tes5-mo2-automation.json';
const SENTINEL_PREFIX = 'tes5-mo2-automation=';

function getCdpPort() {
  const n = Number(process.env.MO2_CDP_PORT || DEFAULT_PORT);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 9222;
}

function getCdpUrl() {
  return `http://127.0.0.1:${getCdpPort()}`;
}

function getProfileDir() {
  return path.resolve(PROFILE_ROOT);
}

function markerPath(profileDir = getProfileDir()) {
  return path.join(profileDir, MARKER_FILE);
}

function loadMarker(profileDir = getProfileDir()) {
  try {
    const obj = JSON.parse(fs.readFileSync(markerPath(profileDir), 'utf8'));
    return obj && obj.token ? obj : null;
  } catch {
    return null;
  }
}

function ensureMarker(profileDir = getProfileDir()) {
  fs.mkdirSync(profileDir, { recursive: true });
  const existing = loadMarker(profileDir);
  if (existing) return existing;
  const marker = {
    schema: 1,
    token: crypto.randomUUID(),
    purpose: 'TES5-MO2-Nexus-Automation',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(markerPath(profileDir), JSON.stringify(marker, null, 2), 'utf8');
  return marker;
}

function sentinelUrl(token) {
  const html = '<title>TES5 MO2 Automation Browser</title><h2>TES5 MO2 Automation Browser</h2><p>Keep this tab open. This browser profile is reserved for Nexus automation.</p>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}#${SENTINEL_PREFIX}${encodeURIComponent(token)}`;
}

function httpJson(url, timeout = 2500) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ ok: false, status: res.statusCode, error: 'INVALID_JSON' });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

function targetHasSentinel(targets, token) {
  if (!token || !Array.isArray(targets)) return false;
  const needle = `${SENTINEL_PREFIX}${encodeURIComponent(token)}`;
  return targets.some(t => String(t?.url || '').includes(needle));
}

async function managedSessionStatus(options = {}) {
  const profileDir = options.profileDir || getProfileDir();
  const baseUrl = options.cdpUrl || getCdpUrl();
  const marker = loadMarker(profileDir);
  const version = await httpJson(`${baseUrl}/json/version`, options.timeout || 2500);
  if (!version.ok) {
    return {
      state: 'STOPPED', managed: false, cdp: false,
      port: getCdpPort(), profileDir, markerPresent: !!marker,
      error: version.error || `HTTP_${version.status || 'UNKNOWN'}`,
    };
  }
  const list = await httpJson(`${baseUrl}/json/list`, options.timeout || 2500);
  const targets = list.ok && Array.isArray(list.json) ? list.json : [];
  const sentinel = !!marker && targetHasSentinel(targets, marker.token);
  return {
    state: sentinel ? 'MANAGED' : 'MISMATCH',
    managed: sentinel,
    cdp: true,
    port: getCdpPort(), profileDir,
    markerPresent: !!marker, sentinel,
    browser: version.json?.Browser || '',
    protocol: version.json?.['Protocol-Version'] || '',
    targetCount: targets.length,
  };
}

async function assertManagedSession(options = {}) {
  const status = await managedSessionStatus(options);
  if (status.state === 'MANAGED') return status;
  const err = new Error(status.state === 'MISMATCH'
    ? `BROWSER_PROFILE_MISMATCH: CDP ${status.port} is occupied by an unmanaged browser/profile`
    : `CDP_UNAVAILABLE: managed automation browser is not running on ${status.port}`);
  err.code = status.state === 'MISMATCH' ? 'BROWSER_PROFILE_MISMATCH' : 'CDP_UNAVAILABLE';
  err.status = status;
  throw err;
}

module.exports = {
  MARKER_FILE,
  SENTINEL_PREFIX,
  getCdpPort,
  getCdpUrl,
  getProfileDir,
  markerPath,
  loadMarker,
  ensureMarker,
  sentinelUrl,
  httpJson,
  targetHasSentinel,
  managedSessionStatus,
  assertManagedSession,
};
