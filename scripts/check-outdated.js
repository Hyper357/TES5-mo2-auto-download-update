#!/usr/bin/env node
// High-precision update scan. v3.8 keeps v3.7 behavior while sharing API/cache infrastructure.

const fs = require('fs');
const path = require('path');
const { scanModsDirectory } = require('./lib/mo2-reader');
const ModProfile = require('./lib/profile');
const { categoryRole, groupLatestAuxFiles, selectUpdateTarget, tokenSimilarity } = require('./lib/file-selector');
const { detectVariantReview } = require('./lib/variant-review');
const { argValue, hasFlag } = require('./lib/cli');
const { saveJson } = require('./lib/fs-json');
const { readApiKey, createFilesClient } = require('./lib/nexus-api');

const modsDir = process.argv[2];
const keyArg = process.argv[3];
const asJson = hasFlag(process.argv, '--json');
const forceRefresh = hasFlag(process.argv, '--force-refresh') || hasFlag(process.argv, '--no-cache');
const outFile = argValue(process.argv, '--out', null);
const reportFile = argValue(process.argv, '--report', null);
const api = createFilesClient({
  cacheDir: path.join(__dirname, '.api_cache'),
  forceRefresh,
  maxSockets: 20,
});

function resolveInstalledFile(files, row) {
  const byArchive = row.instFile ? files.find(f => f.file_name === row.instFile) : null;
  if (byArchive) return { mine: byArchive, reason: 'installationFile' };

  const matches = (row.installedFiles || [])
    .map(fid => files.find(f => String(f.file_id) === String(fid)))
    .filter(Boolean);
  if (matches.length === 1) return { mine: matches[0], reason: 'single-fileId' };
  if (matches.length > 1) return { mine: null, reason: 'MULTI_SOURCE', candidates: matches };

  if (row.fileId) {
    const exact = files.find(f => String(f.file_id) === String(row.fileId));
    if (exact) return { mine: exact, reason: 'primary-fileId' };
  }
  return { mine: null, reason: 'UNRESOLVED_LOCAL_FILE' };
}

function likelyRelevantPatch(patch, allLocalNames) {
  const text = `${patch.name || ''} ${patch.file_name || ''}`;
  if (/\b(hotfix|critical fix|bug ?fix|修复)\b/i.test(text)) return { relevant: true, why: 'hotfix/fix' };
  let best = { score: 0, name: '' };
  for (const local of allLocalNames) {
    const score = tokenSimilarity(text, local);
    if (score > best.score) best = { score, name: local };
  }
  return best.score >= 0.34
    ? { relevant: true, why: `matches:${best.name}:${best.score.toFixed(2)}` }
    : { relevant: false, why: best.score ? `weak:${best.score.toFixed(2)}` : 'no-match' };
}

async function main() {
  if (!modsDir) {
    console.error('用法: node check-outdated.js <modsDir> [apiKeyFile] [--json] [--out manifest.tsv] [--report plan.json]');
    process.exit(1);
  }
  const apiKey = readApiKey(keyArg);
  if (!apiKey) {
    console.error('错误: 未找到 Nexus API key (请提供文件或设置 NEXUS_API_KEY 环境变量)');
    process.exit(1);
  }

  const rawMods = scanModsDirectory(modsDir);
  console.error(`rows=${rawMods.length}`);
  const profile = ModProfile.analyzeFromMods(rawMods);
  console.error(`[Profile] 平台=${profile.platform}(${profile.confidence.platform}), 身形=${profile.bodyType}(${profile.confidence.bodyType}), 纹理=${profile.textureTier}(${profile.confidence.textureTier})`);

  const allLocalNames = rawMods.map(m => `${m.folderName} ${m.installationFile || ''}`);
  const rows = rawMods.map(m => ({
    modId: String(m.modId),
    name: m.folderName,
    installedVersion: m.version,
    instFile: m.installationFile,
    fileId: m.installedFiles[0] ? String(m.installedFiles[0]) : null,
    installedFiles: m.installedFiles.map(String),
    fomodPlugins: m.fomodPlugins,
  }));

  const results = [];
  let cursor = 0;
  let apiFail = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const r = rows[i];
      if (i > 0 && i % 250 === 0) console.error(`progress ${i}/${rows.length}`);
      try {
        const data = await api.getFiles(r.modId, apiKey);
        const files = Array.isArray(data.files) ? data.files : [];
        if (!files.length) {
          results.push({ ...r, action: 'HOLD_NO_FILES', reason: 'NO_FILES', confidence: 'low' });
          continue;
        }

        const resolved = resolveInstalledFile(files, r);
        if (!resolved.mine) {
          results.push({
            ...r,
            action: resolved.reason === 'MULTI_SOURCE' ? 'HOLD_MULTI_SOURCE' : 'HOLD_UNRESOLVED_LOCAL',
            reason: resolved.reason,
            confidence: 'low',
            localCandidates: (resolved.candidates || []).map(f => ({ fileId: f.file_id, name: f.name, version: f.version })),
          });
          continue;
        }

        const mine = resolved.mine;
        const choice = selectUpdateTarget({ files, mine, localName: r.name, installationFile: r.instFile, profile });
        let action = choice.decision;
        if (action === 'DOWNLOAD' && choice.confidence !== 'high') action = 'HOLD_REVIEW';

        const variantReview = detectVariantReview({ files, mine, localNames: allLocalNames });
        const decisionNeedsMainChoice = !['SKIP_CURRENT', 'SKIP_DOWNGRADE'].includes(choice.decision);
        if (variantReview.required && (decisionNeedsMainChoice || variantReview.recommendedDifferentFromCurrent)) action = 'HOLD_VARIANT_REVIEW';

        const aux = groupLatestAuxFiles(files);
        const missingTranslations = aux.filter(f => categoryRole(f) === 'TRANSLATION' && !r.installedFiles.includes(String(f.file_id)));
        const relevantPatches = aux
          .filter(f => categoryRole(f) === 'PATCH' && !r.installedFiles.includes(String(f.file_id)))
          .map(f => ({ file: f, match: likelyRelevantPatch(f, allLocalNames) }))
          .filter(x => x.match.relevant);

        const target = choice.target || mine;
        const topCandidates = (choice.ranked || []).slice(0, 12).map(x => ({
          fileId: x.file.file_id,
          name: x.file.name,
          fileName: x.file.file_name || '',
          version: x.file.version,
          category: x.file.category_name,
          description: String(x.file.description || '').replace(/\s+/g, ' ').trim().slice(0, 800),
          score: x.score,
          similarity: x.similarity,
          reasons: x.reasons,
        }));

        const noteParts = [
          `decision=${choice.decision}`,
          `confidence=${choice.confidence}`,
          `local=${mine.file_id}:${mine.version || ''}`,
          `target=${target?.file_id || ''}:${target?.version || ''}`,
        ];
        if (choice.margin !== undefined) noteParts.push(`margin=${choice.margin}`);
        if (variantReview.required) noteParts.push(`variantReview=${variantReview.reason}`);
        if (missingTranslations.length) noteParts.push(`translationCandidates=${missingTranslations.map(f => f.file_id).join(',')}`);
        if (relevantPatches.length) noteParts.push(`patchCandidates=${relevantPatches.map(x => x.file.file_id).join(',')}`);

        results.push({
          ...r,
          localFileId: String(mine.file_id),
          localApiVersion: mine.version || '',
          localRole: categoryRole(mine),
          latestFileId: target ? String(target.file_id) : '',
          latestVersion: target?.version || '',
          latestName: target?.name || '',
          latestRole: target ? categoryRole(target) : '',
          action,
          reason: action === 'HOLD_VARIANT_REVIEW' ? 'MULTI_VARIANT_REVIEW' : choice.decision,
          confidence: choice.confidence,
          margin: choice.margin,
          sourceResolution: resolved.reason,
          note: noteParts.join('; '),
          manualReview: variantReview.required ? { type: 'MULTI_VARIANT', ...variantReview } : null,
          aux: {
            translations: missingTranslations.map(f => ({ fileId: f.file_id, name: f.name, version: f.version, category: f.category_name || '' })),
            patches: relevantPatches.map(x => ({ fileId: x.file.file_id, name: x.file.name, version: x.file.version, category: x.file.category_name || '', why: x.match.why })),
          },
          candidates: topCandidates,
        });
      } catch (err) {
        apiFail++;
        results.push({ ...r, action: 'HOLD_API_ERROR', reason: 'API_ERROR', confidence: 'low', error: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  results.sort((a, b) => Number(a.modId) - Number(b.modId) || a.name.localeCompare(b.name));

  const counts = {};
  for (const r of results) counts[r.action] = (counts[r.action] || 0) + 1;
  console.error(`done rows=${rows.length} apiFail=${apiFail} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (outFile) {
    const lines = results.map(o => [
      o.modId, o.latestName || o.name, o.latestVersion || '', o.note || o.reason || '', o.latestFileId || '', o.action || 'HOLD_REVIEW',
    ].join('\t'));
    fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    profile: {
      platform: profile.platform,
      bodyType: profile.bodyType,
      textureTier: profile.textureTier,
      confidence: profile.confidence,
      evidence: profile.evidence,
    },
    total: rows.length,
    apiFail,
    counts,
    items: results,
  };
  if (reportFile) saveJson(reportFile, payload, { atomic: false });
  if (asJson) console.log(JSON.stringify(payload, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
