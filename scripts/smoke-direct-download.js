#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { formatManifest } = require('./lib/manifest');
const { saveJson, writeText } = require('./lib/fs-json');
const { runNode } = require('./lib/process-runner');
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
const { ensureRunning } = require('./mo2-process-manager');
const {
  findGateClearedTarget,
  runtimeConfig,
  extractSignedNxm,
} = require('./smoke-download');

const rootDir = path.resolve(__dirname, '..');
const GAME_DOMAIN = 'skyrimspecialedition';
const MO2_GAME_NAME = 'SkyrimSE';

function verifyArchiveWith7z(archivePath, sevenzip) {
  const exe = sevenzip || (process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : '7z');
  const r = cp.spawnSync(exe, ['t', '-y', archivePath], {
    encoding: 'utf8', windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    output: `${r.stdout || ''}\n${r.stderr || ''}`.slice(-1200),
  };
}

async function verifyExact(row, cfg, smokeDir) {
  const manifest = path.join(smokeDir, 'target.tsv');
  writeText(manifest, formatManifest([{ ...row, action: 'DOWNLOAD' }]));
  const args = [path.join(rootDir, 'scripts', 'nexus-autodl.js'), 'verify', manifest, '--downloads', cfg.downloadsDir, '--json'];
  if (cfg.sevenzip) args.push('--sevenzip', cfg.sevenzip);
  const result = runNode(args, { cwd: rootDir, capture: true, allowFailure: true });
  if (!result.ok) return { ok: false, status: 'VERIFY_COMMAND_FAILED', stderr: result.stderr.slice(-1200) };
  try {
    const parsed = JSON.parse(result.stdout);
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    return { ok: item?.status === 'VERIFIED', ...item };
  } catch {
    return { ok: false, status: 'VERIFY_OUTPUT_INVALID' };
  }
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

async function main() {
  const modId = argValue(process.argv, '--mod-id', process.argv[2] || '');
  const requestedRun = argValue(process.argv, '--run', '');
  const timeoutSec = Number(argValue(process.argv, '--timeout-sec', '240')) || 240;
  if (!/^\d+$/.test(String(modId))) {
    throw new Error('用法: npm run smoke -- --mod-id <Nexus modId> [--run <runDir>]');
  }

  const target = findGateClearedTarget(modId, requestedRun);
  if (!target) {
    throw new Error(`SMOKE_TARGET_NOT_CLEARED: 找不到 modId=${modId} 的现有 closure=PASS DOWNLOAD 行；Smoke 不会绕过安全门禁。`);
  }
  const { runDir, row } = target;
  const cfg = runtimeConfig(runDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const smokeDir = path.join(rootDir, '.runtime', 'smoke', stamp);
  fs.mkdirSync(smokeDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    sourceRun: runDir,
    smokeDir,
    modId: row.modId,
    fileId: row.fileId,
    name: row.name,
    version: row.ver,
    gate: 'EXISTING_FINAL_MANIFEST_DOWNLOAD_ONLY',
    transport: 'DIRECT_NEXUS_CDN_TO_MO2_DOWNLOADS',
    mo2QueueUsed: false,
    requested: 0,
    published: 0,
    verified: 0,
  };

  const reportFile = path.join(smokeDir, 'smoke-report.json');
  const fail = (code, message) => {
    report.errorCode = code;
    report.error = message;
    report.finishedAt = new Date().toISOString();
    saveJson(reportFile, report, { atomic: false });
    const e = new Error(`${code}: ${message}`);
    e.code = code;
    throw e;
  };

  console.log('========================================================');
  console.log('🧪 MO2 ONE-MOD SMOKE — DIRECT CDN FALLBACK');
  console.log(`目标: ${row.modId}:${row.fileId} | ${row.name} | v${row.ver}`);
  console.log('路径: gate-cleared exact file → signed NXM token → Nexus download_link API → CDN → MO2 Downloads → .meta → VERIFIED');
  console.log('本轮不会把 NXM 交给 MO2 2.5.2 DownloadManager，避免 invalid download index 0。');
  console.log('========================================================');

  runNode([path.join(rootDir, 'scripts', 'browser-manager.js'), 'start'], { cwd: rootDir });
  runNode([path.join(rootDir, 'scripts', 'browser-manager.js'), 'assert'], { cwd: rootDir });
  await ensureRunning({ modsDir: cfg.modsDir });

  const before = scanExactDownload(cfg.downloadsDir, row.modId, row.fileId);
  report.before = { status: before.status };
  if (before.status === 'COMPLETE') {
    const verified = await verifyExact(row, cfg, smokeDir);
    report.published = 1;
    report.verify = verified;
    report.verified = verified.ok ? 1 : 0;
    report.finishedAt = new Date().toISOString();
    saveJson(reportFile, report, { atomic: false });
    console.log(JSON.stringify(report, null, 2));
    if (!verified.ok) fail('SMOKE_VERIFY_FAILED', verified.status || 'UNKNOWN');
    console.log(`\n✅ SMOKE PASS: ${row.modId}:${row.fileId} → VERIFIED=1`);
    return;
  }
  if (before.status === 'INFLIGHT') {
    fail('SMOKE_EXISTING_INFLIGHT', 'exact target already has an unfinished MO2 download record; do not create a second copy');
  }

  const apiKey = readApiKey(cfg.apiKeyFile);
  if (!apiKey) fail('NEXUS_API_KEY_MISSING', cfg.apiKeyFile);

  const api = createFilesClient({ cacheDir: path.join(smokeDir, 'api-cache'), forceRefresh: true, maxSockets: 2 });
  const filesDoc = await api.getFiles(row.modId, apiKey);
  const exact = (filesDoc.files || []).find(f => String(f.file_id) === String(row.fileId));
  if (!exact) fail('SMOKE_EXACT_FILE_NOT_FOUND', `${row.modId}:${row.fileId}`);
  if (Number(exact.category_id) === 7) fail('SMOKE_TARGET_ARCHIVED', `${row.modId}:${row.fileId}`);
  report.apiIdentity = {
    fileId: String(exact.file_id),
    name: exact.name || '',
    fileName: exact.file_name || '',
    version: exact.version || '',
    categoryId: exact.category_id,
    sizeInBytes: expectedBytes(exact),
  };

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: getCdpUrl(), defaultViewport: null });
  let signedNxm = '';
  try {
    signedNxm = await extractSignedNxm(browser, row.modId, row.fileId);
  } finally {
    await browser.disconnect().catch(() => {});
  }
  report.signedNxmExtracted = true;

  const token = parseSignedNxm(signedNxm, {
    expectedGame: GAME_DOMAIN,
    expectedModId: row.modId,
    expectedFileId: row.fileId,
  });
  report.signedIdentityValidated = true;
  report.requested = 1;

  const links = await getDownloadLinks({
    game: token.game,
    modId: token.modId,
    fileId: token.fileId,
    apiKey,
    key: token.key,
    expires: token.expires,
  });
  signedNxm = '';
  token.key = '';
  token.expires = '';
  report.downloadLinkCount = links.length;
  report.downloadServer = String(links[0].short_name || links[0].name || 'Nexus CDN').slice(0, 80);

  const payload = path.join(smokeDir, 'payload.download');
  const dl = await downloadFile(links[0].URI, payload, { timeoutMs: timeoutSec * 1000 });
  links.splice(0, links.length);
  report.downloadedBytes = dl.bytes;
  report.contentLength = dl.contentLength;

  const expected = expectedBytes(exact);
  if (expected && dl.bytes !== expected) {
    fail('CDN_SIZE_MISMATCH', `expected=${expected} actual=${dl.bytes}`);
  }
  if (dl.contentLength && dl.bytes !== dl.contentLength) {
    fail('CDN_CONTENT_LENGTH_MISMATCH', `contentLength=${dl.contentLength} actual=${dl.bytes}`);
  }

  const archiveCheck = verifyArchiveWith7z(payload, cfg.sevenzip);
  report.prePublishArchiveCheck = { ok: archiveCheck.ok, status: archiveCheck.status };
  if (!archiveCheck.ok) fail('CDN_ARCHIVE_INVALID', archiveCheck.output || '7-Zip test failed');

  const archiveName = fileNameForExact(exact, row);
  const metaText = buildMo2Meta({
    gameName: MO2_GAME_NAME,
    modId: row.modId,
    fileId: row.fileId,
    name: exact.name || row.name,
    modName: row.name,
    description: exact.description || '',
    version: exact.version || row.ver,
    fileCategory: exact.category_id || 0,
    category: 0,
  });
  const published = publishToMo2Downloads({
    sourcePath: payload,
    downloadsDir: cfg.downloadsDir,
    archiveName,
    fileId: row.fileId,
    metaText,
  });
  report.published = 1;
  report.archive = path.basename(published.finalPath);
  report.meta = path.basename(published.metaPath);

  const after = scanExactDownload(cfg.downloadsDir, row.modId, row.fileId);
  report.after = { status: after.status, size: after.primary?.archiveSize || 0 };
  if (after.status !== 'COMPLETE') {
    fail('DIRECT_PUBLISH_NOT_VISIBLE', `scanExactDownload=${after.status}`);
  }

  const verified = await verifyExact(row, cfg, smokeDir);
  report.verify = verified;
  report.verified = verified.ok ? 1 : 0;
  report.finishedAt = new Date().toISOString();
  saveJson(reportFile, report, { atomic: false });
  console.log(JSON.stringify(report, null, 2));
  if (!verified.ok) fail('SMOKE_VERIFY_FAILED', verified.status || 'UNKNOWN');

  console.log(`\n✅ SMOKE PASS: ${row.modId}:${row.fileId} → VERIFIED=1`);
  console.log(`MO2 Downloads: ${published.finalPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\n❌ SMOKE FAILED: ${String(err.message || err).replace(/nxm:\/\/[^\s]+/gi, '[SIGNED_NXM_REDACTED]').replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')}`);
    process.exit(1);
  });
}

module.exports = {
  verifyArchiveWith7z,
  expectedBytes,
  fileNameForExact,
};
