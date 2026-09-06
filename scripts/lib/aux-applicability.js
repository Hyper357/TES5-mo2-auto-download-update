'use strict';

const { enabledContextNames, matchFamilyInEnvironment } = require('./mo2-environment');
const { tokens } = require('./patch-discovery');

function parseClosureAux(row) {
  const m = String(row?.note || '').match(/(?:^|;\s*)closure:(PATCH|HOTFIX)(?::([^;\s]+))?/i);
  return m ? { kind: m[1].toUpperCase(), family: String(m[2] || '').toUpperCase() } : null;
}

function customFamilyState(graph, family) {
  if (!graph?.profile?.usableForApplicability) return { status: 'UNKNOWN', reason: 'PROFILE_UNRESOLVED', hits: [] };
  const parts = String(family || '').replace(/^CUSTOM:/i, '').toLowerCase().split(/[_\s-]+/).filter(x => x.length >= 3);
  if (parts.length < 2) return { status: 'UNKNOWN', reason: 'CUSTOM_FAMILY_TOO_GENERIC', hits: [] };
  const hits = [];
  for (const name of enabledContextNames(graph)) {
    const nt = new Set(tokens(name));
    const count = parts.filter(p => nt.has(p)).length;
    if (count >= 2 && count / parts.length >= 0.75) hits.push(name);
  }
  return hits.length
    ? { status: 'ENABLED', reason: 'CUSTOM_COUNTERPART_ENABLED', hits }
    : { status: 'UNKNOWN', reason: 'CUSTOM_COUNTERPART_NOT_PROVEN', hits: [] };
}

function assessAuxRowEnvironment(row, graph) {
  const parsed = parseClosureAux(row);
  if (!parsed) return { decision: 'ALLOW', reason: 'NOT_COMPAT_PATCH_AUX' };
  if (!parsed.family || parsed.family === 'GENERAL') return { decision: 'HOLD', reason: 'PATCH_FAMILY_UNRESOLVED', ...parsed };

  let state = matchFamilyInEnvironment(graph, parsed.family);
  if (state.reason === 'FAMILY_NOT_CANONICAL' && parsed.family.startsWith('CUSTOM:')) {
    state = customFamilyState(graph, parsed.family);
  }

  if (state.status === 'ENABLED') return { decision: 'ALLOW', reason: state.reason, evidence: state.enabledHits || state.hits || [], ...parsed };
  if (state.status === 'ABSENT' || state.status === 'DISABLED_ONLY') {
    return { decision: 'SKIP', reason: state.reason, evidence: [...(state.disabledHits || []), ...(state.unknownHits || [])], ...parsed };
  }
  return { decision: 'HOLD', reason: state.reason || 'PATCH_APPLICABILITY_UNPROVEN', evidence: state.unknownHits || state.hits || [], ...parsed };
}

module.exports = { parseClosureAux, customFamilyState, assessAuxRowEnvironment };
