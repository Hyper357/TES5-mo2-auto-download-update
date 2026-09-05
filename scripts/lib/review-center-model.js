'use strict';

function keyOf(modId, fileId) {
  return `${String(modId)}:${String(fileId || '')}`;
}

function compactMainOption(option, item) {
  return {
    modId: String(item.modId),
    fileId: String(option.fileId || ''),
    name: option.name || '',
    fileName: option.fileName || '',
    version: option.version || '',
    category: option.category || 'Main Files',
    description: option.description || '',
    branchKey: option.branchKey || '',
    tags: option.tags || [],
    current: !!option.current,
    recommended: String(option.fileId || '') === String(item.manualReview?.recommendedFileId || ''),
    environmentScore: option.environmentScore || 0,
    environmentMatch: option.environmentMatch || '',
    selectable: !!option.fileId,
  };
}

function compactComponentCandidate(candidate, mainModId) {
  const modId = String(candidate.auxModId || (candidate.source === 'SAME_PAGE_FILE' ? mainModId : '') || '');
  return {
    key: candidate.key || '',
    kind: candidate.kind || 'PATCH',
    family: candidate.family || 'GENERAL',
    source: candidate.source || '',
    modId,
    fileId: String(candidate.fileId || ''),
    version: candidate.version || '',
    name: candidate.name || '',
    evidence: candidate.evidence || '',
    requiredHint: !!candidate.requiredHint,
    optionalHint: !!candidate.optionalHint,
    installedContextMatch: !!candidate.installedContextMatch,
    localMatches: candidate.localMatches || [],
    environmentDecision: candidate.environmentDecision ? {
      resolved: !!candidate.environmentDecision.resolved,
      status: candidate.environmentDecision.status || 'UNRESOLVED',
      confidence: candidate.environmentDecision.confidence || 'none',
      reason: candidate.environmentDecision.reason || '',
      evidence: candidate.environmentDecision.evidence || [],
    } : null,
    selectable: !!(modId && candidate.fileId),
  };
}

function compactPatchCandidate(candidate, mainModId) {
  return compactComponentCandidate({ kind: 'PATCH', ...candidate }, mainModId);
}

function buildReviewPayload(plan, discoveryDoc, closure, metadata = {}) {
  const discoveryMap = new Map((discoveryDoc.items || []).map(x => [keyOf(x.modId, x.mainFileId), x]));
  const closureMap = new Map((closure.items || []).map(x => [keyOf(x.modId, x.fileId), x]));
  const planTargetMap = new Map();
  for (const p of plan.items || []) {
    const fid = p.latestFileId || p.fileId || '';
    if (p.modId && fid) planTargetMap.set(keyOf(p.modId, fid), p);
  }
  const map = new Map();

  function ensure(item) {
    const id = `mod:${item.modId}`;
    if (!map.has(id)) map.set(id, {
      id,
      modId: String(item.modId),
      localName: item.name || item.localName || '',
      mainName: item.latestName || item.mainName || item.name || '',
      localFileId: item.localFileId || item.fileId || '',
      action: item.action || '',
      profileState: item.profileState || 'UNKNOWN',
      targetMainFileId: item.targetMainFileId || item.latestFileId || '',
      targetMainVersion: item.targetMainVersion || item.latestVersion || '',
      targetMainName: item.targetMainName || item.latestName || item.mainName || item.name || '',
      variantPolicy: item.variantPolicy || null,
      mainOptions: [],
      componentFamilies: [],
      patchFamilies: [],
      blockers: [],
    });
    const row = map.get(id);
    if (!row.variantPolicy && item.variantPolicy) row.variantPolicy = item.variantPolicy;
    if (!row.targetMainFileId && (item.targetMainFileId || item.latestFileId)) row.targetMainFileId = item.targetMainFileId || item.latestFileId;
    if (!row.targetMainVersion && (item.targetMainVersion || item.latestVersion)) row.targetMainVersion = item.targetMainVersion || item.latestVersion;
    if (!row.targetMainName && (item.targetMainName || item.latestName || item.mainName)) row.targetMainName = item.targetMainName || item.latestName || item.mainName;
    if (row.profileState === 'UNKNOWN' && item.profileState) row.profileState = item.profileState;
    return row;
  }

  for (const item of plan.items || []) {
    const isReview = ['HOLD_VARIANT_REVIEW', 'HOLD_VARIANT_POLICY_CHANGED', 'HOLD_REVIEW', 'HOLD_AMBIGUOUS', 'HOLD_LOW_CONFIDENCE', 'HOLD_SAME_VERSION_REPLACEMENT'].includes(item.action);
    if (!isReview && !item.manualReview?.required) continue;
    const row = ensure(item);
    if (item.manualReview?.options?.length) {
      row.mainOptions = item.manualReview.options.map(option => compactMainOption(option, item));
    } else {
      row.mainOptions = (item.candidates || []).filter(x => x.fileId).map(option => ({
        modId: String(item.modId),
        fileId: String(option.fileId),
        name: option.name || '',
        fileName: option.fileName || '',
        version: option.version || '',
        category: option.category || '',
        description: option.description || '',
        branchKey: '',
        tags: [],
        current: String(option.fileId) === String(item.localFileId || ''),
        recommended: String(option.fileId) === String(item.latestFileId || ''),
        environmentScore: option.similarity || 0,
        environmentMatch: '',
        selectable: true,
      }));
    }
    if (item.action === 'HOLD_VARIANT_REVIEW') row.blockers.push('检测到多个互斥 Main 分支：程序不会自动从当前分支迁移到另一分支。');
    if (item.action === 'HOLD_VARIANT_POLICY_CHANGED') {
      const oldBranch = item.variantPolicy?.branchKey || item.manualReview?.policy?.branchKey || '未知分支';
      row.blockers.push(`已记住的 Main 分支 ${oldBranch} 在当前文件结构中无法安全复用；必须重新确认，绝不会自动回退到其他分支。`);
    }
  }

  for (const discovery of discoveryDoc.items || []) {
    if (discovery.complete) continue;
    const planItem = planTargetMap.get(keyOf(discovery.modId, discovery.mainFileId)) || {};
    const row = ensure({
      ...planItem,
      modId: discovery.modId,
      name: planItem.name || discovery.mainName,
      latestName: planItem.latestName || discovery.mainName,
      targetMainFileId: discovery.mainFileId,
      targetMainVersion: discovery.mainVersion,
      targetMainName: discovery.mainName,
      action: 'HOLD_COMPONENT_DISCOVERY',
    });
    row.action = row.action || 'HOLD_COMPONENT_DISCOVERY';
    for (const problem of discovery.coverageProblems || []) {
      row.blockers.push(`Component discovery 覆盖不完整：${problem.source} / ${problem.status}${problem.detail ? ` — ${problem.detail}` : ''}`);
    }

    const families = new Map();
    for (const candidate of discovery.unresolved || []) {
      const kind = candidate.kind || 'PATCH';
      const family = candidate.family || 'GENERAL';
      const groupKey = `${kind}:${family}`;
      if (!families.has(groupKey)) {
        families.set(groupKey, { key: groupKey, kind, family, reason: `未解决 ${kind} component family`, candidates: [] });
      }
      families.get(groupKey).candidates.push(compactComponentCandidate(candidate, discovery.modId));
    }
    row.componentFamilies.push(...families.values());
  }

  for (const row of map.values()) {
    const targetId = row.mainOptions.find(x => x.recommended)?.fileId || row.targetMainFileId || row.localFileId || '';
    const closureItem = closureMap.get(keyOf(row.modId, targetId));
    if (closureItem?.closure === 'FAILED') {
      if (closureItem.missingKinds?.length) row.blockers.push(`Closure 未完成：${closureItem.missingKinds.join(', ')}`);
      if (closureItem.conflicts?.length) row.blockers.push(`Closure 证据冲突：${closureItem.conflicts.join(' | ')}`);
    }
    row.blockers = [...new Set(row.blockers)];
    const discovery = discoveryMap.get(keyOf(row.modId, targetId));
    if (discovery && !discovery.complete && !row.componentFamilies.length) {
      row.blockers.push('Component Discovery 尚未闭合；需要 Pi Agent 先补候选 exact fileId/证据。');
    }
    row.patchFamilies = row.componentFamilies.filter(x => x.kind === 'PATCH' || x.kind === 'HOTFIX');
  }

  const items = [...map.values()].sort((a, b) => Number(a.modId) - Number(b.modId));
  const counts = {
    variant: items.filter(x => x.mainOptions.length > 1).length,
    component: items.filter(x => x.componentFamilies.length || x.blockers.some(b => /Component|Closure/i.test(b))).length,
    patch: items.filter(x => x.componentFamilies.some(f => ['PATCH', 'HOTFIX'].includes(f.kind))).length,
    other: items.filter(x => x.mainOptions.length <= 1 && !x.componentFamilies.length).length,
  };
  return { generatedAt: new Date().toISOString(), version: 5, ...metadata, counts, items };
}

module.exports = { keyOf, compactMainOption, compactComponentCandidate, compactPatchCandidate, buildReviewPayload };
