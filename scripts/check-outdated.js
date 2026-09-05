#!/usr/bin/env node
// High-precision update scan. v4.1 adds an Update Eligibility Gate before Main/Component decisions.

const fs = require('fs');
const path = require('path');
const { scanModsDirectory } = require('./lib/mo2-reader');
const ModProfile = require('./lib/profile');
const { categoryRole, isActive, hardVariantConflicts, groupLatestAuxFiles, selectUpdateTarget, tokenSimilarity } = require('./lib/file-selector');
const { detectVariantReview, branchKey } = require('./lib/variant-review');
const { compareVersions } = require('./lib/semver');
const { argValue, hasFlag } = require('./lib/cli');
const { saveJson } = require('./lib/fs-json');
const { readApiKey, createFilesClient } = require('./lib/nexus-api');
const { defaultPolicyFile, loadVariantPolicies, getVariantPolicy, resolveVariantPolicy } = require('./lib/variant-policy');
const { classifyComponent, componentFamily } = require('./lib/component-discovery');
const { buildEnvironmentGraph, enabledContextNames, compactEnvironmentSummary, normalizeName } = require('./lib/mo2-environment');
const { assessUpdateEligibility, eligibilityCounts } = require('./lib/update-eligibility');

const rootDir = path.resolve(__dirname, '..');
const modsDir = process.argv[2];
const keyArg = process.argv[3];
const asJson = hasFlag(process.argv, '--json');
const forceRefresh = hasFlag(process.argv, '--force-refresh') || hasFlag(process.argv, '--no-cache');
const outFile = argValue(process.argv, '--out', null);
const reportFile = argValue(process.argv, '--report', null);
const environmentOut = argValue(process.argv, '--environment-out', reportFile ? path.join(path.dirname(reportFile), 'mo2-environment.json') : '');
const policyFile = defaultPolicyFile(rootDir);
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

function newestInPolicyBranch(files, wantedBranch) {
  const list = (files || [])
    .filter(f => isActive(f) && categoryRole(f) === 'MAIN' && branchKey(f) === wantedBranch)
    .sort((a, b) => {
      const v = compareVersions(b.version || '', a.version || '');
      if (v !== 0) return v;
      const bt = Date.parse(b.uploaded_time || '') || 0;
      const at = Date.parse(a.uploaded_time || '') || 0;
      if (bt !== at) return bt - at;
      return Number(b.file_id || 0) - Number(a.file_id || 0);
    });
  return list[0] || null;
}

function choiceFromPolicy(mine, target, policy) {
  if (!target) return { decision: 'HOLD_VARIANT_POLICY_CHANGED', confidence: 'low', target: null, margin: null, ranked: [] };
  if (String(target.file_id) === String(mine.file_id)) {
    return { decision: 'SKIP_CURRENT', confidence: 'high', target: mine, margin: 999, ranked: [] };
  }
  const cmp = compareVersions(target.version || '', mine.version || '');
  if (cmp < 0) return { decision: 'SKIP_DOWNGRADE', confidence: 'high', target: mine, margin: 999, ranked: [] };

  const localBranch = branchKey(mine);
  if (cmp === 0 && localBranch === policy.branchKey) {
    return { decision: 'HOLD_SAME_VERSION_REPLACEMENT', confidence: 'medium', target, margin: 999, ranked: [] };
  }
  return { decision: 'DOWNLOAD', confidence: 'high', target, margin: 999, ranked: [] };
}

function choiceFromEligibility(files, mine, eligibility, selectorChoice) {
  const targetId = String(eligibility?.target?.fileId || '');
  const exactTarget = targetId ? files.find(f => String(f.file_id || '') === targetId) : null;
  if (!exactTarget) return selectorChoice;

  if (eligibility.reason === 'NEXUS_EXACT_UPDATE_CHAIN') {
    return {
      decision: 'DOWNLOAD',
      confidence: 'high',
      target: exactTarget,
      margin: 999,
      ranked: selectorChoice.ranked || [],
      source: 'UPDATE_ELIGIBILITY_CHAIN',
    };
  }

  const selectorTargetId = String(selectorChoice?.target?.file_id || '');
  if (selectorTargetId && selectorTargetId !== targetId) {
    return {
      decision: 'HOLD_UPDATE_TARGET_DIVERGENCE',
      confidence: 'low',
      target: exactTarget,
      margin: selectorChoice.margin ?? null,
      ranked: selectorChoice.ranked || [],
      source: 'UPDATE_ELIGIBILITY_DIVERGENCE',
    };
  }
  return selectorChoice;
}

function samePageComponents(files, target, installedFileIds, mainName) {
  const installed = new Set((installedFileIds || []).map(String));
  const targetId = String(target?.file_id || '');
  const out = [];
  for (const f of files || []) {
    if (!isActive(f)) continue;
    const fileId = String(f.file_id || '');
    if (!fileId || fileId === targetId || installed.has(fileId)) continue;
    if (categoryRole(f) === 'MAIN') continue;
    const text = `${f.name || ''} ${f.file_name || ''} ${f.description || ''} ${f.category_name || ''}`;
    const kind = classifyComponent(text, { source: 'SAME_PAGE_FILE' });
    if (!kind) continue;
    out.push({
      kind,
      family: componentFamily(kind, text, mainName),
      fileId,
      version: f.version || '',
      name: f.name || f.file_name || '',
      fileName: f.file_name || '',
      category: f.category_name || '',
      description: String(f.description || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      uploadedTime: f.uploaded_time || '',
    });
  }
  return out;
}

function compactEligibilitySkip(r, mine, eligibility, resolvedReason) {
  const target = eligibility.target || null;
  const note = [
    `updateEligibility=${eligibility.status}:${eligibility.reason}`,
    `priority=${eligibility.priority || 0}`,
    `mo2Signal=${eligibility.mo2?.signal ? 'YES' : 'NO'}:${eligibility.mo2?.reason || 'UNKNOWN'}`,
    `local=${mine?.file_id || ''}:${mine?.version || ''}`,
    `target=${target?.fileId || mine?.file_id || ''}:${target?.version || mine?.version || ''}`,
  ].join('; ');
  return {
    ...r,
    localFileId: String(mine?.file_id || ''),
    localApiVersion: mine?.version || '',
    localRole: mine ? categoryRole(mine) : '',
    latestFileId: target?.fileId || String(mine?.file_id || ''),
    latestVersion: target?.version || mine?.version || '',
    latestName: target?.name || mine?.name || r.name,
    latestRole: target?.role || (mine ? categoryRole(mine) : ''),
    action: eligibility.status,
    reason: eligibility.reason,
    confidence: eligibility.status === 'SKIP_METADATA_FALSE_POSITIVE' || eligibility.status === 'SKIP_UP_TO_DATE' ? 'high' : 'medium',
    sourceResolution: resolvedReason,
    note,
    updateEligibility: eligibility,
    manualReview: eligibility.status === 'HOLD_UPDATE_ELIGIBILITY' ? { type: 'UPDATE_ELIGIBILITY', required: true, reason: eligibility.reason } : null,
    aux: { translations: [], patches: [], components: [] },
    candidates: eligibility.candidates || [],
  };
}

async function main() {
  if (!modsDir) {
    console.error('用法: node check-outdated.js <modsDir> [apiKeyFile] [--json] [--out manifest.tsv] [--report plan.json] [--environment-out mo2-environment.json]');
    process.exit(1);
  }
  const apiKey = readApiKey(keyArg);
  if (!apiKey) {
    console.error('错误: 未找到 Nexus API key (请提供文件或设置 NEXUS_API_KEY 环境变量)');
    process.exit(1);
  }

  const policies = loadVariantPolicies(policyFile);
  const rawMods = scanModsDirectory(modsDir);
  const environment = buildEnvironmentGraph({ modsDir });
  if (environmentOut) saveJson(environmentOut, environment, { atomic: false });
  const envByName = new Map((environment.mods || []).map(x => [normalizeName(x.name), x]));
  const enabledRawMods = environment.profile?.usableForApplicability
    ? rawMods.filter(m => envByName.get(normalizeName(m.folderName))?.state === 'ENABLED')
    : rawMods;

  console.error(`rows=${rawMods.length}`);
  console.error(`[MO2 Environment] profile=${environment.profile?.name || 'UNRESOLVED'} source=${environment.profile?.source || 'UNKNOWN'} enabled=${environment.summary?.enabledMods || 0} disabled=${environment.summary?.disabledMods || 0}`);
  const profile = ModProfile.analyzeFromMods(enabledRawMods);
  console.error(`[Profile] 平台=${profile.platform}(${profile.confidence.platform}), 身形=${profile.bodyType}(${profile.confidence.bodyType}), 纹理=${profile.textureTier}(${profile.confidence.textureTier})`);

  const activeContext = enabledContextNames(environment);
  const allLocalNames = activeContext.length
    ? activeContext
    : rawMods.map(m => `${m.folderName} ${m.installationFile || ''}`);
  const rows = rawMods.map(m => {
    const envMod = envByName.get(normalizeName(m.folderName));
    return {
      modId: String(m.modId),
      name: m.folderName,
      installedVersion: m.version,
      newestVersion: m.newestVersion || '',
      ignoredVersion: m.ignoredVersion || '',
      nexusFileStatus: Number(m.nexusFileStatus || 0),
      lastNexusQuery: m.lastNexusQuery || '',
      lastNexusUpdate: m.lastNexusUpdate || '',
      nexusLastModified: m.nexusLastModified || '',
      instFile: m.installationFile,
      fileId: m.installedFiles[0] ? String(m.installedFiles[0]) : null,
      installedFiles: m.installedFiles.map(String),
      fomodPlugins: m.fomodPlugins,
      profileState: envMod?.state || (environment.profile?.usableForApplicability ? 'UNLISTED' : 'UNKNOWN'),
    };
  });

  // Yellow-arrow-equivalent entries are queried first. This affects latency, not truth.
  rows.sort((a, b) => {
    const aSignal = a.ignoredVersion && a.newestVersion && compareVersions(a.ignoredVersion, a.newestVersion) === 0
      ? 0 : ((a.newestVersion && compareVersions(a.installedVersion, a.newestVersion) < 0) || ![1,2,3,5].includes(Number(a.nexusFileStatus)) ? 1 : 0);
    const bSignal = b.ignoredVersion && b.newestVersion && compareVersions(b.ignoredVersion, b.newestVersion) === 0
      ? 0 : ((b.newestVersion && compareVersions(b.installedVersion, b.newestVersion) < 0) || ![1,2,3,5].includes(Number(b.nexusFileStatus)) ? 1 : 0);
    return bSignal - aSignal || Number(a.modId) - Number(b.modId);
  });

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
        const fileUpdates = Array.isArray(data.file_updates) ? data.file_updates : (Array.isArray(data.fileUpdates) ? data.fileUpdates : []);
        if (!files.length) {
          results.push({ ...r, action: 'HOLD_NO_FILES', reason: 'NO_FILES', confidence: 'low', updateEligibility: { status: 'HOLD_UPDATE_ELIGIBILITY', reason: 'NO_NEXUS_FILES', priority: 40 } });
          continue;
        }

        const resolved = resolveInstalledFile(files, r);
        if (!resolved.mine) {
          const eligibility = {
            status: 'HOLD_UPDATE_ELIGIBILITY',
            reason: resolved.reason === 'MULTI_SOURCE' ? 'LOCAL_MULTI_SOURCE_IDENTITY' : 'LOCAL_FILE_IDENTITY_UNRESOLVED',
            updateNeeded: false,
            priority: 65,
            mo2: null,
            target: null,
            evidence: [],
          };
          results.push({
            ...r,
            action: 'HOLD_UPDATE_ELIGIBILITY',
            reason: eligibility.reason,
            confidence: 'low',
            updateEligibility: eligibility,
            localCandidates: (resolved.candidates || []).map(f => ({ fileId: f.file_id, name: f.name, version: f.version })),
            manualReview: { type: 'UPDATE_ELIGIBILITY', required: true, reason: eligibility.reason },
          });
          continue;
        }

        const mine = resolved.mine;
        const updateEligibility = assessUpdateEligibility({
          files,
          fileUpdates,
          mine,
          meta: r,
          localName: r.name,
          installationFile: r.instFile,
          profile,
        });

        if (!updateEligibility.updateNeeded) {
          results.push(compactEligibilitySkip(r, mine, updateEligibility, resolved.reason));
          continue;
        }

        const selectorChoice = selectUpdateTarget({ files, mine, localName: r.name, installationFile: r.instFile, profile });
        const baseChoice = choiceFromEligibility(files, mine, updateEligibility, selectorChoice);
        const variantReview = detectVariantReview({ files, mine, localNames: allLocalNames });
        const rememberedPolicy = getVariantPolicy(policies, r.modId);
        const policyResolution = resolveVariantPolicy(variantReview, rememberedPolicy);

        let choice = baseChoice;
        let action = choice.decision;
        let policyTarget = null;
        let policyConflicts = [];
        let policyIssueCode = null;

        if (rememberedPolicy) {
          policyTarget = newestInPolicyBranch(files, rememberedPolicy.branchKey);
          const stable = rememberedPolicy.branchKey && rememberedPolicy.branchKey !== 'GENERIC';
          if (!stable) {
            action = 'HOLD_VARIANT_POLICY_CHANGED';
            policyIssueCode = 'VARIANT_POLICY_UNSTABLE';
          } else if (!policyTarget || ['CHANGED', 'AMBIGUOUS', 'UNUSABLE'].includes(policyResolution.status)) {
            action = 'HOLD_VARIANT_POLICY_CHANGED';
            policyIssueCode = policyResolution.code || 'VARIANT_POLICY_CHANGED';
          } else {
            const localText = `${r.name} ${r.instFile || ''} ${mine.name || ''} ${mine.file_name || ''}`;
            const candidateText = `${policyTarget.name || ''} ${policyTarget.file_name || ''}`;
            policyConflicts = hardVariantConflicts(localText, candidateText, profile);
            if (policyConflicts.length) {
              action = 'HOLD_VARIANT_POLICY_CHANGED';
              policyIssueCode = 'VARIANT_POLICY_ENVIRONMENT_CONFLICT';
            } else {
              choice = choiceFromPolicy(mine, policyTarget, rememberedPolicy);
              action = choice.decision;
            }
          }
        } else {
          if (action === 'DOWNLOAD' && choice.confidence !== 'high') action = 'HOLD_REVIEW';
          const exactChainProvedBranch = updateEligibility.reason === 'NEXUS_EXACT_UPDATE_CHAIN';
          const decisionNeedsMainChoice = !['SKIP_CURRENT', 'SKIP_DOWNGRADE'].includes(choice.decision);
          if (!exactChainProvedBranch && variantReview.required && (decisionNeedsMainChoice || variantReview.recommendedDifferentFromCurrent)) action = 'HOLD_VARIANT_REVIEW';
        }

        if (action === 'HOLD_UPDATE_TARGET_DIVERGENCE') {
          results.push({
            ...compactEligibilitySkip(r, mine, { ...updateEligibility, status: 'HOLD_UPDATE_ELIGIBILITY', reason: 'ELIGIBILITY_SELECTOR_TARGET_DIVERGENCE', updateNeeded: false }, resolved.reason),
            candidates: (selectorChoice.ranked || []).slice(0, 8).map(x => ({ fileId: x.file.file_id, name: x.file.name, version: x.file.version, score: x.score, reasons: x.reasons })),
          });
          continue;
        }

        const aux = groupLatestAuxFiles(files);
        const missingTranslations = aux.filter(f => categoryRole(f) === 'TRANSLATION' && !r.installedFiles.includes(String(f.file_id)));
        const relevantPatches = aux
          .filter(f => categoryRole(f) === 'PATCH' && !r.installedFiles.includes(String(f.file_id)))
          .map(f => ({ file: f, match: likelyRelevantPatch(f, allLocalNames) }))
          .filter(x => x.match.relevant);

        const target = choice.target || mine;
        const components = samePageComponents(files, target, r.installedFiles, target?.name || r.name);
        const topCandidates = (selectorChoice.ranked || []).slice(0, 12).map(x => ({
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
          `updateEligibility=${updateEligibility.status}:${updateEligibility.reason}`,
          `updatePriority=${updateEligibility.priority}`,
          `mo2Signal=${updateEligibility.mo2?.signal ? 'YES' : 'NO'}:${updateEligibility.mo2?.reason || 'UNKNOWN'}`,
          `decision=${choice.decision}`,
          `confidence=${choice.confidence}`,
          `profileState=${r.profileState}`,
          `local=${mine.file_id}:${mine.version || ''}`,
          `target=${target?.file_id || ''}:${target?.version || ''}`,
        ];
        if (choice.margin !== undefined && choice.margin !== null) noteParts.push(`margin=${choice.margin}`);
        if (variantReview.required) noteParts.push(`variantReview=${variantReview.reason}`);
        if (rememberedPolicy) noteParts.push(`variantPolicy=${rememberedPolicy.branchKey}:${policyResolution.status}`);
        if (policyIssueCode) noteParts.push(`variantPolicyIssue=${policyIssueCode}`);
        if (policyConflicts.length) noteParts.push(`variantPolicyConflicts=${policyConflicts.join(',')}`);
        if (missingTranslations.length) noteParts.push(`translationCandidates=${missingTranslations.map(f => f.file_id).join(',')}`);
        if (relevantPatches.length) noteParts.push(`patchCandidates=${relevantPatches.map(x => x.file.file_id).join(',')}`);
        if (components.length) noteParts.push(`componentCandidates=${components.map(x => `${x.kind}:${x.fileId}`).join(',')}`);

        const manualReviewRequired = action === 'HOLD_VARIANT_REVIEW' || action === 'HOLD_VARIANT_POLICY_CHANGED';
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
          reason: action === 'HOLD_VARIANT_REVIEW' ? 'MULTI_VARIANT_REVIEW' : (action === 'HOLD_VARIANT_POLICY_CHANGED' ? (policyIssueCode || policyResolution.code || 'VARIANT_POLICY_CHANGED') : choice.decision),
          confidence: choice.confidence,
          margin: choice.margin,
          sourceResolution: resolved.reason,
          note: noteParts.join('; '),
          updateEligibility,
          variantPolicy: rememberedPolicy ? {
            branchKey: rememberedPolicy.branchKey,
            lastConfirmedFileId: rememberedPolicy.lastConfirmedFileId || '',
            lastConfirmedVersion: rememberedPolicy.lastConfirmedVersion || '',
            lastConfirmedName: rememberedPolicy.lastConfirmedName || '',
            resolution: policyResolution.status,
            targetFileId: policyTarget ? String(policyTarget.file_id) : '',
            conflicts: policyConflicts,
          } : null,
          manualReview: manualReviewRequired ? {
            ...variantReview,
            type: 'MULTI_VARIANT',
            required: true,
            policy: rememberedPolicy || null,
            policyResolution: policyResolution.status,
            policyIssueCode,
            policyConflicts,
          } : (variantReview.required ? { type: 'MULTI_VARIANT', ...variantReview } : null),
          aux: {
            translations: missingTranslations.map(f => ({ fileId: f.file_id, name: f.name, version: f.version, category: f.category_name || '' })),
            patches: relevantPatches.map(x => ({ fileId: x.file.file_id, name: x.file.name, version: x.file.version, category: x.file.category_name || '', why: x.match.why })),
            components,
          },
          candidates: topCandidates,
        });
      } catch (err) {
        apiFail++;
        results.push({ ...r, action: 'HOLD_API_ERROR', reason: 'API_ERROR', confidence: 'low', error: err.message, updateEligibility: { status: 'HOLD_UPDATE_ELIGIBILITY', reason: 'API_ERROR', priority: 50 } });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  results.sort((a, b) => Number(b.updateEligibility?.priority || 0) - Number(a.updateEligibility?.priority || 0) || Number(a.modId) - Number(b.modId) || a.name.localeCompare(b.name));

  const counts = {};
  for (const r of results) counts[r.action] = (counts[r.action] || 0) + 1;
  const updateCounts = eligibilityCounts(results);
  console.error(`done rows=${rows.length} apiFail=${apiFail} updates=${JSON.stringify(updateCounts)} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (outFile) {
    const lines = results.map(o => [
      o.modId, o.latestName || o.name, o.latestVersion || '', o.note || o.reason || '', o.latestFileId || '', o.action || 'HOLD_REVIEW',
    ].join('\t'));
    fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    updateEligibilityGate: true,
    updateEligibilityCounts: updateCounts,
    updateEvidencePolicy: {
      priority: ['NEXUS_EXACT_UPDATE_CHAIN', 'NEWER_COMPATIBLE_FILE_UPLOAD', 'MO2_UPDATE_SIGNAL'],
      metadataOnlyDoesNotProveUpdate: true,
      mo2WarningIconsTrusted: false,
    },
    variantPolicyFile: policyFile,
    variantPolicyCount: Object.keys(policies.policies || {}).length,
    componentClosure: true,
    environmentGraphFile: environmentOut || null,
    environment: compactEnvironmentSummary(environment),
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
