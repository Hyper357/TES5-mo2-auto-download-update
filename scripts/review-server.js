#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');
const { argValue } = require('./lib/cli');
const { loadJson, saveJson } = require('./lib/fs-json');
const { openDefault, runNode } = require('./lib/process-runner');
const { findLatestReviewRun, latestReviewJob } = require('./lib/runtime');
const { renderHtml } = require('./build-review-center');

const ROOT_DIR = path.resolve(__dirname, '..');

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function decorateHtml(html, runDir) {
  if (html.includes('data-auto-summary="embedded"')) return html;
  const r = loadJson(path.join(runDir, 'final-report.json'), null);
  if (!r) return html;
  const requested = Number(r.requested ?? r.downloadReady ?? r.download ?? 0) || 0;
  const verified = Number(r.verified ?? 0) || 0;
  const failed = Number(r.failed ?? Math.max(0, requested - verified)) || 0;
  const review = Number(r.humanReview ?? 0) || 0;
  const mode = esc(r.mode || 'AUDIT');
  const banner = `<div style="background:#171d24;border:1px solid #2b3541;border-radius:16px;padding:18px 20px;margin:0 0 18px"><div style="font-weight:700;margin-bottom:10px">📊 本轮自动阶段汇报 <span style="color:#9caaba;font-weight:400">${mode}</span></div><div style="display:flex;gap:10px;flex-wrap:wrap"><span class="pill">自动请求 ${requested}</span><span class="pill" style="color:#9be7a6">VERIFIED ${verified}</span><span class="pill" style="color:${failed ? '#ffb4ab' : '#9be7a6'}">失败/未验证 ${failed}</span><span class="pill">延后人工复核 ${review}</span></div></div>`;
  for (const root of ['<main id="root"></main>', '<div id="root"></div>']) {
    if (html.includes(root)) return html.replace(root, `${banner}${root}`);
  }
  return html;
}

function renderCurrentReviewHtml(runDir, htmlFile, reviewFile) {
  const review = loadJson(reviewFile, null);
  if (review && typeof review === 'object' && Array.isArray(review.items)) {
    return decorateHtml(renderHtml(review), runDir);
  }
  if (fs.existsSync(htmlFile)) {
    return decorateHtml(fs.readFileSync(htmlFile, 'utf8'), runDir);
  }
  throw new Error('runDir 中的 review-center.json 无效，且没有可回退的 review-center.html');
}

function reviewRuntimeOwner(runDir) {
  const resolved = path.resolve(runDir || '.');
  const runsDir = path.dirname(resolved);
  const runtimeDir = path.dirname(runsDir);
  if (path.basename(runsDir).toLowerCase() !== 'runs') return '';
  if (path.basename(runtimeDir).toLowerCase() !== '.runtime') return '';
  return path.dirname(runtimeDir);
}

function reviewExecutionEnv(runDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const owner = reviewRuntimeOwner(runDir);
  if (!owner) return env;

  if (!env.MO2_BROWSER_ROOT) env.MO2_BROWSER_ROOT = path.join(owner, '.runtime', 'browser');
  if (!env.MO2_CDP_PORT) {
    const portState = loadJson(path.join(owner, '.runtime', 'state', 'browser-port.json'), {});
    const port = Number(portState?.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) env.MO2_CDP_PORT = String(port);
  }
  return env;
}

function compactProcessError(result) {
  const text = String(result?.stderr || result?.stdout || result?.errorCode || `exit=${result?.status ?? 'unknown'}`).trim();
  return text.split(/\r?\n/).filter(Boolean).slice(-8).join(' ').slice(-1400) || 'unknown prerequisite failure';
}

function ensureDownloadPrerequisites(config, runDir, runner = runNode) {
  if (!config?.modsDir) return { ok: false, stage: 'CONFIG', error: 'review-center-config 缺少 modsDir' };
  const env = reviewExecutionEnv(runDir);
  const steps = [
    { stage: 'BROWSER_START', args: [path.join(__dirname, 'browser-manager.js'), 'start'] },
    { stage: 'BROWSER_ASSERT', args: [path.join(__dirname, 'browser-manager.js'), 'assert'] },
    { stage: 'MO2_ENSURE', args: [path.join(__dirname, 'mo2-process-manager.js'), 'ensure', '--mods-dir', config.modsDir] },
  ];
  const completed = [];
  for (const step of steps) {
    const result = runner(step.args, { cwd: ROOT_DIR, capture: true, allowFailure: true, env });
    if (!result?.ok) {
      return {
        ok: false,
        stage: step.stage,
        status: result?.status ?? null,
        error: compactProcessError(result),
        completed,
        env,
      };
    }
    completed.push(step.stage);
  }
  return { ok: true, completed, env };
}

function tailFile(file, maxBytes = 5000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const size = stat.size - start;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, start);
    fs.closeSync(fd);
    return buffer.toString('utf8').slice(-maxBytes);
  } catch (_) {
    return '';
  }
}

async function main() {
  const rootDir = ROOT_DIR;
  const requested = argValue(process.argv, '--run', process.argv[2] || '');
  const runDir = requested ? path.resolve(requested) : findLatestReviewRun(rootDir);
  if (!runDir || !fs.existsSync(runDir)) throw new Error('找不到 Review Center 运行目录。先运行 pipeline，或使用 --run <runDir>。');
  const htmlFile = path.join(runDir, 'review-center.html');
  const reviewFile = path.join(runDir, 'review-center.json');
  const decisionsFile = path.join(runDir, 'review-decisions.json');
  const configFile = path.join(runDir, 'review-center-config.json');
  const logFile = path.join(runDir, 'review-download-launch.log');
  if (!fs.existsSync(reviewFile)) throw new Error('runDir 中没有 review-center.json，请先运行 pipeline/build-review-center');

  const token = crypto.randomBytes(24).toString('hex');
  let activeChild = null;
  let lastExit = null;
  const basePort = Math.max(1024, Number(argValue(process.argv, '--port', '3217')) || 3217);
  const shouldOpen = !process.argv.includes('--no-open');

  const jobSnapshot = () => ({
    activePid: activeChild && activeChild.exitCode === null ? activeChild.pid : null,
    latestJob: latestReviewJob(runDir),
    lastExit,
    launchLogTail: tailFile(logFile),
  });

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return json(res, 403, { error: 'LOOPBACK_ONLY' });
    const supplied = String(parsed.query.token || req.headers['x-review-token'] || '');
    if (supplied !== token) return json(res, 403, { error: 'BAD_REVIEW_TOKEN' });

    if (req.method === 'GET' && parsed.pathname === '/') {
      const body = Buffer.from(renderCurrentReviewHtml(runDir, htmlFile, reviewFile));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && parsed.pathname === '/api/state') {
      const decisions = loadJson(decisionsFile, { decisions: {} });
      return json(res, 200, { decisions, ...jobSnapshot() });
    }
    if (req.method === 'POST' && parsed.pathname === '/api/save') {
      try {
        const body = await readBody(req);
        const decisions = body.decisions && typeof body.decisions === 'object' ? body.decisions : {};
        saveJson(decisionsFile, { savedAt: new Date().toISOString(), decisions });
        return json(res, 200, { ok: true, saved: Object.keys(decisions).length, file: decisionsFile });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && parsed.pathname === '/api/download') {
      try {
        if (activeChild && activeChild.exitCode === null) return json(res, 409, { error: 'REVIEW_DOWNLOAD_ALREADY_RUNNING', pid: activeChild.pid });
        const body = await readBody(req);
        const decisions = body.decisions && typeof body.decisions === 'object' ? body.decisions : {};
        saveJson(decisionsFile, { savedAt: new Date().toISOString(), decisions });

        const config = loadJson(configFile, {});
        const prerequisites = ensureDownloadPrerequisites(config, runDir);
        if (!prerequisites.ok) {
          const error = `${prerequisites.stage}: ${prerequisites.error}`;
          lastExit = { at: new Date().toISOString(), code: null, stage: prerequisites.stage, error };
          return json(res, 503, { error, stage: prerequisites.stage });
        }

        const fd = fs.openSync(logFile, 'a');
        const childEnv = prerequisites.env || reviewExecutionEnv(runDir);
        activeChild = cp.spawn(process.execPath, [path.join(__dirname, 'review-download.js'), '--run', runDir, '--decisions', decisionsFile], {
          cwd: rootDir, env: childEnv, windowsHide: true, detached: false, stdio: ['ignore', fd, fd],
        });
        const launchedPid = activeChild.pid;
        lastExit = null;
        activeChild.on('exit', (code, signal) => {
          lastExit = { at: new Date().toISOString(), pid: launchedPid, code, signal: signal || null };
          try { fs.closeSync(fd); } catch (_) {}
        });
        return json(res, 202, { ok: true, jobId: `pid-${activeChild.pid}`, pid: activeChild.pid, prerequisites: prerequisites.completed });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && parsed.pathname === '/api/job') {
      return json(res, 200, jobSnapshot());
    }
    return json(res, 404, { error: 'NOT_FOUND' });
  });

  let port = basePort;
  await new Promise((resolve, reject) => {
    function tryListen() {
      const onError = err => {
        server.removeListener('listening', onListen);
        if (err.code === 'EADDRINUSE' && port < basePort + 20) { port++; setTimeout(tryListen, 20); }
        else reject(err);
      };
      const onListen = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, '127.0.0.1');
    }
    tryListen();
  });

  const target = `http://127.0.0.1:${port}/?token=${token}`;
  saveJson(path.join(runDir, 'review-server.json'), { startedAt: new Date().toISOString(), pid: process.pid, port, url: target, loopbackOnly: true });
  console.log(`Review Center: ${target}`);
  console.log(`runDir: ${runDir}`);
  if (shouldOpen) openDefault(target);
}

if (require.main === module) {
  main().catch(err => { console.error(`review-server failed: ${err.message}`); process.exit(1); });
}

module.exports = {
  findLatestReviewRun,
  decorateHtml,
  renderCurrentReviewHtml,
  reviewRuntimeOwner,
  reviewExecutionEnv,
  ensureDownloadPrerequisites,
  compactProcessError,
  tailFile,
};
