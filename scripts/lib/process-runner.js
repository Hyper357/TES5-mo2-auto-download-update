'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeString } = require('./diagnostics');

const CDP_PRELOAD = path.join(__dirname, 'cdp-compat-preload.js');
const DEFAULT_CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;
const REVIEW_EXACT_EXECUTOR = path.join(__dirname, '..', 'review-exact-execute.js');
const ASYNC_FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;

// Some sandboxed / guarded environments break the synchronous spawn transport
// entirely (spawnSync of ANY executable fails with EBUSY) while async spawn
// keeps working. When that happens, fall back to an async child whose result
// is handed back through a file, with the parent synchronously polling for it.
// This keeps update runs alive instead of dying with CHILD_PROCESS_FAILED.
const ASYNC_WRAPPER = `
const cp = require('child_process');
const fs = require('fs');
const args = process.argv.slice(1);
const outF = process.env.RN_OUT, errF = process.env.RN_ERR, resF = process.env.RN_RES, cwdF = process.env.RN_CWD;
const inherit = process.env.RN_INHERIT === '1';
const o = inherit ? 'inherit' : fs.openSync(outF, 'w');
const e = inherit ? 'inherit' : fs.openSync(errF, 'w');
const child = cp.spawn(process.execPath, args, { cwd: cwdF || undefined, env: process.env, windowsHide: true, stdio: ['ignore', o, e] });
child.on('error', () => { try { fs.writeFileSync(resF, JSON.stringify({ status: null, signal: null, spawnError: true })); } catch (_) {} });
child.on('close', (code, signal) => { try { fs.writeFileSync(resF, JSON.stringify({ status: code, signal: signal || null })); } catch (_) {} });
`;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* fallback: busy wait */ const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function runNodeAsyncFallback(routedArgs, { cwd, env, capture = false, timeoutMs = ASYNC_FALLBACK_TIMEOUT_MS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnode-async-'));
  const outF = path.join(dir, 'out.log');
  const errF = path.join(dir, 'err.log');
  const resF = path.join(dir, 'res.json');
  const child = cp.spawn(process.execPath, ['-e', ASYNC_WRAPPER, ...routedArgs], {
    cwd,
    env: { ...projectNodeEnv(env || process.env), RN_OUT: outF, RN_ERR: errF, RN_RES: resF, RN_CWD: cwd || '', RN_INHERIT: capture ? '' : '1' },
    windowsHide: true,
    stdio: 'ignore',
  });
  const deadline = Date.now() + timeoutMs;
  let res = null;
  while (Date.now() < deadline) {
    sleepSync(250);
    try {
      res = JSON.parse(fs.readFileSync(resF, 'utf8'));
      break;
    } catch (_) { /* result not written yet */ }
  }
  if (!res) {
    try { child.kill(); } catch (_) { /* already gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    return { status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('async fallback timed out'), { code: 'ETIMEDOUT' }) };
  }
  let stdout = '';
  let stderr = '';
  try { stdout = fs.readFileSync(outF, 'utf8'); } catch (_) {}
  try { stderr = fs.readFileSync(errF, 'utf8'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  const error = res.spawnError ? Object.assign(new Error('async spawn failed'), { code: 'EBUSY' }) : null;
  return { status: res.status, signal: res.signal, stdout, stderr, error };
}

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
  let r = cp.spawnSync(process.execPath, routedArgs, {
    cwd: options.cwd,
    env: projectNodeEnv(options.env || process.env),
    encoding: capture ? 'utf8' : undefined,
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...(capture ? { maxBuffer } : {}),
  });
  if (r.error && ['EBUSY', 'ETIMEDOUT', 'EAGAIN'].includes(r.error.code)) {
    const fb = runNodeAsyncFallback(routedArgs, { cwd: options.cwd, env: options.env || process.env, capture });
    r = {
      status: fb.status,
      signal: fb.signal,
      error: fb.error,
      stdout: capture ? fb.stdout : '',
      stderr: capture ? fb.stderr : '',
    };
  }
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
