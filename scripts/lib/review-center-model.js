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

function compactPatchCandidate(candidate, mainModId) {
  const modId = String(candidate.auxModId || (candidate.source === 'SAME_PAGE_FILE' ? mainModId : '') || '');
  return {
    key: candidate.key || '',
    family: candidate.family || 'GENERAL',
    source: candidate.source || '',
    modId,
    fileId: String(candidate.fileId || ''),
    version: candidate.version || '',
    name: candidate.name || '',
    evidence: candidate.evidence || '',
    installedContextMatch: !!candidate.installedContextMatch,
    localMatches: candidate.localMatches || [],
    selectable: !!(modId && candidate.fileId),
  };
}

function buildReviewPayload(plan, patch, closure, metadata = {}) {
  const patchMap = new Map((patch.items || []).map(x => [keyOf(x.modId, x.mainFileId), x]));
  const closureMap = new Map((closure.items || []).map(x => [keyOf(x.modId, x.fileId), x]));
  const map = new Map();

  function ensure(item) {
    const id = `mod:${item.modId}`;
    if (!map.has(id)) map.set(id, {
      id,
      modId: String(item.modId),
      localName: item.name || item.localName || '',
      mainName: item.latestName || item.name || '',
      localFileId: item.localFileId || item.fileId || '',
      action: item.action || '',
      variantPolicy: item.variantPolicy || null,
      mainOptions: [],
      patchFamilies: [],
      blockers: [],
    });
    const row = map.get(id);
    if (!row.variantPolicy && item.variantPolicy) row.variantPolicy = item.variantPolicy;
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
    if (item.action === 'HOLD_VARIANT_REVIEW') {
      row.blockers.push('检测到多个互斥 Main 分支：程序不会自动从当前分支迁移到另一分支。');
    }
    if (item.action === 'HOLD_VARIANT_POLICY_CHANGED') {
      const oldBranch = item.variantPolicy?.branchKey || item.manualReview?.policy?.branchKey || '未知分支';
      row.blockers.push(`已记住的 Main 分支 ${oldBranch} 在当前文件结构中无法安全复用；必须重新确认，绝不会自动回退到其他分支。`);
    }
  }

  for (const discovery of patch.items || []) {
    if (discovery.complete) continue;
    const row = ensure({
      modId: discovery.modId,
      name: discovery.mainName,
      latestName: discovery.mainName,
      localFileId: '',
      action: 'HOLD_PATCH_DISCOVERY',
    });
    row.action = row.action || 'HOLD_PATCH_DISCOVERY';
    for (const problem of discovery.coverageProblems || []) {
      row.blockers.push(`Patch discovery 覆盖不完整：${problem.source} / ${problem.status}${problem.detail ? ` — ${problem.detail}` : ''}`);
    }
    const families = new Map();
    for (const candidate of discovery.unresolved || []) {
      const family = candidate.family || 'GENERAL';
      if (!families.has(family)) families.set(family, { family, reason: '未解决 Patch family', candidates: [] });
      families.get(family).candidates.push(compactPatchCandidate(candidate, discovery.modId));
    }
    row.patchFamilies.push(...families.values());
  }

  for (const row of map.values()) {
    const targetId = row.mainOptions.find(x => x.recommended)?.fileId || row.localFileId || '';
    const closureItem = closureMap.get(keyOf(row.modId, targetId));
    if (closureItem?.closure === 'FAILED') {
      if (closureItem.missingKinds?.length) row.blockers.push(`Closure 未完成：${closureItem.missingKinds.join(', ')}`);
      if (closureItem.conflicts?.length) row.blockers.push(`Closure 证据冲突：${closureItem.conflicts.join(' | ')}`);
    }
    row.blockers = [...new Set(row.blockers)];
    const discovery = patchMap.get(keyOf(row.modId, targetId));
    if (discovery && !discovery.complete && !row.patchFamilies.length) {
      row.blockers.push('Patch Discovery 尚未闭合；需要 Pi Agent 先补候选 exact fileId/证据。');
    }
  }

  const items = [...map.values()].sort((a, b) => Number(a.modId) - Number(b.modId));
  const counts = {
    variant: items.filter(x => x.mainOptions.length > 1).length,
    patch: items.filter(x => x.patchFamilies.length || x.blockers.some(b => /Patch/i.test(b))).length,
    other: items.filter(x => x.mainOptions.length <= 1 && !x.patchFamilies.length).length,
  };
  return {
    generatedAt: new Date().toISOString(),
    version: 3,
    ...metadata,
    counts,
    items,
  };
}

module.exports = { keyOf, compactMainOption, compactPatchCandidate, buildReviewPayload };
