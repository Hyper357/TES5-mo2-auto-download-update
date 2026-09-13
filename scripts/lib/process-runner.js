'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizeString } = require('./diagnostics');

const CDP_PRELOAD = path.join(__dirname, 'cdp-compat-preload.js');
const DEFAULT_CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;
const REVIEW_EXACT_EXECUTOR = path.join(__dirname, '..', 'review-exact-execute.js');

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

function isExplicitReviewManifest(file) {
  if (!file || path.basename(String(file)).toLowerCase() !== 'review-run.tsv') return false;
  try {
    const rows = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.trim() && !line.startsWith('#'));
    if (!rows.length) return false;
    return rows.every(line => {
      const cols = line.split('\t');
      const note = String(cols[3] || '');
      const action = String(cols[5] || '').trim().toUpperCase();
      return action === 'DOWNLOAD' && /(?:^|;\s*)user-selected-nexus-file(?:;|$)/i.test(note);
    });
  } catch (_) {
    return false;
  }
}

function routedNodeArgs(args) {
  const list = Array.isArray(args) ? [...args] : [];
  if (list.length < 2) return list;
  const entry = path.resolve(String(list[0] || ''));
  const directExecutor = path.resolve(__dirname, '..', 'execute-plan.js');
  if (entry === directExecutor && isExplicitReviewManifest(list[1])) {
    list[0] = REVIEW_EXACT_EXECUTOR;
  }
  return list;
}

// Also update the current process environment so raw child_process calls made by
// legacy wrappers inherit the same shared-CDP preload. This does not patch the
// current process; it only guarantees that subsequently spawned Node children do.
process.env.NODE_OPTIONS = nodeOptionsWithProjectPreload(process.env.NODE_OPTIONS || '');

function runNode(args, options = {}) {
  const routedArgs = routedNodeArgs(args);
  const capture = !!options.capture;
  const maxBuffer = capture
    ? Math.max(1024 * 1024, Number(options.maxBuffer || DEFAULT_CAPTURE_MAX_BUFFER))
    : undefined;
  const r = cp.spawnSync(process.execPath, routedArgs, {
    cwd: options.cwd,
    env: projectNodeEnv(options.env || process.env),
    encoding: capture ? 'utf8' : undefined,
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...(capture ? { maxBuffer } : {}),
  });
  const spawnError = r.error || null;
  const result = {
    ok: !spawnError && r.status === 0,
    status: r.status,
    signal: r.signal || null,
    errorCode: spawnError?.code || null,
    stdout: capture ? sanitizeString(String(r.stdout || '')) : '',
    stderr: capture ? sanitizeString(String(r.stderr || '')) : '',
    maxBuffer: capture ? maxBuffer : null,
  };
  if (!result.ok && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || spawnError?.message || '').trim();
    const code = spawnError?.code === 'ENOBUFS' ? `PROCESS_CAPTURE_MAX_BUFFER_EXCEEDED:${maxBuffer}` : (spawnError?.code || 'CHILD_PROCESS_FAILED');
    throw new Error(`${code}: 命令失败: node ${routedArgs.join(' ')}${detail ? `\n${detail}` : ''}`);
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
  DEFAULT_CAPTURE_MAX_BUFFER,
  REVIEW_EXACT_EXECUTOR,
  normalizeNodeRequirePath,
  nodeOptionsWithProjectPreload,
  projectNodeEnv,
  isExplicitReviewManifest,
  routedNodeArgs,
  runNode,
  spawnNodeDetached,
  openDefault,
};
