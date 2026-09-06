'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizeString } = require('./diagnostics');

const CDP_PRELOAD = path.join(__dirname, 'cdp-compat-preload.js');

function nodeOptionsWithProjectPreload(existing = '') {
  const current = String(existing || '').trim();
  if (current.toLowerCase().includes(CDP_PRELOAD.toLowerCase())) return current;
  const quoted = `"${CDP_PRELOAD.replace(/"/g, '\\"')}"`;
  return `${current}${current ? ' ' : ''}--require ${quoted}`;
}

function projectNodeEnv(base = process.env) {
  return { ...base, NODE_OPTIONS: nodeOptionsWithProjectPreload(base?.NODE_OPTIONS || '') };
}

// Also update the current process environment so raw child_process calls made by
// legacy wrappers inherit the same shared-CDP preload. This does not patch the
// current process; it only guarantees that subsequently spawned Node children do.
process.env.NODE_OPTIONS = nodeOptionsWithProjectPreload(process.env.NODE_OPTIONS || '');

function runNode(args, options = {}) {
  const capture = !!options.capture;
  const r = cp.spawnSync(process.execPath, args, {
    cwd: options.cwd,
    env: projectNodeEnv(options.env || process.env),
    encoding: capture ? 'utf8' : undefined,
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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
    env: projectNodeEnv(env || process.env),
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

module.exports = {
  CDP_PRELOAD,
  nodeOptionsWithProjectPreload,
  projectNodeEnv,
  runNode,
  spawnNodeDetached,
  openDefault,
};
