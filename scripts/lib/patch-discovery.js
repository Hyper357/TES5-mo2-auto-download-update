'use strict';

const crypto = require('crypto');

const PATCH_WORDS = new Set([
  'patch', 'patches', 'compat', 'compatibility', 'fix', 'fixes', 'hotfix', 'optional',
  'support', 'integration', 'addon', 'add-on', 'update', 'main', 'file', 'files',
  '补丁', '兼容', '修复', '支持', '适配',
]);

const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'latest', 'version', 'skyrim',
  'special', 'edition', 'anniversary', 'se', 'ae', 'ng', 'sse', 'mod', 'mods',
]);

// Well-known compatibility ecosystems. The key is persisted in registry/report and must stay stable.
const KNOWN_FAMILIES = [
  ['USSEP', /\b(ussep|unofficial skyrim special edition patch)\b/i],
  ['USMP', /\b(usmp|unofficial skyrim modder'?s patch)\b/i],
  ['LOTD', /\b(lotd|legacy of the dragonborn)\b/i],
  ['LUX_ORBIS', /\blux\s+orbis\b/i],
  ['LUX_VIA', /\blux\s+via\b/i],
  ['LUX', /\blux\b/i],
  ['JK_SKYRIM', /\bjk'?s?\s+(?:skyrim|interiors?|outdoors?|whiterun|solitude|riften|windhelm|markarth)\b/i],
  ['AI_OVERHAUL', /\bai\s+overhaul\b/i],
  ['WACCF', /\b(waccf|weapons armor clothing and clutter fixes)\b/i],
  ['CRF', /\b(crf|cutting room floor)\b/i],
  ['CACO', /\b(caco|complete alchemy and cooking overhaul)\b/i],
  ['ELFX', /\b(elfx|enhanced lights and fx)\b/i],
  ['OPEN_CITIES', /\b(open cities|open cities skyrim)\b/i],
  ['NORTHERN_ROADS', /\bnorthern roads\b/i],
  ['EMBERS_XD', /\bembers\s+xd\b/i],
  ['SMIM', /\b(smim|static mesh improvement mod)\b/i],
  ['XPMSSE', /\b(xpmsse|xp32 maximum skeleton special extended)\b/i],
  ['RACEMENU', /\brace\s*menu\b/i],
  ['BODYSLIDE', /\b(body\s*slide|outfit studio)\b/i],
  ['CBBE', /\bcbbe\b/i],
  ['3BA', /\b(3ba|3bbb)\b/i],
  ['BHUNP', /\bbhunp\b/i],
  ['MCO', /\b(mco|adxp)\b/i],
  ['OAR', /\b(open animation replacer|\boar\b)\b/i],
  ['DAR', /\bdynamic animation replacer\b/i],
  ['NEMESIS', /\bnemesis\b/i],
  ['FNIS', /\bfnis\b/i],
  ['SPID', /\b(spid|spell perk item distributor)\b/i],
  ['KID', /\b(kid|keyword item distributor)\b/i],
  ['BOS', /\b(base object swapper|\bbos\b)\b/i],
  ['SDA', /\bserana dialogue add-?on\b/i],
  ['3DNPC', /\b(3dnpc|interesting npcs?)\b/i],
  ['FALSKAAR', /\bfalskaar\b/i],
  ['BRUMA', /\bbeyond skyrim\s*[-:]?\s*bruma\b/i],
  ['CC', /\b(creation club|anniversary edition content|cc content)\b/i],
];

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015_]+/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(input) {
  return normalizeText(input)
    .split(' ')
    .filter(Boolean)
    .filter(t => t.length >= 2)
    .filter(t => !GENERIC_WORDS.has(t));
}

function stripMainTokens(text, mainName) {
  const main = new Set(tokens(mainName));
  return tokens(text).filter(t => !main.has(t) && !PATCH_WORDS.has(t));
}

function slug(parts) {
  return parts.join('_').replace(/[^a-z0-9_\-\u4e00-\u9fff]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80).toUpperCase();
}

function inferFamily(text, mainName = '') {
  const raw = String(text || '');
  for (const [key, re] of KNOWN_FAMILIES) {
    if (re.test(raw)) return key;
  }
  const rest = stripMainTokens(raw, mainName);
  if (rest.length) return `CUSTOM:${slug(rest.slice(0, 6))}`;
  return 'GENERAL';
}

function isPatchLike(text) {
  return /(patch|compat|compatibility|hotfix|bug\s*fix|fixes?|integration|support|补丁|兼容|修复|适配)/i.test(String(text || ''));
}

function isTranslationLike(text) {
  return /(translation|translate|chinese|中文|汉化|简中|繁中|chs|cht)/i.test(String(text || ''));
}

function candidateKey(c) {
  if (c.auxModId) return `mod:${c.auxModId}`;
  if (c.fileId) return `file:${c.fileId}`;
  const digest = crypto.createHash('sha1').update(`${c.family || ''}\n${normalizeText(c.name || '')}`).digest('hex').slice(0, 12);
  return `text:${digest}`;
}

function sourceRank(source) {
  return {
    SAME_PAGE_FILE: 100,
    RELATION_REGISTRY: 95,
    REQUIREMENTS_REVERSE: 90,
    DESCRIPTION_LINK: 75,
    INSTALLED_PATCH: 70,
    LOCAL_FOMOD: 65,
    DESCRIPTION_TEXT: 40,
  }[source] || 10;
}

function mergeCandidates(items) {
  const map = new Map();
  for (const raw of items || []) {
    if (!raw || isTranslationLike(raw.name || '') && raw.kind !== 'PATCH') continue;
    const c = {
      kind: 'PATCH',
      source: raw.source || 'UNKNOWN',
      sources: Array.isArray(raw.sources) ? raw.sources.slice() : [raw.source || 'UNKNOWN'],
      auxModId: raw.auxModId ? String(raw.auxModId) : '',
      fileId: raw.fileId ? String(raw.fileId) : '',
      version: raw.version || '',
      name: raw.name || '',
      url: raw.url || '',
      evidence: raw.evidence || '',
      installed: !!raw.installed,
      family: raw.family || inferFamily(`${raw.name || ''} ${raw.evidence || ''}`, raw.mainName || ''),
      applicabilityHints: Array.isArray(raw.applicabilityHints) ? raw.applicabilityHints.slice() : [],
    };
    const k = candidateKey(c);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, { ...c, key: k });
      continue;
    }
    const sources = [...new Set([...(prev.sources || []), ...(c.sources || [])])];
    const better = sourceRank(c.source) > sourceRank(prev.source) ? c : prev;
    map.set(k, {
      ...prev,
      ...better,
      key: k,
      sources,
      installed: prev.installed || c.installed,
      applicabilityHints: [...new Set([...(prev.applicabilityHints || []), ...(c.applicabilityHints || [])])],
      evidence: [prev.evidence, c.evidence].filter(Boolean).join(' | ').slice(0, 2500),
    });
  }
  return [...map.values()].sort((a, b) => sourceRank(b.source) - sourceRank(a.source) || a.family.localeCompare(b.family));
}

function familyAliases(family) {
  const entry = KNOWN_FAMILIES.find(([key]) => key === family);
  return entry ? entry[1] : null;
}

function installedContext(candidate, localNames) {
  const names = (localNames || []).map(String);
  const familyRe = familyAliases(candidate.family);
  const hits = [];
  if (familyRe) {
    for (const n of names) if (familyRe.test(n)) hits.push(n);
  } else if (candidate.family?.startsWith('CUSTOM:')) {
    const famTokens = candidate.family.slice(7).toLowerCase().split('_').filter(x => x.length >= 3);
    for (const n of names) {
      const nt = new Set(tokens(n));
      const count = famTokens.filter(t => nt.has(t)).length;
      if (famTokens.length && count / famTokens.length >= 0.5) hits.push(n);
    }
  }
  return {
    installedContextMatch: hits.length > 0,
    localMatches: hits.slice(0, 10),
  };
}

function normalizeFamilyKey(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s === '*') return '*';
  if (/^CUSTOM:/i.test(s)) return `CUSTOM:${slug(s.slice(s.indexOf(':') + 1).split(/[_\s-]+/).filter(Boolean))}`;
  return slug(s.split(/[\s-]+/).filter(Boolean));
}

const RESOLVED_STATUSES = new Set(['REQUIRED', 'NOT_APPLICABLE', 'ALREADY_INCLUDED', 'OBSOLETE']);

function candidateRuleMatches(candidate, rule) {
  if (!rule || rule.kind !== 'PATCH') return false;
  if (rule.auxModId && candidate.auxModId && String(rule.auxModId) === String(candidate.auxModId)) return true;
  if (rule.auxFileId && candidate.fileId && String(rule.auxFileId) === String(candidate.fileId)) return true;
  const rf = normalizeFamilyKey(rule.family || '');
  const cf = normalizeFamilyKey(candidate.family || '');
  return !!rf && rf !== '*' && rf === cf;
}

function resolveCandidate(candidate, patchRules) {
  const matching = (patchRules || []).filter(r => candidateRuleMatches(candidate, r));
  if (!matching.length) return { resolved: false, status: 'UNRESOLVED', rule: null };
  const resolved = matching.find(r => RESOLVED_STATUSES.has(String(r.status || '').toUpperCase()));
  if (!resolved) return { resolved: false, status: 'UNRESOLVED', rule: matching[0] };
  return { resolved: true, status: String(resolved.status).toUpperCase(), rule: resolved };
}

function assessDiscovery({ candidates, patchRules, coverage }) {
  const assessed = (candidates || []).map(c => ({ ...c, decision: resolveCandidate(c, patchRules) }));
  const unresolved = assessed.filter(c => !c.decision.resolved);
  const coverageProblems = Object.entries(coverage || {})
    .filter(([, v]) => v && v.required && !v.complete)
    .map(([k, v]) => ({ source: k, status: v.status || 'INCOMPLETE', detail: v.detail || '' }));
  return {
    candidates: assessed,
    unresolved,
    coverageProblems,
    coverageComplete: coverageProblems.length === 0,
    complete: coverageProblems.length === 0 && unresolved.length === 0,
  };
}

module.exports = {
  KNOWN_FAMILIES,
  RESOLVED_STATUSES,
  normalizeText,
  tokens,
  inferFamily,
  isPatchLike,
  isTranslationLike,
  candidateKey,
  mergeCandidates,
  installedContext,
  normalizeFamilyKey,
  candidateRuleMatches,
  resolveCandidate,
  assessDiscovery,
};
