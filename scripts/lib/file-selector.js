'use strict';

const { compareVersions } = require('./semver');

const ACTIVE_CATEGORY_IDS = new Set([1, 2, 3, 5]);
const RETIRED_CATEGORY_IDS = new Set([4, 7]);

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fff.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileText(file) {
  return norm(`${file?.name || ''} ${file?.file_name || ''} ${file?.category_name || ''}`);
}

function categoryRole(file) {
  const text = fileText(file);
  const cat = norm(file?.category_name || '');
  const id = Number(file?.category_id || 0);

  if (RETIRED_CATEGORY_IDS.has(id) || /\b(old|archived|deprecated|obsolete)\b/.test(cat)) return 'RETIRED';
  if (/(chinese|translation|translate|中文|汉化|简体|繁体|chs|cht)/i.test(text)) return 'TRANSLATION';
  if (/(patch|compat|compatibility|hotfix|bugfix|fixes|fix\b|补丁|兼容|修复)/i.test(text)) return 'PATCH';
  if (id === 1 || /\bmain\b/.test(cat)) return 'MAIN';
  if (id === 2 || /\bupdate\b/.test(cat)) return 'UPDATE';
  if (id === 3 || /\boptional\b/.test(cat)) return 'OPTIONAL';
  if (id === 5 || /\bmisc/.test(cat)) return 'MISC';
  return 'UNKNOWN';
}

function isActive(file) {
  const id = Number(file?.category_id || 0);
  if (RETIRED_CATEGORY_IDS.has(id)) return false;
  if (ACTIVE_CATEGORY_IDS.has(id)) return true;
  return categoryRole(file) !== 'RETIRED';
}

function variantSignature(text) {
  const t = ` ${norm(text)} `;
  const runtime = new Set();
  const body = new Set();
  const resolution = new Set();
  const language = new Set();
  const cc = new Set();

  if (/\bvr\b/.test(t)) runtime.add('VR');
  if (/\b1[ ._-]?5[ ._-]?97\b|\bse\b/.test(t)) runtime.add('SE');
  if (/\b1[ ._-]?6(?:[ ._-]?\d+){1,2}\b|\bae\b/.test(t)) runtime.add('AE');
  if (/\bgog\b/.test(t)) runtime.add('GOG');
  if (/\bng\b|next gen/.test(t)) runtime.add('NG');

  if (/\b3ba\b/.test(t)) body.add('3BA');
  if (/\bcbbe\b/.test(t)) body.add('CBBE');
  if (/\bbhunp\b/.test(t)) body.add('BHUNP');
  if (/\bunp\b/.test(t)) body.add('UNP');

  for (const r of ['1k', '2k', '4k', '8k']) if (new RegExp(`\\b${r}\\b`, 'i').test(t)) resolution.add(r.toUpperCase());

  if (/without cc|no cc|non cc|no creation club/.test(t)) cc.add('NO_CC');
  else if (/with cc|creation club|anniversary content/.test(t)) cc.add('WITH_CC');

  if (/(chinese|中文|汉化|简体|chs)/.test(t)) language.add('ZH_CN');
  if (/(繁体|traditional chinese|cht)/.test(t)) language.add('ZH_TW');

  return { runtime, body, resolution, language, cc };
}

function setConflict(a, b, dimension) {
  if (!a.size || !b.size) return null;
  for (const x of a) if (b.has(x)) return null;
  return `${dimension}:${[...a].join('+')}!=${[...b].join('+')}`;
}

function hardVariantConflicts(localText, candidateText, profile) {
  const local = variantSignature(localText);
  const cand = variantSignature(candidateText);
  const conflicts = [];

  for (const [key, label] of [['runtime', 'runtime'], ['body', 'body'], ['resolution', 'resolution'], ['cc', 'cc']]) {
    const c = setConflict(local[key], cand[key], label);
    if (c) conflicts.push(c);
  }

  const p = norm(`${profile?.platform || ''} ${profile?.bodyType || ''} ${profile?.textureTier || ''}`);
  if (p) {
    const ps = variantSignature(p);
    for (const [key, label] of [['runtime', 'profile-runtime'], ['body', 'profile-body'], ['resolution', 'profile-resolution']]) {
      const c = setConflict(ps[key], cand[key], label);
      if (c) conflicts.push(c);
    }
  }

  return conflicts;
}

const STOP = new Set([
  'skyrim', 'special', 'edition', 'anniversary', 'mod', 'mods', 'main', 'file', 'files',
  'optional', 'update', 'updated', 'version', 'installer', 'fomod', 'full', 'package', 'pack',
  'download', 'latest', 'final', 'release', 'v', 'ae', 'se', 'vr', 'gog', 'ng',
  '1k', '2k', '4k', '8k', 'with', 'without', 'cc', 'content'
]);

function familyTokens(text) {
  return norm(text)
    .replace(/\bv?\d+(?:[._-]\d+){1,4}[a-z0-9-]*\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(x => x.length > 1 && !STOP.has(x));
}

function tokenSimilarity(aText, bText) {
  const a = new Set(familyTokens(aText));
  const b = new Set(familyTokens(bText));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function roleCompatible(mine, candidate) {
  const mr = categoryRole(mine);
  const cr = categoryRole(candidate);
  if (cr === 'RETIRED') return false;
  if (mr === 'TRANSLATION') return cr === 'TRANSLATION' || cr === 'MAIN' || cr === 'OPTIONAL';
  if (mr === 'PATCH') return cr === 'PATCH' || cr === 'MAIN' || cr === 'OPTIONAL' || cr === 'UPDATE';
  if (mr === 'MAIN' || mr === 'UPDATE' || mr === 'OPTIONAL' || mr === 'MISC' || mr === 'UNKNOWN') {
    return cr !== 'PATCH' && cr !== 'TRANSLATION';
  }
  return true;
}

function scoreCandidate({ mine, candidate, localName = '', installationFile = '', profile = null }) {
  const reasons = [];
  const rejects = [];
  const localText = `${localName} ${installationFile} ${mine?.name || ''} ${mine?.file_name || ''}`;
  const candText = `${candidate?.name || ''} ${candidate?.file_name || ''}`;

  if (!isActive(candidate)) rejects.push('retired-file');
  if (!roleCompatible(mine, candidate)) rejects.push(`role:${categoryRole(mine)}->${categoryRole(candidate)}`);
  const variantConflicts = hardVariantConflicts(localText, candText, profile);
  rejects.push(...variantConflicts);

  const cmp = compareVersions(candidate?.version || '', mine?.version || '');
  if (cmp < 0) rejects.push('version-downgrade');

  if (rejects.length) return { accepted: false, score: -Infinity, reasons, rejects, similarity: 0 };

  let score = 0;
  const similarity = tokenSimilarity(localText, candText);
  score += Math.round(similarity * 70);
  reasons.push(`family=${similarity.toFixed(2)}`);

  if (Number(candidate?.category_id) === Number(mine?.category_id)) {
    score += 24;
    reasons.push('same-category');
  } else if ([1, 2].includes(Number(candidate?.category_id)) && [1, 2].includes(Number(mine?.category_id))) {
    score += 16;
    reasons.push('main-update-category');
  }

  const mineRole = categoryRole(mine);
  const candRole = categoryRole(candidate);
  if (mineRole === candRole) {
    score += 12;
    reasons.push('same-role');
  }

  if (cmp > 0) {
    score += 18;
    reasons.push('newer-version');
  } else if (cmp === 0) {
    score += 2;
    reasons.push('same-version');
  }

  const mineTime = Date.parse(mine?.uploaded_time || '') || 0;
  const candTime = Date.parse(candidate?.uploaded_time || '') || 0;
  if (candTime > mineTime) {
    score += 5;
    reasons.push('newer-upload');
  }

  if (Number(candidate?.file_id) === Number(mine?.file_id)) {
    score += 100;
    reasons.push('current-file');
  }

  return { accepted: true, score, reasons, rejects, similarity };
}

function selectUpdateTarget({ files, mine, localName = '', installationFile = '', profile = null, minScore = 58, minMargin = 12 }) {
  if (!mine) return { decision: 'HOLD_UNRESOLVED_LOCAL', confidence: 'low', target: null, ranked: [] };

  const ranked = (files || [])
    .map(f => ({ file: f, ...scoreCandidate({ mine, candidate: f, localName, installationFile, profile }) }))
    .filter(x => x.accepted)
    .sort((a, b) => b.score - a.score || (Date.parse(b.file.uploaded_time || '') || 0) - (Date.parse(a.file.uploaded_time || '') || 0));

  if (!ranked.length) return { decision: 'HOLD_NO_SAFE_TARGET', confidence: 'low', target: null, ranked };

  const current = ranked.find(x => String(x.file.file_id) === String(mine.file_id));
  const alternatives = ranked.filter(x => String(x.file.file_id) !== String(mine.file_id));
  const best = alternatives[0];

  if (!best) return { decision: 'SKIP_CURRENT', confidence: 'high', target: mine, ranked };

  const second = alternatives[1];
  const margin = second ? best.score - second.score : best.score - (current?.score || 0);
  const versionCmp = compareVersions(best.file.version || '', mine.version || '');

  if (best.score < minScore) {
    return { decision: 'HOLD_LOW_CONFIDENCE', confidence: 'low', target: best.file, margin, ranked };
  }
  if (second && margin < minMargin) {
    return { decision: 'HOLD_AMBIGUOUS', confidence: 'medium', target: best.file, margin, ranked };
  }
  if (versionCmp === 0) {
    return { decision: 'HOLD_SAME_VERSION_REPLACEMENT', confidence: 'medium', target: best.file, margin, ranked };
  }
  if (versionCmp < 0) {
    return { decision: 'SKIP_DOWNGRADE', confidence: 'high', target: mine, margin, ranked };
  }

  return { decision: 'DOWNLOAD', confidence: margin >= 20 && best.score >= 72 ? 'high' : 'medium', target: best.file, margin, ranked };
}

function auxFamilyKey(file) {
  const t = norm(file?.name || file?.file_name || '')
    .replace(/\bv?\d+(?:[._-]\d+){1,4}[a-z0-9-]*\b/g, ' ')
    .replace(/\b(patch|compatibility|compat|fix|hotfix|translation|chinese|chs|cht|中文|汉化|补丁|修复|兼容)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t || String(file?.file_id || 'unknown');
}

function groupLatestAuxFiles(files) {
  const groups = new Map();
  for (const file of files || []) {
    const role = categoryRole(file);
    if (!['PATCH', 'TRANSLATION'].includes(role) || !isActive(file)) continue;
    const key = `${role}:${auxFamilyKey(file)}`;
    const prev = groups.get(key);
    if (!prev) groups.set(key, file);
    else {
      const pt = Date.parse(prev.uploaded_time || '') || 0;
      const ft = Date.parse(file.uploaded_time || '') || 0;
      if (ft > pt || (ft === pt && Number(file.file_id) > Number(prev.file_id))) groups.set(key, file);
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.file_id) - Number(a.file_id));
}

module.exports = {
  norm,
  categoryRole,
  isActive,
  variantSignature,
  hardVariantConflicts,
  tokenSimilarity,
  scoreCandidate,
  selectUpdateTarget,
  auxFamilyKey,
  groupLatestAuxFiles,
};
