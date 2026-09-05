'use strict';

const { categoryRole, isActive, tokenSimilarity, variantSignature, norm } = require('./file-selector');
const { compareVersions } = require('./semver');

const BRANCH_TAGS = [
  ['VANILLA', /\bvanilla\b/i],
  ['KS_HAIRDOS', /\bks\s+hairdos?\b/i],
  ['HDT_SMP', /\b(?:hdt(?:[-\s]?smp)?|smp)\b/i],
  ['NORMALS_ONLY', /\bnormals?\s+only\b/i],
  ['PARTIAL', /\bpartial\b/i],
  ['FULL', /\bfull\b/i],
  ['LITE', /\b(?:lite|lightweight)\b/i],
  ['PERFORMANCE', /\bperformance\b/i],
  ['QUALITY', /\b(?:quality|high\s*quality|hq)\b/i],
  ['BEARD', /\bbeards?\b/i],
  ['KHAJIIT', /\bkhajiit\b/i],
  ['ARGONIAN', /\bargonian\b/i],
  ['MALE', /\bmale\b/i],
  ['FEMALE', /\bfemale\b/i],
  ['CBBE', /\bcbbe\b/i],
  ['3BA', /\b(?:3ba|3bbb)\b/i],
  ['BHUNP', /\bbhunp\b/i],
  ['UNP', /\bunp\b/i],
  ['WITH_CC', /\b(?:with\s+cc|creation\s+club|anniversary\s+content)\b/i],
  ['NO_CC', /\b(?:without\s+cc|no\s+cc|non\s+cc)\b/i],
];

function branchTags(file) {
  const text = `${file?.name || ''} ${file?.file_name || ''} ${file?.description || ''}`;
  const tags = [];
  for (const [key, re] of BRANCH_TAGS) if (re.test(text)) tags.push(key);

  const sig = variantSignature(text);
  for (const x of sig.runtime) tags.push(`RUNTIME_${x}`);
  for (const x of sig.body) tags.push(`BODY_${x}`);
  for (const x of sig.resolution) tags.push(`RES_${x}`);
  for (const x of sig.cc) tags.push(x);
  return [...new Set(tags)].sort();
}

function branchKey(file) {
  const tags = branchTags(file);
  return tags.length ? tags.join('+') : 'GENERIC';
}

function newerFile(a, b) {
  const cmp = compareVersions(a?.version || '', b?.version || '');
  if (cmp !== 0) return cmp > 0 ? a : b;
  const at = Date.parse(a?.uploaded_time || '') || 0;
  const bt = Date.parse(b?.uploaded_time || '') || 0;
  if (at !== bt) return at > bt ? a : b;
  return Number(a?.file_id || 0) >= Number(b?.file_id || 0) ? a : b;
}

function environmentScore(file, localNames) {
  const text = `${file?.name || ''} ${file?.file_name || ''} ${file?.description || ''}`;
  let best = 0;
  let bestName = '';
  for (const local of localNames || []) {
    const s = tokenSimilarity(text, local);
    if (s > best) { best = s; bestName = local; }
  }
  return { score: best, localMatch: bestName };
}

function compactOption(file, mine, localNames) {
  const env = environmentScore(file, localNames);
  return {
    fileId: String(file?.file_id || ''),
    name: file?.name || file?.file_name || '',
    fileName: file?.file_name || '',
    version: file?.version || '',
    category: file?.category_name || '',
    categoryId: file?.category_id,
    description: String(file?.description || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
    uploadedTime: file?.uploaded_time || '',
    branchKey: branchKey(file),
    tags: branchTags(file),
    current: String(file?.file_id || '') === String(mine?.file_id || ''),
    environmentScore: Number(env.score.toFixed(3)),
    environmentMatch: env.localMatch,
  };
}

function detectVariantReview({ files, mine, localNames = [] }) {
  const mains = (files || []).filter(f => isActive(f) && categoryRole(f) === 'MAIN');
  if (mains.length < 2) {
    return {
      required: false,
      options: mains.map(f => compactOption(f, mine, localNames)),
      reason: 'single-main-branch',
      currentFileId: String(mine?.file_id || ''),
      currentBranch: branchKey(mine),
      recommendedFileId: '',
      recommendedBranch: '',
      recommendedDifferentFromCurrent: false,
    };
  }

  // Collapse historical releases within the same semantic branch, while keeping materially different branches.
  const byKey = new Map();
  for (const f of mains) {
    const k = branchKey(f);
    const prev = byKey.get(k);
    byKey.set(k, prev ? newerFile(prev, f) : f);
  }

  const options = [...byKey.values()].map(f => compactOption(f, mine, localNames));
  const strong = options.filter(o => o.branchKey !== 'GENERIC');
  const strongKeys = new Set(strong.map(o => o.branchKey));

  // Some pages do not use recognizable variant labels. Treat a large, mutually dissimilar MAIN set as review-worthy.
  let divergent = false;
  if (options.length >= 4) {
    outer: for (let i = 0; i < options.length; i++) {
      for (let j = i + 1; j < options.length; j++) {
        if (tokenSimilarity(options[i].name, options[j].name) < 0.34) { divergent = true; break outer; }
      }
    }
  }

  const required = strongKeys.size >= 2 || divergent;
  if (!required) return { required: false, options, reason: 'same-semantic-branch' };

  options.sort((a, b) => Number(b.current) - Number(a.current) || b.environmentScore - a.environmentScore || b.fileId.localeCompare(a.fileId));
  const rankedByEnv = options.slice().sort((a, b) => b.environmentScore - a.environmentScore || Number(b.current) - Number(a.current));
  const recommendation = rankedByEnv[0] && rankedByEnv[0].environmentScore >= 0.18 ? rankedByEnv[0] : null;
  const current = options.find(o => o.current) || null;
  const recommendedDifferentFromCurrent = !!(recommendation && current && recommendation.fileId !== current.fileId && recommendation.environmentScore >= current.environmentScore + 0.06);

  return {
    required: true,
    reason: strongKeys.size >= 2 ? 'multiple-semantic-main-branches' : 'divergent-main-files',
    currentFileId: current?.fileId || String(mine?.file_id || ''),
    currentBranch: current?.branchKey || branchKey(mine),
    recommendedFileId: recommendation?.fileId || '',
    recommendedBranch: recommendation?.branchKey || '',
    recommendedDifferentFromCurrent,
    options: options.slice(0, 30),
  };
}

module.exports = { BRANCH_TAGS, branchTags, branchKey, detectVariantReview, environmentScore };
