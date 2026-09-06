'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getCdpUrl } = require('./browser-session');
const { readApiKey, createFilesClient } = require('./nexus-api');
const { scanExactDownload } = require('./download-guard');
const {
  parseSignedNxm,
  getDownloadLinks,
  downloadFile,
  buildMo2Meta,
  choosePublishPath,
} = require('./direct-nexus-download');

const ROOT = path.resolve(__dirname, '..', '..');
const GAME_DOMAIN = 'skyrimspecialedition';
const MO2_GAME_NAME = 'SkyrimSE';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }
function elapsed(start) { return Math.max(0, nowMs() - start); }

function expectedBytes(exact) {
  const n = Number(exact?.size_in_bytes || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fileNameForExact(exact, row) {
  const fromApi = String(exact?.file_name || '').trim();
  if (fromApi) return fromApi;
  return `${String(row.name || 'nexus-download').replace(/[^a-z0-9._ -]+/gi, '_')}-${row.modId}-${row.fileId}.7z`;
}

function testArchive(archivePath, sevenzip) {
  const exe = sevenzip || (process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : '7z');
  const t0 = nowMs();
  const r = cp.spawnSync(exe, ['t', '-y', archivePath], { encoding: 'utf8', windowsHide: true });
  if (r.error && r.error.code === 'ENOENT') {
    const e = new Error(`SEVENZIP_NOT_FOUND: ${exe}`); e.code = 'SEVENZIP_NOT_FOUND'; throw e;
  }
  if (r.status !== 0) {
    const e = new Error(`ARCHIVE_TEST_FAILED: ${String(r.stderr || r.stdout || '').slice(-800)}`);
    e.code = 'ARCHIVE_TEST_FAILED'; throw e;
  }
  return elapsed(t0);
}

async function readSignedNxm(page) {
  return page.evaluate(() => {
    const visit = (node, depth) => {
      if (!node || depth > 16) return '';
      const elements = node.querySelectorAll ? [...node.querySelectorAll('*')] : [];
      for (const el of elements) {
        for (const attr of ['href', 'download-url', 'data-href']) {
          const value = el.getAttribute?.(attr) || '';
          if (String(value).startsWith('nxm://')) return value;
        }
        if (el.shadowRoot) {
          const nested = visit(el.shadowRoot, depth + 1);
          if (nested) return nested;
        }
      }
      return '';
    };
    return visit(document, 0);
  });
}

async function clickDownloadControl(page) {
  return page.evaluate(() => {
    const candidates = [];
    const visit = (node, depth) => {
      if (!node || depth > 16) return;
      const elements = node.querySelectorAll ? [...node.querySelectorAll('*')] : [];
      for (const el of elements) {
        if (el.matches?.('button,a')) {
          const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) candidates.push({ el, text });
        }
        if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      }
    };
    visit(document, 0);
    const ranked = [
      /^slow download$/i,
      /^mod manager download$/i,
      /download with.*manager/i,
      /slow download/i,
      /mod manager/i,
    ];
    for (const re of ranked) {
      const hit = candidates.find(x => re.test(x.text));
      if (hit) {
        hit.el.click();
        return hit.text.slice(0, 100);
      }
    }
    return '';
  });
}

async function extractSignedNxmFast(page, modId, fileId, { timeoutMs = 25000 } = {}) {
  let captured = '';
  const onRequest = req => {
    const u = String(req.url() || '');
    if (!captured && u.startsWith('nxm://')) captured = u;
  };
  page.on('request', onRequest);
  let clicked = false;
  try {
    const target = `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${modId}?tab=files&file_id=${fileId}&nmm=1`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (captured) return captured;
      const nxm = await readSignedNxm(page);
      if (nxm) return nxm;
      if (!clicked) {
        const control = await clickDownloadControl(page);
        if (control) clicked = true;
      }
      await sleep(clicked ? 120 : 160);
    }
    const e = new Error(clicked
      ? 'NXM_EXTRACT_FAILED: download control clicked but no signed nxm URL appeared'
      : 'NXM_DOWNLOAD_CONTROL_MISSING: no Slow download / Mod manager download control found');
    e.code = clicked ? 'NXM_EXTRACT_FAILED' : 'NXM_DOWNLOAD_CONTROL_MISSING';
    throw e;
  } finally {
    page.off('request', onRequest);
  }
}

async function createDirectSession({ apiKeyFile, cacheDir = path.join(ROOT, 'scripts', '.api_cache') } = {}) {
  const apiKey = readApiKey(apiKeyFile);
  if (!apiKey) {
    const e = new Error(`NEXUS_API_KEY_MISSING: ${apiKeyFile || ''}`); e.code = 'NEXUS_API_KEY_MISSING'; throw e;
  }
  const api = createFilesClient({ cacheDir, forceRefresh: false, maxSockets: 8, ttlMs: 6 * 3600 * 1000 });
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: getCdpUrl(), defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1450, height: 900 });
  return { apiKey, api, browser, page, cacheDir, createdAt: new Date().toISOString() };
}

async function closeDirectSession(session) {
  if (!session) return;
  try { await session.page?.close(); } catch (_) {}
  try { await session.browser?.disconnect(); } catch (_) {}
}

function atomicPublishFromSameVolume({ sourcePath, downloadsDir, archiveName, fileId, metaText }) {
  fs.mkdirSync(downloadsDir, { recursive: true });
  const finalPath = choosePublishPath(downloadsDir, archiveName, fileId);
  const metaTmp = `${finalPath}.meta.tmp-${process.pid}-${Date.now()}`;
  let moved = false;
  try {
    fs.writeFileSync(metaTmp, metaText, 'utf8');
    try {
      fs.renameSync(sourcePath, finalPath);
      moved = true;
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      fs.copyFileSync(sourcePath, finalPath, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(sourcePath);
      moved = true;
    }
    fs.renameSync(metaTmp, `${finalPath}.meta`);
    return { finalPath, metaPath: `${finalPath}.meta` };
  } catch (err) {
    try { if (fs.existsSync(metaTmp)) fs.unlinkSync(metaTmp); } catch (_) {}
    if (moved) { try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (_) {} }
    throw err;
  }
}

async function runDirectTarget({ row, downloads, sevenzip, timeoutSec = 600, session }) {
  if (!row?.modId || !row?.fileId) throw Object.assign(new Error('DIRECT_ROW_IDENTITY_MISSING'), { code: 'DIRECT_ROW_IDENTITY_MISSING' });
  if (!session?.api || !session?.apiKey || !session?.page) throw Object.assign(new Error('DIRECT_SESSION_MISSING'), { code: 'DIRECT_SESSION_MISSING' });

  const totalStart = nowMs();
  const timings = {};
  const before = scanExactDownload(downloads, row.modId, row.fileId);
  if (before.status === 'COMPLETE') {
    return { ok: true, status: 'ALREADY_PRESENT', modId: row.modId, fileId: row.fileId, timings: { totalMs: elapsed(totalStart) } };
  }
  if (before.status === 'INFLIGHT') {
    const e = new Error(`EXACT_INFLIGHT_EXISTS: ${row.modId}:${row.fileId}`); e.code = 'EXACT_INFLIGHT_EXISTS'; throw e;
  }

  let t = nowMs();
  const filesDoc = await session.api.getFiles(row.modId, session.apiKey);
  timings.filesApiMs = elapsed(t);
  const exact = (filesDoc.files || []).find(f => String(f.file_id) === String(row.fileId));
  if (!exact) { const e = new Error(`DIRECT_EXACT_FILE_NOT_FOUND: ${row.modId}:${row.fileId}`); e.code = 'DIRECT_EXACT_FILE_NOT_FOUND'; throw e; }
  if (Number(exact.category_id) === 7) { const e = new Error(`DIRECT_TARGET_ARCHIVED: ${row.modId}:${row.fileId}`); e.code = 'DIRECT_TARGET_ARCHIVED'; throw e; }

  t = nowMs();
  let signedNxm = await extractSignedNxmFast(session.page, row.modId, row.fileId);
  timings.signedNxmMs = elapsed(t);

  const token = parseSignedNxm(signedNxm, {
    expectedGame: GAME_DOMAIN, expectedModId: row.modId, expectedFileId: row.fileId,
  });
  signedNxm = '';

  t = nowMs();
  const links = await getDownloadLinks({
    game: token.game, modId: token.modId, fileId: token.fileId,
    apiKey: session.apiKey, key: token.key, expires: token.expires,
  });
  timings.downloadLinkApiMs = elapsed(t);
  token.key = ''; token.expires = '';

  const stagingRoot = path.join(path.dirname(downloads), '.tes5-auto-staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(stagingRoot, `${row.modId}-${row.fileId}-`));
  const payload = path.join(workDir, 'payload.download');
  try {
    t = nowMs();
    const dl = await downloadFile(links[0].URI, payload, { timeoutMs: Math.max(30, timeoutSec) * 1000 });
    timings.cdnMs = elapsed(t);
    links.splice(0, links.length);

    const expected = expectedBytes(exact);
    if (expected && dl.bytes !== expected) {
      const e = new Error(`CDN_SIZE_MISMATCH: expected=${expected} actual=${dl.bytes}`); e.code = 'CDN_SIZE_MISMATCH'; throw e;
    }
    if (dl.contentLength && dl.bytes !== dl.contentLength) {
      const e = new Error(`CDN_CONTENT_LENGTH_MISMATCH: expected=${dl.contentLength} actual=${dl.bytes}`); e.code = 'CDN_CONTENT_LENGTH_MISMATCH'; throw e;
    }

    timings.archiveTestMs = testArchive(payload, sevenzip);

    const metaText = buildMo2Meta({
      gameName: MO2_GAME_NAME, modId: row.modId, fileId: row.fileId,
      name: exact.name || row.name, modName: row.name,
      description: exact.description || '', version: exact.version || row.ver,
      fileCategory: exact.category_id || 0, category: 0,
    });

    t = nowMs();
    const published = atomicPublishFromSameVolume({
      sourcePath: payload, downloadsDir: downloads,
      archiveName: fileNameForExact(exact, row), fileId: row.fileId, metaText,
    });
    timings.publishMs = elapsed(t);

    t = nowMs();
    const after = scanExactDownload(downloads, row.modId, row.fileId);
    timings.diskVerifyMs = elapsed(t);
    if (after.status !== 'COMPLETE') {
      const e = new Error(`DIRECT_PUBLISH_NOT_VISIBLE: ${after.status}`); e.code = 'DIRECT_PUBLISH_NOT_VISIBLE'; throw e;
    }

    timings.totalMs = elapsed(totalStart);
    return {
      ok: true, status: 'PUBLISHED_VERIFIED', transport: 'DIRECT_NEXUS_CDN',
      modId: String(row.modId), fileId: String(row.fileId), name: row.name,
      bytes: dl.bytes, archive: path.basename(published.finalPath), archiveValidated: true,
      timings,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = {
  expectedBytes,
  fileNameForExact,
  extractSignedNxmFast,
  createDirectSession,
  closeDirectSession,
  runDirectTarget,
  atomicPublishFromSameVolume,
};
