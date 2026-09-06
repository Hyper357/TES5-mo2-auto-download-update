'use strict';

const crypto = require('crypto');
const { compareVersions } = require('./semver');
const {
  inferFamily,
  normalizeText,
  tokens,
  normalizeFamilyKey,
  installedContext,
} = require('./patch-discovery');

const COMPONENT_KINDS = [
  'RESOURCE',
  'MESH',
  'TEXTURE',
  'PHYSICS',
  'BODYSLIDE',
  'CONFIG',
  'HOTFIX',
  'PATCH',
  'TRANSLATION',
  'OPTIONAL_COMPONENT',
];

const RESOLVED_STATUSES = new Set(['REQUIRED', 'NOT_APPLICABLE', 'ALREADY_INCLUDED', 'OBSOLETE']);
const NON_BLOCKING_TEXT = /(\boptional\b|purely optional|not required|no need|choose one|alternative only|cosmetic only)/i;
const CONTEXT_NOISE = new Set([
  'alpha','beta','preview','old','legacy','archive','archived','release','latest','main','loose','optional',
  'file','files','version','update','updated','patch','fix','hotfix','resource','resources','plugin','plugins',
]);

function classifyComponent(text, meta = {}) {
  const raw = String(text || '');
  const t = normalizeText(raw);
  if (!t) return '';

  if (/(translation|translate|chinese|mandarin|中文|汉化|简中|繁中|chs|cht)/i.test(raw)) return 'TRANSLATION';
  if (/(hotfix|critical fix|missing textures? fix|missing meshes? fix|emergency fix|bug ?fix)/i.test(raw)) return 'HOTFIX';
  if (/\b(body\s*slide|bodyslide|outfit studio|slider set|slider files?)\b/i.test(raw)) return 'BODYSLIDE';
  if (/\b(hdt[-\s]?smp|faster hdt|fsmp|smp physics|physics meshes?|cloth physics|hair physics)\b/i.test(raw)) return 'PHYSICS';
  if (/\b(mesh|meshes|mesh replacer|mesh pack)\b/i.test(raw)) return 'MESH';
  if (/\b(texture|textures|retexture|texture pack|normal maps?|parallax textures?)\b/i.test(raw)) return 'TEXTURE';
  if (/\b(config|configuration|preset|ini|settings?|json config|toml)\b/i.test(raw)) return 'CONFIG';
  if (/\b(patch|patches|compat|compatibility|integration|compatibility fix|适配|兼容|补丁)\b/i.test(raw)) return 'PATCH';
  if (/\b(requirement|requirements|required resource|required files?|resource pack|resources|framework|library|dependency|dependencies|core files?|shared assets?|base assets?)\b/i.test(raw)) return 'RESOURCE';
  if (/\b(optional|addon|add-on|module|extra files?|alternative|variant|supplement)\b/i.test(raw)) return 'OPTIONAL_COMPONENT';

  if (meta.source === 'REQUIREMENTS_FORWARD') return 'RESOURCE';
  return '';
}

function componentFamily(kind, text, mainName = '') {
  const k = String(kind || '').toUpperCase();
  const raw = String(text || '');
  if (k === 'PATCH' || k === 'HOTFIX') return inferFamily(raw, mainName);
  if (k === 'TRANSLATION') {
    if (/(繁体|traditional chinese|cht)/i.test(raw)) return 'ZH_TW';
    if (/(中文|汉化|简体|simplified chinese|mandarin|chs|chinese)/i.test(raw)) return 'ZH_CN';
    return 'GENERAL';
  }

  const main = new Set(tokens(mainName));
  const stop = new Set([
    'resource','resources','required','requirement','requirements','dependency','dependencies','framework','library','core','files','file',
    'mesh','meshes','texture','textures','retexture','physics','hdt','smp','fsmp','bodyslide','body','slide','outfit','studio',
    'config','configuration','preset','settings','optional','addon','module','alternative','variant','pack','assets','asset','version','latest',
  ]);
  const rest = tokens(raw).filter(x => !main.has(x) && !stop.has(x));
  if (!rest.length) return 'GENERAL';
  return `CUSTOM:${rest.slice(0, 6).join('_').toUpperCase()}`;
}

function candidateKey(c) {
  if (c.auxModId) return `${c.kind}:mod:${c.auxModId}:${c.fileId || ''}`;
  if (c.fileId) return `${c.kind}:file:${c.fileId}`;
  const digest = crypto.createHash('sha1').update(`${c.kind || ''}\n${c.family || ''}\n${normalizeText(c.name || '')}`).digest('hex').slice(0, 12);
  return `${c.kind}:text:${digest}`;
}

function sourceRank(source) {
  return {
    SAME_PAGE_FILE: 100,
    REQUIREMENTS_FORWARD: 98,
    RELATION_REGISTRY: 95,
    REQUIREMENTS_REVERSE: 90,
    DESCRIPTION_LINK: 80,
    INSTALLED_COMPONENT: 75,
    LOCAL_FOMOD: 70,
    DESCRIPTION_TEXT: 45,
  }[source] || 10;
}

function normalizeCandidate(raw) {
  if (!raw) return null;
  const source = raw.source || 'UNKNOWN';
  const combined = `${raw.name || ''} ${raw.evidence || ''}`;
  const kind = String(raw.kind || classifyComponent(combined, { source })).toUpperCase();
  if (!COMPONENT_KINDS.includes(kind)) return null;
  const family = raw.family || componentFamily(kind, combined, raw.mainName || '');
  return {
    kind,
    source,
    sources: Array.isArray(raw.sources) ? raw.sources.slice() : [source],
    auxModId: raw.auxModId ? String(raw.auxModId) : '',
    fileId: raw.fileId ? String(raw.fileId) : '',
    version: raw.version || '',
    name: raw.name || '',
    mainName: raw.mainName || '',
    category: raw.category || '',
    uploadedTime: raw.uploadedTime || '',
    url: raw.url || '',
    evidence: raw.evidence || '',
    installed: !!raw.installed,
    requiredHint: !!raw.requiredHint || source === 'REQUIREMENTS_FORWARD',
    optionalHint: !!raw.optionalHint || NON_BLOCKING_TEXT.test(combined) || kind === 'OPTIONAL_COMPONENT',
    family,
    applicabilityHints: Array.isArray(raw.applicabilityHints) ? raw.applicabilityHints.slice() : [],
  };
}

function mergeComponentCandidates(items) {
  const map = new Map();
  for (const raw of items || []) {
    const c = normalizeCandidate(raw);
    if (!c) continue;
    const key = candidateKey(c);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...c, key });
      continue;
    }
    const better = sourceRank(c.source) > sourceRank(prev.source) ? c : prev;
    map.set(key, {
      ...prev,
      ...better,
      key,
      sources: [...new Set([...(prev.sources || []), ...(c.sources || [])])],
      installed: prev.installed || c.installed,
      requiredHint: prev.requiredHint || c.requiredHint,
      optionalHint: prev.optionalHint && c.optionalHint,
      applicabilityHints: [...new Set([...(prev.applicabilityHints || []), ...(c.applicabilityHints || [])])],
      evidence: [prev.evidence, c.evidence].filter(Boolean).join(' | ').slice(0, 2500),
    });
  }
  return [...map.values()].sort((a, b) => sourceRank(b.source) - sourceRank(a.source) || a.kind.localeCompare(b.kind) || a.family.localeCompare(b.family));
}

function meaningfulContextTokens(input) {
  return tokens(input).filter(t => t.length >= 3 && !CONTEXT_NOISE.has(t) && !/^\d+(?:\.\d+)*$/.test(t));
}

function tokenOverlap(a, b) {
  const at = [...new Set(meaningfulContextTokens(a))];
  const bt = new Set(meaningfulContextTokens(b));
  if (!at.length) return { count: 0, ratio: 0, tokens: at };
  const count = at.filter(x => bt.has(x)).length;
  return { count, ratio: count / at.length, tokens: at };
}

function withInstalledContext(candidate, localNames) {
  const base = installedContext(candidate, localNames);
  if (base.installedContextMatch && !String(candidate.family || '').startsWith('CUSTOM:')) return { ...candidate, ...base };

  const hits = [];
  for (const name of localNames || []) {
    const overlap = tokenOverlap(candidate.name || '', name);
    if (overlap.tokens.length >= 2 && overlap.count >= 2 && overlap.ratio >= 0.6) hits.push(String(name));
  }
  return { ...candidate, installedContextMatch: hits.length > 0, localMatches: hits.slice(0, 8) };
}

function candidateRuleMatches(candidate, rule) {
  if (!candidate || !rule) return false;
  if (String(rule.kind || '').toUpperCase() !== String(candidate.kind || '').toUpperCase()) return false;

  const candidateFileId = String(candidate.fileId || '');
  const ruleFileId = String(rule.auxFileId || '');
  const candidateModId = String(candidate.auxModId || '');
  const ruleModId = String(rule.auxModId || '');

  if (candidateFileId && ruleFileId) {
    if (candidateFileId !== ruleFileId) return false;
    if (candidateModId && ruleModId && candidateModId !== ruleModId) return false;
    return true;
  }
  if (!candidateFileId && candidateModId && ruleModId && candidateModId === ruleModId) return true;

  const rf = normalizeFamilyKey(rule.family || '');
  const cf = normalizeFamilyKey(candidate.family || '');
  return !!rf && rf !== '*' && rf === cf;
}

function resolveCandidate(candidate, rules) {
  const matching = (rules || []).filter(r => candidateRuleMatches(candidate, r));
  if (!matching.length) return { resolved: false, status: 'UNRESOLVED', rule: null };
  const resolved = matching.find(r => RESOLVED_STATUSES.has(String(r.status || '').toUpperCase()));
  if (!resolved) return { resolved: false, status: 'UNRESOLVED', rule: matching[0] };
  return { resolved: true, status: String(resolved.status).toUpperCase(), rule: resolved, source: 'REGISTRY' };
}

function effectiveDecision(candidate, rules) {
  const env = candidate?.environmentDecision;
  if (env?.resolved && env.source === 'ENVIRONMENT_GRAPH' && env.confidence === 'high' && env.status === 'NOT_APPLICABLE') {
    return {
      resolved: true,
      status: 'NOT_APPLICABLE',
      rule: null,
      source: 'ENVIRONMENT_GRAPH',
      reason: env.reason || 'PROFILE_NOT_APPLICABLE',
      evidence: env.evidence || [],
    };
  }
  return resolveCandidate(candidate, rules);
}

function looksLikeHistoricalSibling(candidate, context = {}) {
  if (String(candidate?.source || '') !== 'SAME_PAGE_FILE') return false;
  const mainVersion = context.mainVersion || '';
  if (!candidate?.version || !mainVersion) return false;
  if (compareVersions(candidate.version, mainVersion) >= 0) return false;
  const overlap = tokenOverlap(candidate.name || '', context.mainName || candidate.mainName || '');
  return overlap.count >= 1 && overlap.ratio >= 0.5;
}

function candidateRelevance(candidate, context = {}) {
  const c = candidate || {};
  const source = String(c.source || 'UNKNOWN').toUpperCase();
  const decision = c.decision || null;
  const envReason = String(c.environmentDecision?.reason || '');

  if (decision?.resolved && decision.status === 'REQUIRED') {
    return { blocking: true, disposition: 'BLOCKING_REQUIRED_RULE', reason: 'REGISTRY_REQUIRED' };
  }
  if (c.requiredHint || source === 'REQUIREMENTS_FORWARD') {
    return { blocking: true, disposition: 'BLOCKING_REQUIRED', reason: 'FORWARD_OR_EXPLICIT_REQUIRED' };
  }
  if (c.installed || ['INSTALLED_COMPONENT', 'LOCAL_FOMOD'].includes(source)) {
    return { blocking: true, disposition: 'BLOCKING_INSTALLED_CONTEXT', reason: 'EXACT_LOCAL_COMPONENT_EVIDENCE' };
  }
  if (looksLikeHistoricalSibling(c, context)) {
    return { blocking: false, disposition: 'NON_BLOCKING_HISTORICAL_SIBLING', reason: 'OLDER_SAME_PRODUCT_FILE' };
  }
  if (c.optionalHint) {
    return { blocking: false, disposition: 'NON_BLOCKING_OPTIONAL', reason: 'EXPLICIT_OPTIONAL_NOT_EXACTLY_INSTALLED' };
  }
  if (c.installedContextMatch) {
    return { blocking: true, disposition: 'BLOCKING_INSTALLED_CONTEXT', reason: 'STRONG_ACTIVE_CONTEXT_MATCH' };
  }
  if (source === 'RELATION_REGISTRY') {
    return { blocking: true, disposition: 'BLOCKING_LEARNED_RELATION', reason: 'CURATED_RELATION_EVIDENCE' };
  }
  if (envReason === 'COMPAT_COUNTERPART_ENABLED') {
    return { blocking: true, disposition: 'BLOCKING_ACTIVE_COUNTERPART', reason: envReason };
  }
  if (source === 'REQUIREMENTS_REVERSE') {
    return { blocking: false, disposition: 'NON_BLOCKING_REVERSE_UNINSTALLED', reason: 'DOWNSTREAM_MOD_NOT_ACTIVE' };
  }
  if (source === 'DESCRIPTION_TEXT') {
    return { blocking: false, disposition: 'NON_BLOCKING_DESCRIPTION_WEAK', reason: 'TEXT_ONLY_NO_REQUIRED_OR_LOCAL_MATCH' };
  }
  if (source === 'DESCRIPTION_LINK') {
    if (c.kind === 'TRANSLATION' && c.family === 'ZH_CN') {
      return { blocking: true, disposition: 'BLOCKING_TRANSLATION_LINK', reason: 'DIRECT_ZH_CN_TRANSLATION' };
    }
    return { blocking: false, disposition: 'NON_BLOCKING_DESCRIPTION_LINK', reason: 'LINK_ONLY_NO_REQUIRED_OR_LOCAL_MATCH' };
  }

  return { blocking: true, disposition: 'BLOCKING_DISCOVERED', reason: 'DIRECT_COMPONENT_EVIDENCE' };
}

function assessComponentDiscovery({ candidates, rules, coverage, mainVersion = '', mainName = '' }) {
  const context = { mainVersion, mainName };
  const assessed = (candidates || []).map(c => {
    const decision = effectiveDecision(c, rules);
    const withDecision = { ...c, decision };
    return { ...withDecision, relevance: candidateRelevance(withDecision, context) };
  });
  const blockingCandidates = assessed.filter(c => c.relevance?.blocking !== false);
  const nonBlocking = assessed.filter(c => c.relevance?.blocking === false);
  const unresolved = blockingCandidates.filter(c => !c.decision.resolved);
  const coverageProblems = Object.entries(coverage || {})
    .filter(([, v]) => v && v.required && !v.complete)
    .map(([source, v]) => ({ source, status: v.status || 'INCOMPLETE', detail: v.detail || '' }));
  return {
    candidates: assessed,
    blockingCandidates,
    nonBlocking,
    unresolved,
    coverageProblems,
    coverageComplete: coverageProblems.length === 0,
    complete: coverageProblems.length === 0 && unresolved.length === 0,
  };
}

function countsByKind(candidates) {
  const out = {};
  for (const c of candidates || []) out[c.kind] = (out[c.kind] || 0) + 1;
  return out;
}

module.exports = {
  COMPONENT_KINDS,
  RESOLVED_STATUSES,
  classifyComponent,
  componentFamily,
  candidateKey,
  mergeComponentCandidates,
  withInstalledContext,
  candidateRuleMatches,
  resolveCandidate,
  effectiveDecision,
  candidateRelevance,
  looksLikeHistoricalSibling,
  assessComponentDiscovery,
  countsByKind,
};
