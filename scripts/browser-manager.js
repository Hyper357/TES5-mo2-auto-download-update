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
  FALLBACK_PORT,
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
const CANONICAL_CDP_PORT = FALLBACK_PORT || 9222;

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
  return [
    process.env.MO2_AUTOMATION_BROWSER,
    process.env.MO2_CHROME_FOR_TESTING,
  ].filter(Boolean);
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
    const req = https.get(url, { headers: { 'User-Agent': 'TES5-MO2-AutoUpdate/4.1.3' } }, res => {
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

  // Do not rely on PowerShell $args after -Command. On some Windows hosts the
  // previous invocation produced null $args and every first-run CFT install failed.
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

  throw new Error('No managed Chrome for Testing found. Run npm run browser:install, or explicitly set MO2_AUTOMATION_BROWSER. System Chrome is not used by default.');
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
    const e = new Error(`BROWSER_PROFILE_MISMATCH: explicit CDP port ${preferred} is already occupied; refusing to silently change an explicitly configured port`);
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
  } catch {
    return fallback;
  }
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
  if (!procs.length) return [];
  for (const p of procs) {
    try {
      cp.spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (_) {}
  }
  return procs.map(p => ({ pid: Number(p.ProcessId), name: p.Name || '' }));
}

function removeStaleProfileLocks(profileDir = getProfileDir()) {
  const removed = [];
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(profileDir, name);
    try {
      fs.rmSync(p, { recursive: true, force: true });
      if (!fs.existsSync(p)) removed.push(name);
    } catch (_) {}
  }
  return removed;
}

function listeningPid(port) {
  if (process.platform !== 'win32') return null;
  const r = cp.spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  const target = `:${port}`;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (!/LISTENING/i.test(line) || !line.includes(target)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || '';
    const pid = Number(cols[cols.length - 1]);
    if ((local.endsWith(target) || local.includes(`${target} `)) && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function processCommandLine(pid) {
  if (process.platform !== 'win32' || !pid) return null;
  const script = '$p=Get-CimInstance Win32_Process -Filter ("ProcessId="+$env:MO2_PID); if($p){$p | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress}';
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MO2_PID: String(pid) },
  });
  if (r.status !== 0 || !String(r.stdout || '').trim()) return null;
  try { return JSON.parse(String(r.stdout).trim()); } catch { return null; }
}

function reclaimCanonicalPortIfLegacyProjectBrowser(port = CANONICAL_CDP_PORT) {
  const pid = listeningPid(port);
  if (!pid) return { reclaimed: false, reason: 'FREE_OR_UNKNOWN' };
  const info = processCommandLine(pid);
  const cmd = String(info?.CommandLine || '');
  const name = String(info?.Name || '');
  const profileDir = getProfileDir();
  const clearlyProjectOwned = /^(chrome|msedge)\.exe$/i.test(name)
    && (cmd.includes(profileDir) || /nexus-autodl-edge/i.test(cmd));
  if (!clearlyProjectOwned) return { reclaimed: false, reason: 'OCCUPIED_UNKNOWN', pid, name, commandLine: cmd.slice(0, 700) };
  try {
    cp.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch (_) {}
  return { reclaimed: true, pid, name };
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
    if (last.state === 'MISMATCH') throw Object.assign(new Error(`BROWSER_PROFILE_MISMATCH: port ${getCdpPort()} is occupied by another browser/profile/service`), { code: 'BROWSER_PROFILE_MISMATCH', status: last });
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

async function ensureCanonicalPortForLegacyConsumers() {
  const explicit = explicitCdpPort();
  if (explicit && explicit !== CANONICAL_CDP_PORT) {
    const e = new Error(`CDP_LEGACY_CONSUMER_PORT_MISMATCH: current pipeline still contains legacy consumers fixed to ${CANONICAL_CDP_PORT}; explicit MO2_CDP_PORT=${explicit} is unsafe`);
    e.code = 'CDP_LEGACY_CONSUMER_PORT_MISMATCH';
    throw e;
  }

  // v4.1.2 could persist a fallback such as 9223, while discover-patches and the
  // execution driver still connect to 9222. Until those consumers are migrated,
  // force the canonical port so every stage talks to the same browser.
  if (getCdpPort() !== CANONICAL_CDP_PORT) {
    const status = await managedSessionStatus({ timeout: 800 });
    if (status.state === 'MANAGED') {
      try {
        const puppeteer = require('puppeteer-core');
        const browser = await puppeteer.connect({ browserURL: getCdpUrl(), defaultViewport: null });
        await browser.close();
      } catch (_) {}
      await new Promise(r => setTimeout(r, 700));
    }
    persistCdpPort(CANONICAL_CDP_PORT, { reason: 'CANONICAL_PORT_REQUIRED_BY_LEGACY_CONSUMERS' });
  }

  let status = await managedSessionStatus({ timeout: 800 });
  if (status.state === 'MANAGED') return { port: CANONICAL_CDP_PORT, reclaimed: false, alreadyManaged: true };

  if (status.state === 'MISMATCH' || !(await portIsFree(CANONICAL_CDP_PORT))) {
    const reclaim = reclaimCanonicalPortIfLegacyProjectBrowser(CANONICAL_CDP_PORT);
    if (reclaim.reclaimed) {
      await new Promise(r => setTimeout(r, 800));
      status = await managedSessionStatus({ timeout: 800 });
    }
    if (status.state === 'MISMATCH' || !(await portIsFree(CANONICAL_CDP_PORT))) {
      const pid = listeningPid(CANONICAL_CDP_PORT);
      const info = processCommandLine(pid);
      const e = new Error(`CDP_CANONICAL_PORT_OCCUPIED: ${CANONICAL_CDP_PORT} is required by current discovery/download consumers but is owned by another service${pid ? ` pid=${pid}` : ''}${info?.Name ? ` name=${info.Name}` : ''}`);
      e.code = 'CDP_CANONICAL_PORT_OCCUPIED';
      e.owner = info || null;
      throw e;
    }
    return { port: CANONICAL_CDP_PORT, reclaimed: !!reclaim.reclaimed, reclaim };
  }
  return { port: CANONICAL_CDP_PORT, reclaimed: false };
}

async function start() {
  const canonical = await ensureCanonicalPortForLegacyConsumers();
  let before = await managedSessionStatus();
  if (before.state === 'MANAGED') return { action: 'start', changed: false, status: before, message: 'managed browser already running', canonical };

  // A prior failed/system-Chrome attempt can keep the project-owned profile locked
  // without exposing CDP. Only terminate browsers whose command line references the
  // exact project profile or the old nexus-autodl-edge profile.
  const terminated = terminateProjectOwnedBrowsers(getProfileDir());
  if (terminated.length) await new Promise(r => setTimeout(r, 900));
  const removedLocks = removeStaleProfileLocks(getProfileDir());

  before = await managedSessionStatus({ timeout: 800 });
  if (before.state === 'MISMATCH') {
    const e = new Error(`BROWSER_PROFILE_MISMATCH: canonical port ${CANONICAL_CDP_PORT} became occupied before launch`);
    e.code = 'BROWSER_PROFILE_MISMATCH';
    throw e;
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
    canonical,
    terminatedStaleProjectBrowsers: terminated,
    removedStaleLocks: removedLocks,
    startupLog,
    install: resolved.install || null,
    status,
  };
}

async function stop() {
  const status = await managedSessionStatus();
  if (status.state === 'STOPPED') return { action: 'stop', changed: false, status };
  if (status.state !== 'MANAGED') throw Object.assign(new Error('BROWSER_PROFILE_MISMATCH: refusing to close an unmanaged browser/service'), { code: 'BROWSER_PROFILE_MISMATCH' });
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
    jsonOut({ ok: false, errorCode: err.code || 'BROWSER_MANAGER_FAILED', message: err.message, port: getCdpPort(), profileDir: getProfileDir(), owner: err.owner || null });
    process.exit(2);
  });
}

module.exports = {
  CANONICAL_CDP_PORT,
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
  listeningPid,
  processCommandLine,
  reclaimCanonicalPortIfLegacyProjectBrowser,
  ensureCanonicalPortForLegacyConsumers,
  waitManaged,
  start,
  stop,
};
