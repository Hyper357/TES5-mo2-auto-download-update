#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { loadJson, saveJson, writeText } = require('./lib/fs-json');
const { isActive, categoryRole } = require('./lib/file-selector');
const { buildReviewPayload } = require('./lib/review-center-model');

const assetDir = path.resolve(__dirname, '..', 'web', 'review');
const apiCacheDir = path.resolve(__dirname, '.api_cache');

function summarizeAutoReport(report) {
  if (!report) return null;
  const requested = Number(report.requested ?? report.downloadReady ?? report.download ?? 0) || 0;
  const verified = Number(report.verified ?? 0) || 0;
  return {
    mode: report.mode || 'AUDIT',
    requested,
    verified,
    failed: Number(report.failed ?? Math.max(0, requested - verified)) || 0,
    humanReview: Number(report.humanReview ?? 0) || 0,
  };
}

function cleanDescription(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function uploadedAt(file) {
  return Date.parse(file?.uploaded_time || file?.uploadedTime || '') || 0;
}

function compactNexusFile(file, item, recommendedIds = new Set()) {
  const fileId = String(file?.file_id ?? file?.fileId ?? '');
  const current = fileId && String(item.localFileId || '') === fileId;
  const active = file?.active === undefined ? isActive(file) : file.active !== false;
  return {
    modId: String(item.modId),
    fileId,
    name: file?.name || file?.file_name || file?.fileName || `File ${fileId}`,
    fileName: file?.file_name || file?.fileName || '',
    version: file?.version || '',
    category: file?.category_name || file?.category || categoryRole(file),
    role: file?.role || categoryRole(file),
    uploadedTime: file?.uploaded_time || file?.uploadedTime || '',
    description: cleanDescription(file?.description),
    current,
    recommended: recommendedIds.has(fileId),
    active,
    selectable: !!fileId && active && !current,
  };
}

function fallbackRecentFiles(item) {
  const out = [];
  const seen = new Set();
  const add = raw => {
    const modId = String(raw?.modId || item.modId || '');
    const fileId = String(raw?.fileId || '');
    if (!fileId || modId !== String(item.modId) || seen.has(fileId)) return;
    seen.add(fileId);
    out.push({
      modId,
      fileId,
      name: raw.name || raw.fileName || `File ${fileId}`,
      fileName: raw.fileName || '',
      version: raw.version || '',
      category: raw.category || raw.kind || 'Nexus file',
      role: raw.role || raw.kind || '',
      uploadedTime: raw.uploadedTime || '',
      description: cleanDescription(raw.description),
      current: !!raw.current || String(item.localFileId || '') === fileId,
      recommended: !!raw.recommended || String(item.targetMainFileId || '') === fileId,
      active: raw.active !== false,
      selectable: raw.selectable !== false && String(item.localFileId || '') !== fileId,
    });
  };

  for (const x of item.mainOptions || []) add(x);
  for (const family of item.componentFamilies || item.patchFamilies || []) {
    for (const x of family.candidates || []) add(x);
  }
  return out;
}

function recentNexusFilesForItem(item, { cacheDir = apiCacheDir, limit = 8 } = {}) {
  const recommendedIds = new Set([
    String(item.targetMainFileId || ''),
    ...(item.mainOptions || []).filter(x => x.recommended).map(x => String(x.fileId || '')),
  ].filter(Boolean));
  const forcedIds = new Set([String(item.localFileId || ''), ...recommendedIds].filter(Boolean));
  const cacheFile = path.join(cacheDir, `${item.modId}.json`);
  const data = loadJson(cacheFile, null);
  const files = Array.isArray(data?.files) ? data.files : [];

  if (!files.length) {
    return { source: 'REVIEW_CANDIDATES', files: fallbackRecentFiles(item) };
  }

  const active = files
    .filter(isActive)
    .sort((a, b) => uploadedAt(b) - uploadedAt(a) || Number(b.file_id || 0) - Number(a.file_id || 0));
  const chosen = active.slice(0, Math.max(1, Number(limit) || 8));
  const seen = new Set(chosen.map(x => String(x.file_id || '')));

  for (const id of forcedIds) {
    if (seen.has(id)) continue;
    const forced = files.find(x => String(x.file_id || '') === id);
    if (forced) {
      chosen.push(forced);
      seen.add(id);
    }
  }

  return {
    source: 'NEXUS_API_CACHE',
    files: chosen
      .map(x => compactNexusFile(x, item, recommendedIds))
      .filter(x => x.fileId),
  };
}

function enrichRecentNexusFiles(payload, options = {}) {
  for (const item of payload.items || []) {
    const recent = recentNexusFilesForItem(item, options);
    item.recentNexusFiles = recent.files;
    item.recentNexusFilesSource = recent.source;
  }
  return payload;
}

function renderHtml(payload) {
  const template = fs.readFileSync(path.join(assetDir, 'template.html'), 'utf8');
  const style = fs.readFileSync(path.join(assetDir, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(assetDir, 'app.js'), 'utf8');
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return template
    .replace('/*__STYLE__*/', style)
    .replace('__AUTO_MARKER__', payload.autoSummary ? 'data-auto-summary="embedded"' : '')
    .replace('__REVIEW_DATA__', data)
    .replace('/*__APP__*/', app);
}

function main() {
  const planFile = process.argv[2];
  const patchFile = process.argv[3];
  const closureFile = process.argv[4];
  const outJson = argValue(process.argv, '--out');
  const outHtml = argValue(process.argv, '--html');
  const autoReport = argValue(process.argv, '--auto-report', '');
  if (!planFile || !outJson || !outHtml) {
    console.error('Usage: node build-review-center.js <plan.json> [component-discovery.json] [closure.json] --out review-center.json --html review-center.html');
    process.exit(2);
  }

  const plan = loadJson(planFile, { items: [] });
  const discovery = loadJson(patchFile, { items: [] });
  const payload = enrichRecentNexusFiles(buildReviewPayload(
    plan,
    discovery,
    loadJson(closureFile, { items: [] }),
    {
      plan: planFile,
      componentDiscovery: patchFile || null,
      patchDiscovery: patchFile || null,
      closure: closureFile || null,
      environment: plan.environment || discovery.environment || null,
      environmentGraphFile: plan.environmentGraphFile || discovery.environmentFile || null,
      autoReport: autoReport || null,
      autoSummary: summarizeAutoReport(loadJson(autoReport, null)),
    }));

  saveJson(outJson, payload, { atomic: false });
  writeText(outHtml, renderHtml(payload));
  console.log(JSON.stringify({ items: payload.items.length, counts: payload.counts, environment: payload.environment, outJson, outHtml }, null, 2));
}

if (require.main === module) main();

module.exports = {
  renderHtml,
  summarizeAutoReport,
  recentNexusFilesForItem,
  enrichRecentNexusFiles,
};
