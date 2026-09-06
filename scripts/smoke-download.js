#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { parseManifestText, formatManifest } = require('./lib/manifest');
const { listRunDirs } = require('./lib/runtime');
const { loadJson, saveJson, writeText } = require('./lib/fs-json');
const { runNode } = require('./lib/process-runner');
const { getCdpUrl } = require('./lib/browser-session');
const { readApiKey, createFilesClient } = require('./lib/nexus-api');
const { scanExactDownload } = require('./lib/download-guard');
const {
  configureDirectNxmTarget,
  launchNxmDirect,
  waitForExactHandoff,
  waitForExactComplete,
} = require('./lib/mo2-nxm');
const { ensureRunning } = require('./mo2-process-manager');

const rootDir = path.resolve(__dirname, '..');
const DOMAIN = 'skyrimspecialedition';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function gateClearedRow(runDir, modId) {
  const file = path.join(runDir, 'manifest-final.tsv');
  if (!fs.existsSync(file)) return null;
  const rows = parseManifestText(fs.readFileSync(file, 'utf8'));
  return rows.find(r => String(r.modId) === String(modId) && r.action === 'DOWNLOAD' && r.fileId) || null;
}

function findGateClearedTarget(modId, requestedRun = '') {
  const dirs = requestedRun ? [path.resolve(requestedRun)] : listRunDirs(rootDir);
  for (const runDir of dirs) {
    const row = gateClearedRow(runDir, modId);
    if (row) return { runDir, row };
  }
  return null;
}

function runtimeConfig(runDir) {
  const saved = loadJson(path.join(runDir, 'review-center-config.json'), {});
  return {
    modsDir: saved.modsDir || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods',
    downloadsDir: saved.downloadsDir || process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads',
    apiKeyFile: saved.apiKeyFile || process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key',
    sevenzip: saved.sevenzip || process.env.MO2_7Z || process.env.SEVENZIP || (process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : '7z'),
  };
}

function deepSnapshot(root) {
  const result = { nxm: '', buttons: [] };
  const visit = (node, depth) => {
    if (!node || depth > 16 || result.nxm) return;
    const elements = node.querySelectorAll ? [...node.querySelectorAll('*')] : [];
    for (const el of elements) {
      for (const attr of ['href', 'download-url', 'data-href']) {
        const value = el.getAttribute?.(attr) || '';
        if (String(value).startsWith('nxm://')) {
          result.nxm = value;
          return;
        }
      }
      if (el.matches?.('button,a')) {
        const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) result.buttons.push({ text: text.slice(0, 100), el });
      }
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      if (result.nxm) return;
    }
  };
  visit(root, 0);
  return result;
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

async function extractSignedNxm(browser, modId, fileId) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  let captured = '';
  const onRequest = req => {
    const u = String(req.url() || '');
    if (!captured && u.startsWith('nxm://')) captured = u;
  };
  page.on('request', onRequest);
  try {
    const target = `https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files&file_id=${fileId}&nmm=1`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(2500);

    let nxm = await readSignedNxm(page);
    if (nxm) return nxm;

    const clicked = await clickDownloadControl(page);
    if (!clicked) {
      const e = new Error('NXM_DOWNLOAD_CONTROL_MISSING: no Slow download / Mod manager download control found in light or shadow DOM');
      e.code = 'NXM_DOWNLOAD_CONTROL_MISSING';
      throw e;
    }

    for (let i = 0; i < 36; i++) {
      if (captured) return captured;
      nxm = await readSignedNxm(page);
      if (nxm) return nxm;
      await sleep(500);
    }
    const e = new Error('NXM_EXTRACT_FAILED: download control was clicked but no signed nxm URL appeared');
    e.code = 'NXM_EXTRACT_FAILED';
    throw e;
  } finally {
    page.off('request', onRequest);
    await page.close().catch(() => {});
  }
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

async function main() {
  const modId = argValue(process.argv, '--mod-id', process.argv[2] || '');
  const requestedRun = argValue(process.argv, '--run', '');
  const handoffTimeoutSec = Number(argValue(process.argv, '--handoff-timeout-sec', '25')) || 25;
  const timeoutSec = Number(argValue(process.argv, '--timeout-sec', '180')) || 180;
  if (!/^\d+$/.test(String(modId))) throw new Error('用法: npm run smoke -- --mod-id <Nexus modId> [--run <runDir>]');

  const target = findGateClearedTarget(modId, requestedRun);
  if (!target) throw new Error(`SMOKE_TARGET_NOT_CLEARED: 找不到 modId=${modId} 的现有 closure=PASS DOWNLOAD 行；Smoke 不会绕过安全门禁。`);
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
    requested: 0,
    handoffAccepted: false,
    verified: 0,
  };

  console.log('========================================================');
  console.log('🧪 MO2 ONE-MOD SMOKE');
  console.log(`目标: ${row.modId}:${row.fileId} | ${row.name} | v${row.ver}`);
  console.log(`证据来源: ${path.join(runDir, 'manifest-final.tsv')}`);
  console.log('验收: exact NXM → MO2 接受 → Downloads exact fileId → 7-Zip → VERIFIED=1');
  console.log('========================================================');

  runNode([path.join(rootDir, 'scripts', 'browser-manager.js'), 'start'], { cwd: rootDir });
  runNode([path.join(rootDir, 'scripts', 'browser-manager.js'), 'assert'], { cwd: rootDir });
  await ensureRunning({ modsDir: cfg.modsDir });

  const direct = configureDirectNxmTarget({ modsDir: cfg.modsDir, downloadsDir: cfg.downloadsDir });
  if (!direct.ok) throw new Error(`MO2_EXE_NOT_FOUND: modsDir=${cfg.modsDir}`);
  report.mo2Executable = direct.executable;

  const before = scanExactDownload(cfg.downloadsDir, row.modId, row.fileId);
  report.before = { status: before.status };
  if (before.status === 'COMPLETE') {
    const verified = await verifyExact(row, cfg, smokeDir);
    report.handoffAccepted = true;
    report.verified = verified.ok ? 1 : 0;
    report.verify = verified;
    saveJson(path.join(smokeDir, 'smoke-report.json'), report, { atomic: false });
    console.log(JSON.stringify(report, null, 2));
    if (!verified.ok) process.exitCode = 1;
    return;
  }
  if (before.status === 'INFLIGHT') {
    const complete = await waitForExactComplete({
      downloadsDir: cfg.downloadsDir, modId: row.modId, fileId: row.fileId,
      timeoutMs: timeoutSec * 1000,
    });
    report.handoffAccepted = true;
    report.complete = complete.complete;
    const verified = complete.complete ? await verifyExact(row, cfg, smokeDir) : { ok: false, status: complete.errorCode };
    report.verified = verified.ok ? 1 : 0;
    report.verify = verified;
    saveJson(path.join(smokeDir, 'smoke-report.json'), report, { atomic: false });
    console.log(JSON.stringify(report, null, 2));
    if (!verified.ok) process.exitCode = 1;
    return;
  }

  const apiKey = readApiKey(cfg.apiKeyFile);
  if (!apiKey) throw new Error(`NEXUS_API_KEY_MISSING: ${cfg.apiKeyFile}`);
  const api = createFilesClient({ cacheDir: path.join(smokeDir, 'api-cache'), forceRefresh: true, maxSockets: 2 });
  const filesDoc = await api.getFiles(row.modId, apiKey);
  const exact = (filesDoc.files || []).find(f => String(f.file_id) === String(row.fileId));
  if (!exact) throw new Error(`SMOKE_EXACT_FILE_NOT_FOUND: ${row.modId}:${row.fileId}`);
  if (Number(exact.category_id) === 7) throw new Error(`SMOKE_TARGET_ARCHIVED: ${row.modId}:${row.fileId}`);
  report.apiIdentity = { fileId: String(exact.file_id), name: exact.name || '', version: exact.version || '', categoryId: exact.category_id };

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: getCdpUrl(), defaultViewport: null });
  let nxm;
  try {
    nxm = await extractSignedNxm(browser, row.modId, row.fileId);
  } finally {
    await browser.disconnect().catch(() => {});
  }
  report.signedNxmExtracted = true;
  report.requested = 1;

  // Never print or persist the signed NXM query string. It is short-lived bearer data.
  await launchNxmDirect(direct.executable, nxm);
  nxm = null;

  const handoff = await waitForExactHandoff({
    downloadsDir: cfg.downloadsDir,
    modId: row.modId,
    fileId: row.fileId,
    timeoutMs: handoffTimeoutSec * 1000,
  });
  report.handoffAccepted = handoff.accepted;
  report.handoffState = handoff.state?.status || 'ABSENT';
  if (!handoff.accepted) {
    report.errorCode = 'NXM_HANDOFF_NOT_ACCEPTED';
    saveJson(path.join(smokeDir, 'smoke-report.json'), report, { atomic: false });
    console.log(JSON.stringify(report, null, 2));
    throw new Error('NXM_HANDOFF_NOT_ACCEPTED: ModOrganizer.exe returned, but exact modId:fileId never appeared in MO2 Downloads. Do not mark SUBMITTED.');
  }

  const complete = handoff.state.status === 'COMPLETE'
    ? { complete: true, state: handoff.state }
    : await waitForExactComplete({
      downloadsDir: cfg.downloadsDir,
      modId: row.modId,
      fileId: row.fileId,
      timeoutMs: timeoutSec * 1000,
    });
  report.complete = complete.complete;
  report.completeState = complete.state?.status || '';
  if (!complete.complete) {
    report.errorCode = complete.errorCode;
    saveJson(path.join(smokeDir, 'smoke-report.json'), report, { atomic: false });
    console.log(JSON.stringify(report, null, 2));
    throw new Error(`${complete.errorCode}: exact target was accepted but did not finish within ${timeoutSec}s`);
  }

  const verified = await verifyExact(row, cfg, smokeDir);
  report.verify = verified;
  report.verified = verified.ok ? 1 : 0;
  report.finishedAt = new Date().toISOString();
  saveJson(path.join(smokeDir, 'smoke-report.json'), report, { atomic: false });
  console.log(JSON.stringify(report, null, 2));
  if (!verified.ok) throw new Error(`SMOKE_VERIFY_FAILED: ${verified.status || 'UNKNOWN'}`);
  console.log(`\n✅ SMOKE PASS: ${row.modId}:${row.fileId} → VERIFIED=1`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\n❌ SMOKE FAILED: ${String(err.message || err).replace(/nxm:\/\/[^\s]+/gi, '[SIGNED_NXM_REDACTED]')}`);
    process.exit(1);
  });
}

module.exports = {
  gateClearedRow,
  findGateClearedTarget,
  runtimeConfig,
  extractSignedNxm,
};
