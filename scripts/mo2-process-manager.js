#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { argValue } = require('./lib/cli');

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function defaultModsDir() {
  return process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
}

function executableCandidates(modsDir = defaultModsDir()) {
  const root = process.env.MO2_ROOT || path.dirname(path.resolve(modsDir));
  return [
    process.env.MO2_EXE,
    path.join(root, 'ModOrganizer.exe'),
    path.join(root, 'ModOrganizer2.exe'),
  ].filter(Boolean);
}

function findExecutable(modsDir = defaultModsDir()) {
  return executableCandidates(modsDir).find(existsFile) || '';
}

function isRunning() {
  if (process.platform !== 'win32') return { supported: false, running: null };
  try {
    const out = cp.execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq ModOrganizer.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true,
    });
    return { supported: true, running: /"ModOrganizer\.exe"/i.test(out), sample: String(out || '').trim().slice(0, 500) };
  } catch (err) {
    return { supported: true, running: null, error: err.message };
  }
}

// Some sandboxed environments fail every spawnSync of system executables with
// EBUSY (tasklist.exe, cmd.exe, ...). Async spawn still works there, so fall
// back to it when the synchronous probe cannot run. Detection semantics are
// unchanged; only the transport differs.
function isRunningViaAsyncSpawn() {
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    try {
      const child = cp.spawn('tasklist.exe', ['/FI', 'IMAGENAME eq ModOrganizer.exe', '/FO', 'CSV', '/NH'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout.on('data', d => { out += d; });
      child.on('error', err => finish({ supported: true, running: null, error: `async spawn failed: ${err.message}` }));
      child.on('close', () => finish({
        supported: true,
        running: /"ModOrganizer\.exe"/i.test(out),
        sample: String(out || '').trim().slice(0, 500),
      }));
      setTimeout(() => { try { child.kill(); } catch { /* already dead */ } finish({ supported: true, running: null, error: 'async tasklist probe timed out' }); }, 10000);
    } catch (err) {
      finish({ supported: true, running: null, error: `async spawn threw: ${err.message}` });
    }
  });
}

async function isRunningAsync() {
  const sync = isRunning();
  if (sync.running !== null) return sync;
  return isRunningViaAsyncSpawn();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureRunning(options = {}) {
  const modsDir = options.modsDir || defaultModsDir();
  let before = await isRunningAsync();
  if (before.running !== true) {
    // One retry: transient spawn failures should not immediately escalate to
    // launching a duplicate MO2 instance.
    await sleep(500);
    before = await isRunningAsync();
  }
  if (before.running === true) return { action: 'ensure', changed: false, running: true, status: before };
  if (process.platform !== 'win32') {
    const e = new Error('MO2_PROCESS_UNSUPPORTED: automatic MO2 launch is currently Windows-only');
    e.code = 'MO2_PROCESS_UNSUPPORTED';
    throw e;
  }

  const executable = options.executable || findExecutable(modsDir);
  if (!executable) {
    const e = new Error(`MO2_EXE_NOT_FOUND: could not find ModOrganizer.exe beside modsDir=${modsDir}; set MO2_EXE or MO2_ROOT`);
    e.code = 'MO2_EXE_NOT_FOUND';
    throw e;
  }

  const child = cp.spawn(executable, [], {
    cwd: path.dirname(executable),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  let spawnError = null;
  child.on('error', err => { spawnError = err; });
  child.unref();

  const timeoutMs = Number(options.timeoutMs || 20000) || 20000;
  const deadline = Date.now() + timeoutMs;
  let last = before;
  while (Date.now() < deadline) {
    await sleep(500);
    last = await isRunningAsync();
    if (last.running === true) {
      return { action: 'ensure', changed: true, running: true, pid: child.pid, executable, modsDir, status: last };
    }
    if (spawnError) {
      const e = new Error(`MO2_START_FAILED: spawn of ${executable} failed: ${spawnError.code || spawnError.message}`);
      e.code = 'MO2_START_FAILED';
      e.executable = executable;
      e.lastStatus = last;
      throw e;
    }
    if (child.exitCode !== null) break;
  }

  const e = new Error(`MO2_START_FAILED: ModOrganizer.exe did not become visible within ${timeoutMs}ms`);
  e.code = 'MO2_START_FAILED';
  e.executable = executable;
  e.lastStatus = last;
  throw e;
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const modsDir = argValue(process.argv, '--mods-dir', defaultModsDir());
  let result;
  if (cmd === 'status') {
    result = { action: 'status', modsDir, executable: findExecutable(modsDir), status: await isRunningAsync() };
  } else if (cmd === 'ensure') {
    result = await ensureRunning({
      modsDir,
      executable: argValue(process.argv, '--exe', process.env.MO2_EXE || ''),
      timeoutMs: Number(argValue(process.argv, '--timeout-ms', '20000')) || 20000,
    });
  } else {
    throw new Error(`unknown MO2 process command: ${cmd}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.log(JSON.stringify({ ok: false, errorCode: err.code || 'MO2_PROCESS_MANAGER_FAILED', message: err.message }, null, 2));
    process.exit(2);
  });
}

module.exports = {
  defaultModsDir,
  executableCandidates,
  findExecutable,
  isRunning,
  ensureRunning,
};
