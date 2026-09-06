'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizeString } = require('./diagnostics');

const CDP_PRELOAD = path.join(__dirname, 'cdp-compat-preload.js');

// Node parses NODE_OPTIONS itself rather than delegating argument parsing to
// child_process. On Windows, a quoted value containing backslashes can be
// interpreted as escape sequences (for example E:\\SkyrimAE\\... becoming
// E:SkyrimAE...), which makes --require fail before the child entrypoint runs.
// Node accepts forward slashes in absolute Windows paths, so normalize only the
// preload token used inside NODE_OPTIONS. The filesystem path itself stays intact.
function normalizeNodeRequirePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function nodeOptionsWithProjectPreload(existing = '', preloadPath = CDP_PRELOAD) {
  const current = String(existing || '').trim();
  const safePreload = normalizeNodeRequirePath(preloadPath);
  const currentLower = current.toLowerCase();
  if (currentLower.includes(safePreload.toLowerCase()) || currentLower.includes(String(preloadPath || '').toLowerCase())) return current;
  const quoted = `"${safePreload.replace(/"/g, '\\"')}"`;
  return `${current}${current ? ' ' : ''}--require ${quoted}`;
}

function projectNodeEnv(base = process.env, preloadPath = CDP_PRELOAD) {
  return { ...base, NODE_OPTIONS: nodeOptionsWithProjectPreload(base?.NODE_OPTIONS || '', preloadPath) };
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
  normalizeNodeRequirePath,
  nodeOptionsWithProjectPreload,
  projectNodeEnv,
  runNode,
  spawnNodeDetached,
  openDefault,
};
