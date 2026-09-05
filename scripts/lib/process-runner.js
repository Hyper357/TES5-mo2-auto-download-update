'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizeString } = require('./diagnostics');

function runNode(args, options = {}) {
  const capture = options.capture !== false && !options.inherit;
  const r = cp.spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: capture ? 'utf8' : undefined,
    windowsHide: true,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  const result = {
    ok: r.status === 0,
    status: r.status,
    signal: r.signal || null,
    stdout: capture ? sanitizeString(String(r.stdout || '')) : '',
    stderr: capture ? sanitizeString(String(r.stderr || '')) : '',
  };
  if (!result.ok && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`命令失败: node ${args.join(' ')}${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function spawnNodeDetached(args, { cwd, logFile, env } = {}) {
  let fd = 'ignore';
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, 'a');
  }
  const child = cp.spawn(process.execPath, args, {
    cwd,
    env: env || process.env,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  if (typeof fd === 'number') {
    try { fs.closeSync(fd); } catch (_) {}
  }
  return child;
}

function openDefault(target) {
  try {
    let child;
    if (process.platform === 'win32') child = cp.spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'darwin') child = cp.spawn('open', [target], { detached: true, stdio: 'ignore' });
    else child = cp.spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch { return false; }
}

module.exports = { runNode, spawnNodeDetached, openDefault };
