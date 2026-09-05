#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const url = require('url');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('INVALID_JSON')); } });
    req.on('error', reject);
  });
}
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function openDefault(target) {
  try {
    if (process.platform === 'win32') cp.spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') cp.spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {}
}
function latestJob(runDir) {
  const dir = path.join(runDir, 'review-jobs');
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).sort().reverse();
  for (const name of names) {
    const file = path.join(dir, name, 'job.json');
    if (!fs.existsSync(file)) continue;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }
  return null;
}
function findLatestReviewRun() {
  const runsDir = path.resolve(__dirname, '..', '.runtime', 'runs');
  if (!fs.existsSync(runsDir)) return '';
  const dirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => x.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const candidate = path.join(runsDir, name);
    if (fs.existsSync(path.join(candidate, 'review-center.html')) && fs.existsSync(path.join(candidate, 'review-center.json'))) return candidate;
  }
  return '';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function decorateHtml(html, runDir) {
  const reportFile = path.join(runDir, 'final-report.json');
  if (!fs.existsSync(reportFile)) return html;
  let r;
  try { r = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch (_) { return html; }
  const requested = Number(r.requested ?? r.downloadReady ?? r.download ?? 0) || 0;
  const verified = Number(r.verified ?? 0) || 0;
  const failed = Number(r.failed ?? Math.max(0, requested - verified)) || 0;
  const review = Number(r.humanReview ?? 0) || 0;
  const mode = esc(r.mode || 'AUDIT');
  const banner = `<div style="background:#171d24;border:1px solid #2b3541;border-radius:16px;padding:18px 20px;margin:0 0 18px"><div style="font-weight:700;margin-bottom:10px">📊 本轮自动阶段汇报 <span style="color:#9caaba;font-weight:400">${mode}</span></div><div style="display:flex;gap:10px;flex-wrap:wrap"><span class="pill">自动请求 ${requested}</span><span class="pill" style="color:#9be7a6">VERIFIED ${verified}</span><span class="pill" style="color:${failed ? '#ffb4ab' : '#9be7a6'}">失败/未验证 ${failed}</span><span class="pill">延后人工复核 ${review}</span></div></div>`;
  return html.replace('<div id="root"></div>', `${banner}<div id="root"></div>`);
}

async function main() {
  const requested = argValue('--run', process.argv[2] || '');
  const resolved = requested ? path.resolve(requested) : findLatestReviewRun();
  if (!resolved || !fs.existsSync(resolved)) throw new Error('找不到 Review Center 运行目录。先运行 pipeline，或使用 --run <runDir>。');
  const runDir = resolved;
  const htmlFile = path.join(runDir, 'review-center.html');
  const reviewFile = path.join(runDir, 'review-center.json');
  const decisionsFile = path.join(runDir, 'review-decisions.json');
  if (!fs.existsSync(htmlFile) || !fs.existsSync(reviewFile)) throw new Error('runDir 中没有 review-center.html/json，请先运行 pipeline/build-review-center');

  const token = crypto.randomBytes(24).toString('hex');
  let activeChild = null;
  const basePort = Math.max(1024, Number(argValue('--port', '3217')) || 3217);
  const shouldOpen = !process.argv.includes('--no-open');

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const remote = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return json(res, 403, { error: 'LOOPBACK_ONLY' });
    const supplied = String(parsed.query.token || req.headers['x-review-token'] || '');
    if (supplied !== token) return json(res, 403, { error: 'BAD_REVIEW_TOKEN' });

    if (req.method === 'GET' && parsed.pathname === '/') {
      const body = Buffer.from(decorateHtml(fs.readFileSync(htmlFile, 'utf8'), runDir));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && parsed.pathname === '/api/state') {
      let decisions = { decisions: {} };
      try { if (fs.existsSync(decisionsFile)) decisions = JSON.parse(fs.readFileSync(decisionsFile, 'utf8')); } catch (_) {}
      return json(res, 200, { decisions, activePid: activeChild && activeChild.exitCode === null ? activeChild.pid : null, latestJob: latestJob(runDir) });
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
        const logFile = path.join(runDir, 'review-download-launch.log');
        const fd = fs.openSync(logFile, 'a');
        activeChild = cp.spawn(process.execPath, [path.join(__dirname, 'review-download.js'), '--run', runDir, '--decisions', decisionsFile], {
          cwd: path.resolve(__dirname, '..'), windowsHide: true, detached: false, stdio: ['ignore', fd, fd],
        });
        activeChild.on('exit', () => { try { fs.closeSync(fd); } catch (_) {} });
        return json(res, 202, { ok: true, jobId: `pid-${activeChild.pid}`, pid: activeChild.pid, logFile });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && parsed.pathname === '/api/job') return json(res, 200, { activePid: activeChild && activeChild.exitCode === null ? activeChild.pid : null, latestJob: latestJob(runDir) });
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
      server.once('error', onError); server.once('listening', onListen); server.listen(port, '127.0.0.1');
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

module.exports = { findLatestReviewRun, decorateHtml };
