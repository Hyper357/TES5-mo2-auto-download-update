#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManifestText } = require('./lib/manifest');
const { argValue } = require('./lib/cli');
const { getCdpUrl } = require('./lib/browser-session');
const { readApiKey, createFilesClient } = require('./lib/nexus-api');
const { scanExactDownload } = require('./lib/download-guard');
const {
  parseSignedNxm,
  getDownloadLinks,
  downloadFile,
  buildMo2Meta,
  publishToMo2Downloads,
} = require('./lib/direct-nexus-download');
const { extractSignedNxm } = require('./smoke-download');

const ROOT = path.resolve(__dirname, '..');
const GAME_DOMAIN = 'skyrimspecialedition';
const MO2_GAME_NAME = 'SkyrimSE';

function safeMessage(value) {
  return String(value || '')
    .replace(/nxm:\/\/[^\s]+/gi, '[SIGNED_NXM_REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]');
}

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
  const r = cp.spawnSync(exe, ['t', '-y', archivePath], { encoding: 'utf8', windowsHide: true });
  if (r.error && r.error.code === 'ENOENT') {
    const e = new Error(`SEVENZIP_NOT_FOUND: ${exe}`); e.code = 'SEVENZIP_NOT_FOUND'; throw e;
  }
  if (r.status !== 0) {
    const e = new Error(`ARCHIVE_TEST_FAILED: ${String(r.stderr || r.stdout || '').slice(-800)}`);
    e.code = 'ARCHIVE_TEST_FAILED'; throw e;
  }
}

function readOneRow(manifest) {
  const rows = parseManifestText(fs.readFileSync(manifest, 'utf8'))
    .filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  if (rows.length !== 1) {
    const e = new Error(`DIRECT_ONE_REQUIRES_ONE_DOWNLOAD_ROW: got=${rows.length}`);
    e.code = 'DIRECT_ONE_REQUIRES_ONE_DOWNLOAD_ROW';
    throw e;
  }
  return rows[0];
}

async function runDirectOne({ manifest, downloads, apiKeyFile, sevenzip, timeoutSec = 600 }) {
  const row = readOneRow(manifest);
  const before = scanExactDownload(downloads, row.modId, row.fileId);
  if (before.status === 'COMPLETE') {
    return { ok: true, status: 'ALREADY_PRESENT', modId: row.modId, fileId: row.fileId, archive: path.basename(before.primary.archivePath || '') };
  }
  if (before.status === 'INFLIGHT') {
    const e = new Error(`EXACT_INFLIGHT_EXISTS: ${row.modId}:${row.fileId}`);
    e.code = 'EXACT_INFLIGHT_EXISTS';
    throw e;
  }

  const apiKey = readApiKey(apiKeyFile);
  if (!apiKey) { const e = new Error(`NEXUS_API_KEY_MISSING: ${apiKeyFile}`); e.code = 'NEXUS_API_KEY_MISSING'; throw e; }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `tes5-direct-${row.modId}-${row.fileId}-`));
  try {
    const api = createFilesClient({ cacheDir: path.join(workDir, 'api-cache'), forceRefresh: true, maxSockets: 2 });
    const filesDoc = await api.getFiles(row.modId, apiKey);
    const exact = (filesDoc.files || []).find(f => String(f.file_id) === String(row.fileId));
    if (!exact) { const e = new Error(`DIRECT_EXACT_FILE_NOT_FOUND: ${row.modId}:${row.fileId}`); e.code = 'DIRECT_EXACT_FILE_NOT_FOUND'; throw e; }
    if (Number(exact.category_id) === 7) { const e = new Error(`DIRECT_TARGET_ARCHIVED: ${row.modId}:${row.fileId}`); e.code = 'DIRECT_TARGET_ARCHIVED'; throw e; }

    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.connect({ browserURL: getCdpUrl(), defaultViewport: null });
    let signedNxm = '';
    try { signedNxm = await extractSignedNxm(browser, row.modId, row.fileId); }
    finally { await browser.disconnect().catch(() => {}); }

    const token = parseSignedNxm(signedNxm, {
      expectedGame: GAME_DOMAIN, expectedModId: row.modId, expectedFileId: row.fileId,
    });
    const links = await getDownloadLinks({
      game: token.game, modId: token.modId, fileId: token.fileId,
      apiKey, key: token.key, expires: token.expires,
    });
    signedNxm = ''; token.key = ''; token.expires = '';

    const payload = path.join(workDir, 'payload.download');
    const dl = await downloadFile(links[0].URI, payload, { timeoutMs: Math.max(30, timeoutSec) * 1000 });
    links.splice(0, links.length);
    const expected = expectedBytes(exact);
    if (expected && dl.bytes !== expected) {
      const e = new Error(`CDN_SIZE_MISMATCH: expected=${expected} actual=${dl.bytes}`); e.code = 'CDN_SIZE_MISMATCH'; throw e;
    }
    if (dl.contentLength && dl.bytes !== dl.contentLength) {
      const e = new Error(`CDN_CONTENT_LENGTH_MISMATCH: expected=${dl.contentLength} actual=${dl.bytes}`); e.code = 'CDN_CONTENT_LENGTH_MISMATCH'; throw e;
    }
    testArchive(payload, sevenzip);

    const metaText = buildMo2Meta({
      gameName: MO2_GAME_NAME, modId: row.modId, fileId: row.fileId,
      name: exact.name || row.name, modName: row.name,
      description: exact.description || '', version: exact.version || row.ver,
      fileCategory: exact.category_id || 0, category: 0,
    });
    const published = publishToMo2Downloads({
      sourcePath: payload, downloadsDir: downloads,
      archiveName: fileNameForExact(exact, row), fileId: row.fileId, metaText,
    });
    const after = scanExactDownload(downloads, row.modId, row.fileId);
    if (after.status !== 'COMPLETE') {
      const e = new Error(`DIRECT_PUBLISH_NOT_VISIBLE: ${after.status}`); e.code = 'DIRECT_PUBLISH_NOT_VISIBLE'; throw e;
    }
    return {
      ok: true, status: 'PUBLISHED', transport: 'DIRECT_NEXUS_CDN',
      modId: row.modId, fileId: row.fileId, name: row.name,
      bytes: dl.bytes, archive: path.basename(published.finalPath),
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function main() {
  const manifest = process.argv[2];
  if (!manifest) throw new Error('用法: node direct-download-one.js <one.tsv> --downloads DIR --api-key-file FILE [--sevenzip PATH]');
  const downloads = argValue(process.argv, '--downloads', process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads');
  const apiKeyFile = argValue(process.argv, '--api-key-file', process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key');
  const sevenzip = argValue(process.argv, '--sevenzip', process.env.MO2_7Z || process.env.SEVENZIP || '');
  const timeoutSec = Number(argValue(process.argv, '--timeout-sec', '600')) || 600;
  const result = await runDirectOne({ manifest: path.resolve(manifest), downloads: path.resolve(downloads), apiKeyFile: path.resolve(apiKeyFile), sevenzip, timeoutSec });
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch(err => {
    console.error(`DIRECT_DOWNLOAD_FAILED ${err.code || 'UNKNOWN'} ${safeMessage(err.message)}`);
    process.exit(1);
  });
}

module.exports = { readOneRow, expectedBytes, fileNameForExact, runDirectOne, safeMessage };
