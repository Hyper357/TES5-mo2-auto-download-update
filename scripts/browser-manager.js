#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const cp = require('child_process');
const { argValue, hasFlag } = require('./lib/cli');
const { loadJson, saveJson } = require('./lib/fs-json');
const {
  getCdpPort,
  getCdpUrl,
  getProfileDir,
  explicitCdpPort,
  persistCdpPort,
  ensureMarker,
  sentinelUrl,
  managedSessionStatus,
  assertManagedSession,
} = require('./lib/browser-session');

const rootDir = path.resolve(__dirname, '..');
const browserRoot = process.env.MO2_BROWSER_ROOT || path.join(rootDir, '.runtime', 'browser');
const installMeta = path.join(browserRoot, 'install.json');
const diagnosticsRoot = path.join(rootDir, '.runtime', 'diagnostics');
const CFT_INDEX = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function jsonOut(value) {
  console.log(JSON.stringify(value, null, 2));
}

function findRecursive(dir, filename, depth = 5) {
  if (!dir || depth < 0) return '';
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === filename.toLowerCase()) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findRecursive(path.join(dir, e.name), filename, depth - 1);
    if (hit) return hit;
  }
  return '';
}

function explicitBrowserCandidates() {
  return [process.env.MO2_AUTOMATION_BROWSER, process.env.MO2_CHROME_FOR_TESTING].filter(Boolean);
}

function managedBrowserCandidates() {
  return [
    ...explicitBrowserCandidates(),
    loadJson(installMeta, {})?.executable || '',
    findRecursive(browserRoot, 'chrome.exe', 6),
  ].filter(Boolean);
}

function systemBrowserCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean);
}

function browserCandidates({ includeSystem = false } = {}) {
  return [...managedBrowserCandidates(), ...(includeSystem ? systemBrowserCandidates() : [])];
}

function findBrowser(options = {}) {
  return browserCandidates(options).find(existsFile) || '';
}

function allowSystemChrome() {
  return hasFlag(process.argv, '--allow-system-chrome') || /^(1|true|yes)$/i.test(String(process.env.MO2_ALLOW_SYSTEM_CHROME || ''));
}

function httpsBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TES5-MO2-AutoUpdate/4.1.4' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsBuffer(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timeout')));
  });
}

function psQuote(v) {
  return `'${String(v || '').replace(/'/g, "''")}'`;
}

async function installChromeForTesting() {
  if (process.platform !== 'win32') throw new Error('browser install currently supports Windows only');
  fs.mkdirSync(browserRoot, { recursive: true });
  const index = JSON.parse((await httpsBuffer(CFT_INDEX)).toString('utf8'));
  const stable = index?.channels?.Stable;
  const item = stable?.downloads?.chrome?.find(x => x.platform === 'win64');
  if (!item?.url || !stable?.version) throw new Error('Chrome for Testing stable win64 download not found');

  const targetDir = path.join(browserRoot, `chrome-${stable.version}`);
  const existing = findRecursive(targetDir, 'chrome.exe', 5);
  if (existing) {
    saveJson(installMeta, { version: stable.version, executable: existing, source: item.url, installedAt: new Date().toISOString() }, { atomic: false });
    return { installed: false, version: stable.version, executable: existing, reused: true };
  }

  const zip = path.join(browserRoot, `chrome-${stable.version}-win64.zip`);
  fs.writeFileSync(zip, await httpsBuffer(item.url));
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  const expandCommand = `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(targetDir)} -Force`;
  const ps = cp.spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', expandCommand,
  ], { encoding: 'utf8', windowsHide: true });
  if (ps.status !== 0) throw new Error(`Expand-Archive failed: ${String(ps.stderr || ps.stdout || '').trim()}`);

  try { fs.unlinkSync(zip); } catch (_) {}
  const executable = findRecursive(targetDir, 'chrome.exe', 5);
  if (!executable) throw new Error('Chrome for Testing extracted but chrome.exe was not found');
  saveJson(installMeta, { version: stable.version, executable, source: item.url, installedAt: new Date().toISOString() }, { atomic: false });
  return { installed: true, version: stable.version, executable };
}

async function resolveAutomationBrowser() {
  const explicit = explicitBrowserCandidates().find(existsFile);
  if (explicit) return { executable: explicit, source: 'EXPLICIT' };

  const managed = [loadJson(installMeta, {})?.executable || '', findRecursive(browserRoot, 'chrome.exe', 6)].find(existsFile);
  if (managed) return { executable: managed, source: 'CHROME_FOR_TESTING_MANAGED' };

  if (!hasFlag(process.argv, '--no-install')) {
    const install = await installChromeForTesting();
    return { executable: install.executable, source: 'CHROME_FOR_TESTING_AUTO_INSTALL', install };
  }

  if (allowSystemChrome()) {
    const system = systemBrowserCandidates().find(existsFile);
    if (system) return { executable: system, source: 'SYSTEM_CHROME_EXPLICIT_FALLBACK' };
  }

  throw new Error('No managed Chrome for Testing found. Run npm run browser:install or explicitly set MO2_AUTOMATION_BROWSER.');
}

function portIsFree(port, timeoutMs = 500) {
  return new Promise(resolve => {
    const server = net.createServer();
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      try { server.close(); } catch (_) {}
      resolve(value);
    };
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => finish(true));
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

async function selectLaunchPort(preferred = getCdpPort(), span = 32) {
  if (await portIsFree(preferred)) return { port: preferred, changed: false };
  if (explicitCdpPort()) {
    const e = new Error(`BROWSER_PROFILE_MISMATCH: explicit CDP port ${preferred} is occupied; refusing to override MO2_CDP_PORT`);
    e.code = 'BROWSER_PROFILE_MISMATCH';
    throw e;
  }
  for (let offset = 1; offset <= span; offset += 1) {
    const candidate = preferred + offset;
    if (candidate >= 65536) break;
    if (await portIsFree(candidate)) {
      persistCdpPort(candidate, { reason: 'AUTO_FALLBACK_FROM_OCCUPIED_PORT', previousPort: preferred });
      return { port: candidate, changed: true, previousPort: preferred };
    }
  }
  const e = new Error(`CDP_PORT_EXHAUSTED: no free localhost port found near ${preferred}`);
  e.code = 'CDP_PORT_EXHAUSTED';
  throw e;
}

function parseJsonLoose(text, fallback = []) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return fallback; }
}

function projectOwnedBrowserProcesses(profileDir = getProfileDir()) {
  if (process.platform !== 'win32') return [];
  const script = [
    '$profile=$env:MO2_PROJECT_BROWSER_PROFILE;',
    'Get-CimInstance Win32_Process |',
    "Where-Object { $_.Name -match '^(chrome|msedge)\\.exe$' -and $_.CommandLine -and ($_.CommandLine -like ('*'+$profile+'*') -or $_.CommandLine -like '*nexus-autodl-edge*') } |",
    'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  ].join(' ');
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MO2_PROJECT_BROWSER_PROFILE: profileDir },
  });
  if (r.status !== 0) return [];
  return parseJsonLoose(r.stdout, []).filter(x => Number(x?.ProcessId) > 0);
}

function terminateProjectOwnedBrowsers(profileDir = getProfileDir()) {
  const procs = projectOwnedBrowserProcesses(profileDir);
  for (const p of procs) {
    try { cp.spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch (_) {}
  }
  return procs.map(p => ({ pid: Number(p.ProcessId), name: p.Name || '' }));
}

function removeStaleProfileLocks(profileDir = getProfileDir()) {
  const removed = [];
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(profileDir, name);
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      if (!fs.existsSync(p)) removed.push(name);
    } catch (_) {}
  }
  return removed;
}

async function waitManaged(timeoutMs = 30000, child = null) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      const e = new Error(`BROWSER_PROCESS_EXITED: browser exited before CDP became ready (exit=${child.exitCode})`);
      e.code = 'BROWSER_PROCESS_EXITED';
      throw e;
    }
    last = await managedSessionStatus({ timeout: 1500 });
    if (last.state === 'MANAGED') return last;
    if (last.state === 'MISMATCH') {
      const e = new Error(`BROWSER_PROFILE_MISMATCH: selected CDP port ${getCdpPort()} became occupied by another browser/profile/service`);
      e.code = 'BROWSER_PROFILE_MISMATCH';
      e.status = last;
      throw e;
    }
    await new Promise(r => setTimeout(r, 700));
  }
  const e = new Error(`CDP_UNAVAILABLE: managed browser did not become ready within ${timeoutMs}ms (${JSON.stringify(last || {})})`);
  e.code = 'CDP_UNAVAILABLE';
  throw e;
}

function tailFile(file, maxBytes = 12000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(stat.size - start);
    fs.readSync(fd, b, 0, b.length, start);
    fs.closeSync(fd);
    return b.toString('utf8').slice(-maxBytes);
  } catch { return ''; }
}

async function start() {
  let before = await managedSessionStatus({ timeout: 800 });
  if (before.state === 'MANAGED') {
    return { action: 'start', changed: false, status: before, message: 'managed browser already running' };
  }

  const preferred = getCdpPort();
  let portSelection = { port: preferred, changed: false };
  if (before.state === 'MISMATCH' || !(await portIsFree(preferred))) {
    // Unknown/daily browsers are never killed. Move the project browser instead.
    portSelection = await selectLaunchPort(preferred);
    before = await managedSessionStatus({ timeout: 800 });
    if (before.state === 'MANAGED') {
      return { action: 'start', changed: false, status: before, portSelection };
    }
    if (before.state === 'MISMATCH') {
      const e = new Error(`BROWSER_PROFILE_MISMATCH: fallback port ${getCdpPort()} is unexpectedly occupied`);
      e.code = 'BROWSER_PROFILE_MISMATCH';
      throw e;
    }
  }

  // Stale browsers are killed only when their command line proves they belong to
  // this project's automation profile or the historical nexus-autodl-edge profile.
  const terminated = terminateProjectOwnedBrowsers(getProfileDir());
  if (terminated.length) await new Promise(r => setTimeout(r, 900));
  const removedLocks = removeStaleProfileLocks(getProfileDir());

  if (!(await portIsFree(getCdpPort()))) {
    if (explicitCdpPort()) {
      const e = new Error(`BROWSER_PROFILE_MISMATCH: explicit CDP port ${getCdpPort()} became occupied before launch`);
      e.code = 'BROWSER_PROFILE_MISMATCH';
      throw e;
    }
    portSelection = await selectLaunchPort(getCdpPort());
  }

  const resolved = await resolveAutomationBrowser();
  const executable = resolved.executable;
  const profileDir = getProfileDir();
  const marker = ensureMarker(profileDir);
  const port = getCdpPort();
  const urls = [sentinelUrl(marker.token), 'https://www.nexusmods.com/users/sign-in'];
  const browserArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-component-update',
    '--enable-logging=stderr',
    '--v=1',
    '--new-window',
    ...urls,
  ];

  fs.mkdirSync(diagnosticsRoot, { recursive: true });
  const startupLog = path.join(diagnosticsRoot, 'browser-startup.log');
  const logFd = fs.openSync(startupLog, 'a');
  fs.writeSync(logFd, `\n--- ${new Date().toISOString()} launch ${executable} port=${port} ---\n`);
  const child = cp.spawn(executable, browserArgs, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: false });
  child.unref();

  let status;
  try {
    status = await waitManaged(Number(argValue(process.argv, '--timeout-ms', '30000')) || 30000, child);
  } catch (err) {
    try { fs.closeSync(logFd); } catch (_) {}
    const tail = tailFile(startupLog);
    const e = new Error(`${err.message}; startupLog=${startupLog}${tail ? `; logTail=${tail.replace(/[\r\n]+/g, ' ').slice(-2500)}` : ''}`);
    e.code = err.code || 'BROWSER_START_FAILED';
    throw e;
  }
  try { fs.closeSync(logFd); } catch (_) {}

  return {
    action: 'start',
    changed: true,
    executable,
    browserSource: resolved.source,
    profileDir,
    port,
    portSelection,
    terminatedStaleProjectBrowsers: terminated,
    removedStaleLocks,
    startupLog,
    install: resolved.install || null,
    status,
  };
}

async function stop() {
  const status = await managedSessionStatus();
  if (status.state === 'STOPPED') return { action: 'stop', changed: false, status };
  if (status.state !== 'MANAGED') {
    const e = new Error('BROWSER_PROFILE_MISMATCH: refusing to close an unmanaged browser/service');
    e.code = 'BROWSER_PROFILE_MISMATCH';
    throw e;
  }
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: getCdpUrl(), defaultViewport: null });
  await browser.close();
  return { action: 'stop', changed: true, status: await managedSessionStatus() };
}

async function main() {
  const cmd = process.argv[2] || 'status';
  let result;
  if (cmd === 'install') result = await installChromeForTesting();
  else if (cmd === 'start') result = await start();
  else if (cmd === 'stop') result = await stop();
  else if (cmd === 'status') result = await managedSessionStatus();
  else if (cmd === 'assert') result = await assertManagedSession();
  else throw new Error(`unknown browser-manager command: ${cmd}`);
  jsonOut(result);
}

if (require.main === module) {
  main().catch(err => {
    jsonOut({ ok: false, errorCode: err.code || 'BROWSER_MANAGER_FAILED', message: err.message, port: getCdpPort(), profileDir: getProfileDir() });
    process.exit(2);
  });
}

module.exports = {
  existsFile,
  findRecursive,
  explicitBrowserCandidates,
  managedBrowserCandidates,
  systemBrowserCandidates,
  browserCandidates,
  findBrowser,
  allowSystemChrome,
  portIsFree,
  selectLaunchPort,
  resolveAutomationBrowser,
  installChromeForTesting,
  projectOwnedBrowserProcesses,
  terminateProjectOwnedBrowsers,
  removeStaleProfileLocks,
  waitManaged,
  start,
  stop,
};
