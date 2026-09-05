#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const cp = require('child_process');
const { createLogger, sanitize } = require('./lib/diagnostics');
const { managedSessionStatus, getCdpPort, getProfileDir } = require('./lib/browser-session');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function existsDir(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; }
}

function checkWritable(dir) {
  if (!existsDir(dir)) return false;
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return true; }
  catch { try { fs.unlinkSync(probe); } catch (_) {} return false; }
}

function nexusValidate(apiKey, timeout = 8000) {
  return new Promise(resolve => {
    if (!apiKey) return resolve({ ok: false, status: 'NO_KEY' });
    const req = https.get({
      hostname: 'api.nexusmods.com', path: '/v1/users/validate.json', timeout,
      headers: { apikey: apiKey, Accept: 'application/json', 'User-Agent': 'TES5-mo2-auto-download-update/3.3-diagnostics' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, httpStatus: res.statusCode, user: parsed ? { name: parsed.name, isPremium: parsed.is_premium } : null });
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

function processRunning(name) {
  if (process.platform !== 'win32') return { supported: false, running: null };
  try {
    const out = cp.execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return { supported: true, running: new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(out) };
  } catch (e) { return { supported: true, running: null, error: e.message }; }
}

function findSevenZip(explicit) {
  const candidates = [explicit, process.env.MO2_7Z, process.env.SEVENZIP, 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].filter(Boolean);
  return candidates.find(existsFile) || '';
}

function findNxmHandler(explicit, modsDir) {
  const candidates = [explicit, process.env.MO2_NXM_HANDLER];
  if (modsDir) {
    const mo2Root = path.dirname(modsDir);
    candidates.push(path.join(mo2Root, 'nxmhandler.exe'));
  }
  return candidates.filter(Boolean).find(existsFile) || '';
}

function status(name, ok, detail, severity = 'error') {
  return { name, ok: !!ok, severity: ok ? 'ok' : severity, detail };
}

async function main() {
  const modsDir = argValue('--mods-dir', process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods');
  const downloadsDir = argValue('--downloads', process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads');
  const apiKeyFile = argValue('--api-key-file', process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key');
  const runDir = argValue('--run-dir', path.resolve(process.cwd(), '.runtime', 'diagnostics', new Date().toISOString().replace(/[:.]/g, '-')));
  const debug = process.argv.includes('--debug');
  fs.mkdirSync(runDir, { recursive: true });
  const logger = createLogger(runDir, { debug, runId: `diagnose-${path.basename(runDir)}` });

  let apiKey = process.env.NEXUS_API_KEY || '';
  if (!apiKey && existsFile(apiKeyFile)) {
    try { apiKey = fs.readFileSync(apiKeyFile, 'utf8').trim(); } catch (_) {}
  }

  const nxmHandler = findNxmHandler(argValue('--nxmhandler'), modsDir);
  const sevenzip = findSevenZip(argValue('--sevenzip'));
  const browserSession = await managedSessionStatus();
  const nexusApi = await nexusValidate(apiKey);
  const mo2Proc = processRunning('ModOrganizer.exe');

  const browserDetail = {
    state: browserSession.state,
    managed: browserSession.managed,
    port: getCdpPort(),
    profileDir: getProfileDir(),
    browser: browserSession.browser || '',
    targetCount: browserSession.targetCount || 0,
    markerPresent: browserSession.markerPresent,
    sentinel: browserSession.sentinel,
    error: browserSession.error || '',
  };

  const checks = [
    status('MODS_DIR', existsDir(modsDir), { path: modsDir }),
    status('DOWNLOADS_DIR', existsDir(downloadsDir), { path: downloadsDir }),
    status('DOWNLOADS_WRITABLE', checkWritable(downloadsDir), { path: downloadsDir }),
    status('API_KEY_FILE', !!apiKey, { source: process.env.NEXUS_API_KEY ? 'env' : apiKeyFile }, 'warning'),
    status('NEXUS_API', nexusApi.ok, nexusApi),
    status('AUTOMATION_BROWSER', browserSession.state === 'MANAGED', browserDetail),
    status('BROWSER_ISOLATION', browserSession.state !== 'MISMATCH', browserDetail),
    status('NXM_HANDLER', !!nxmHandler, { path: nxmHandler }),
    status('SEVENZIP', !!sevenzip, { path: sevenzip }),
    status('MO2_PROCESS', mo2Proc.running === true, mo2Proc, mo2Proc.supported ? 'error' : 'warning'),
  ];

  for (const c of checks) {
    const fn = c.ok ? logger.info : (c.severity === 'warning' ? logger.warn : logger.error);
    fn('DIAGNOSE', `${c.name}: ${c.ok ? 'OK' : 'FAILED'}`, { status: c.ok ? 'OK' : 'FAILED', check: c.name, detail: c.detail });
  }

  const errors = checks.filter(c => !c.ok && c.severity === 'error');
  const warnings = checks.filter(c => !c.ok && c.severity === 'warning');
  const health = errors.length ? 'UNHEALTHY' : (warnings.length ? 'DEGRADED' : 'HEALTHY');
  const report = sanitize({
    generatedAt: new Date().toISOString(), health,
    platform: { os: process.platform, release: os.release(), arch: process.arch, node: process.version },
    paths: { modsDir, downloadsDir, apiKeyFile, nxmHandler, sevenzip, automationProfile: getProfileDir() },
    browser: browserDetail,
    checks,
    summary: { ok: checks.filter(c => c.ok).length, warnings: warnings.length, errors: errors.length },
  });
  const reportFile = logger.writeDiagnostic('environment.json', report);
  console.log(JSON.stringify({ health, reportFile, summary: report.summary, browser: browserDetail, checks }, null, 2));
  if (errors.length) process.exitCode = 2;
}

main().catch(err => {
  console.error(`diagnose failed: ${err.message}`);
  process.exit(1);
});
