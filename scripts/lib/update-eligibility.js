'use strict';

const { categoryRole, isActive, tokenSimilarity } = require('./file-selector');
const { branchKey } = require('./variant-review');
const { compareVersions } = require('./semver');

const UPDATE_STATES = Object.freeze({
  CURRENT: 'CURRENT_CONFIRMED',
  UPDATE: 'UPDATE_CONFIRMED',
  IGNORED: 'UPDATE_IGNORED',
  UNCERTAIN: 'UPDATE_UNCERTAIN',
  FALSE_POSITIVE: 'MO2_HINT_FALSE_POSITIVE',
});

function timeMs(v) {
  const n = Date.parse(String(v || ''));
  return Number.isFinite(n) ? n : 0;
}

function versionCmp(a, b) {
  try { return compareVersions(String(a || ''), String(b || '')); }
  catch { return 0; }
}

function normalizeVersion(v) {
  return String(v || '').trim();
}

function mo2UpdateHint(meta = {}) {
  const installed = normalizeVersion(meta.installedVersion ?? meta.version);
  const newest = normalizeVersion(meta.newestVersion);
  const ignored = normalizeVersion(meta.ignoredVersion);
  const fileStatus = Number(meta.nexusFileStatus ?? 0) || 0;
  const cmp = installed && newest ? versionCmp(newest, installed) : 0;
  const ignoredMatches = !!(ignored && newest && ignored === newest);
  return {
    installedVersion: installed,
    newestVersion: newest,
    ignoredVersion: ignored,
    nexusFileStatus: fileStatus,
    versionSuggestsUpdate: cmp > 0,
    versionSuggestsDowngrade: cmp < 0,
    ignoredMatches,
    // This is an evidence-level approximation of MO2's visible update arrow, not a UI scrape.
    wouldShowUpdateArrow: cmp > 0 && !ignoredMatches,
    metadataOnly: true,
  };
}

function sameSemanticLane(file, mine, localName = '') {
  if (!file || !mine || !isActive(file)) return false;
  const mineRole = categoryRole(mine);
  if (categoryRole(file) !== mineRole) return false;

  if (mineRole === 'MAIN') {
    const a = branchKey(mine);
    const b = branchKey(file);
    if (a !== 'GENERIC' || b !== 'GENERIC') return a === b;

    // Generic Main pages are the dangerous case: require strong lexical continuity instead of
    // treating every Main File as the same branch.
    const mineText = `${mine.name || ''} ${mine.file_name || ''}`;
    const fileText = `${file.name || ''} ${file.file_name || ''}`;
    const localText = `${localName || ''} ${mineText}`;
    return tokenSimilarity(localText, fileText) >= 0.52;
  }

  // Patch/translation/component pages usually expose their installed artifact as Main on that page.
  // For non-Main roles, exact role + reasonable name continuity is sufficient for eligibility;
  // final selection still has its own stricter gate.
  const mineText = `${mine.name || ''} ${mine.file_name || ''}`;
  const fileText = `${file.name || ''} ${file.file_name || ''}`;
  return tokenSimilarity(`${localName || ''} ${mineText}`, fileText) >= 0.38;
}

function evidenceForCandidate(file, mine) {
  const mineTime = timeMs(mine.uploaded_time);
  const candidateTime = timeMs(file.uploaded_time);
  const cmp = versionCmp(file.version, mine.version);
  const newerByTime = !!(mineTime && candidateTime && candidateTime > mineTime);
  const newerByVersion = cmp > 0;
  return {
    fileId: String(file.file_id || ''),
    name: file.name || file.file_name || '',
    fileName: file.file_name || '',
    version: file.version || '',
    uploadedTime: file.uploaded_time || '',
    newerByTime,
    newerByVersion,
    role: categoryRole(file),
    branchKey: categoryRole(file) === 'MAIN' ? branchKey(file) : '',
  };
}

function assessUpdateEligibility({ files, mine, localName = '', meta = {} }) {
  const hint = mo2UpdateHint(meta);
  if (!mine || !mine.file_id) {
    return {
      state: UPDATE_STATES.UNCERTAIN,
      eligible: false,
      confidence: 'low',
      reason: 'EXACT_INSTALLED_FILE_NOT_RESOLVED',
      mo2Hint: hint,
      installed: null,
      newerCandidates: [],
    };
  }

  const installed = evidenceForCandidate(mine, mine);
  const lane = (files || [])
    .filter(f => String(f.file_id || '') !== String(mine.file_id || ''))
    .filter(f => sameSemanticLane(f, mine, localName))
    .map(f => evidenceForCandidate(f, mine));
  const newer = lane
    .filter(x => x.newerByTime || x.newerByVersion)
    .sort((a, b) => timeMs(b.uploadedTime) - timeMs(a.uploadedTime) || versionCmp(b.version, a.version) || Number(b.fileId || 0) - Number(a.fileId || 0));

  const activeSameRole = (files || []).filter(f => isActive(f) && categoryRole(f) === categoryRole(mine));
  const genericMainAmbiguity = categoryRole(mine) === 'MAIN' && branchKey(mine) === 'GENERIC' && activeSameRole.length > 1 && lane.length === 0;

  if (newer.length) {
    const state = hint.ignoredMatches ? UPDATE_STATES.IGNORED : UPDATE_STATES.UPDATE;
    return {
      state,
      eligible: state === UPDATE_STATES.UPDATE,
      confidence: 'high',
      reason: newer[0].newerByTime ? 'NEWER_EXACT_FILE_IN_SAME_LANE_BY_UPLOAD_TIME' : 'NEWER_EXACT_FILE_IN_SAME_LANE_BY_FILE_VERSION',
      mo2Hint: hint,
      installed,
      newerCandidates: newer.slice(0, 12),
      mo2Agreement: hint.wouldShowUpdateArrow ? 'AGREES' : 'MO2_MISSED_EXACT_UPDATE',
    };
  }

  if (genericMainAmbiguity) {
    return {
      state: UPDATE_STATES.UNCERTAIN,
      eligible: false,
      confidence: 'low',
      reason: 'GENERIC_MAIN_BRANCH_AMBIGUOUS',
      mo2Hint: hint,
      installed,
      newerCandidates: [],
      sameRoleCandidates: activeSameRole.slice(0, 12).map(f => evidenceForCandidate(f, mine)),
    };
  }

  if (hint.wouldShowUpdateArrow) {
    return {
      state: UPDATE_STATES.FALSE_POSITIVE,
      eligible: false,
      confidence: 'high',
      reason: 'MO2_VERSION_HINT_NOT_CONFIRMED_BY_EXACT_FILE_LANE',
      mo2Hint: hint,
      installed,
      newerCandidates: [],
      mo2Agreement: 'DISAGREES',
    };
  }

  return {
    state: UPDATE_STATES.CURRENT,
    eligible: false,
    confidence: 'high',
    reason: 'NO_NEWER_EXACT_FILE_IN_SAME_LANE',
    mo2Hint: hint,
    installed,
    newerCandidates: [],
    mo2Agreement: 'NO_UPDATE_HINT',
  };
}

module.exports = {
  UPDATE_STATES,
  mo2UpdateHint,
  sameSemanticLane,
  assessUpdateEligibility,
};
