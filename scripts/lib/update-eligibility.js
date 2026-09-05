'use strict';

const { compareVersions, normalizeVer } = require('./semver');
const { categoryRole, isActive, scoreCandidate } = require('./file-selector');

const MO2_ACTIVE_FILE_STATUSES = new Set([1, 2, 3, 5]);

function validVersion(v) {
  const n = normalizeVer(v);
  return !!n && !['0', 'unknown', 'none', 'null'].includes(n);
}

function versionEqual(a, b) {
  return validVersion(a) && validVersion(b) && compareVersions(a, b) === 0;
}

function mo2UpdateSignal(meta = {}) {
  const version = meta.version || meta.installedVersion || '';
  const newestVersion = meta.newestVersion || '';
  const ignoredVersion = meta.ignoredVersion || '';
  const rawStatus = Number(meta.nexusFileStatus);
  const statusKnown = Number.isFinite(rawStatus) && rawStatus > 0;
  const ignored = versionEqual(ignoredVersion, newestVersion);

  if (ignored) {
    return {
      signal: false,
      ignored: true,
      reason: 'IGNORED_VERSION',
      version,
      newestVersion,
      ignoredVersion,
      nexusFileStatus: statusKnown ? rawStatus : null,
    };
  }

  if (statusKnown && !MO2_ACTIVE_FILE_STATUSES.has(rawStatus)) {
    return {
      signal: true,
      ignored: false,
      reason: 'INSTALLED_FILE_STATUS_INACTIVE',
      version,
      newestVersion,
      ignoredVersion,
      nexusFileStatus: rawStatus,
    };
  }

  if (validVersion(version) && validVersion(newestVersion) && compareVersions(version, newestVersion) < 0) {
    return {
      signal: true,
      ignored: false,
      reason: 'NEWEST_VERSION_GREATER',
      version,
      newestVersion,
      ignoredVersion,
      nexusFileStatus: statusKnown ? rawStatus : null,
    };
  }

  return {
    signal: false,
    ignored: false,
    reason: validVersion(newestVersion) ? 'MO2_NO_UPDATE' : 'MO2_NEWEST_VERSION_UNKNOWN',
    version,
    newestVersion,
    ignoredVersion,
    nexusFileStatus: statusKnown ? rawStatus : null,
  };
}

function normalizeUpdateEdge(raw) {
  if (!raw) return null;
  const oldId = String(raw.old_file_id ?? raw.oldFileId ?? raw.oldFileID ?? '').trim();
  const newId = String(raw.new_file_id ?? raw.newFileId ?? raw.newFileID ?? '').trim();
  if (!oldId || !newId || oldId === newId) return null;
  return {
    oldFileId: oldId,
    newFileId: newId,
    oldFileName: raw.old_file_name || raw.oldFileName || '',
    newFileName: raw.new_file_name || raw.newFileName || '',
    uploadedTimestamp: raw.uploaded_timestamp || raw.uploadedTimestamp || null,
    uploadedTime: raw.uploaded_time || raw.uploadedTime || '',
  };
}

function updateChainSuccessors(installedFileId, updates = []) {
  const start = String(installedFileId || '');
  if (!start) return [];
  const byOld = new Map();
  for (const raw of updates || []) {
    const e = normalizeUpdateEdge(raw);
    if (!e) continue;
    if (!byOld.has(e.oldFileId)) byOld.set(e.oldFileId, []);
    byOld.get(e.oldFileId).push(e);
  }

  const out = [];
  const queue = [start];
  const visited = new Set([start]);
  while (queue.length) {
    const oldId = queue.shift();
    for (const e of byOld.get(oldId) || []) {
      if (visited.has(e.newFileId)) continue;
      visited.add(e.newFileId);
      out.push({ ...e, depth: out.length + 1 });
      queue.push(e.newFileId);
    }
  }
  return out;
}

function uploadedMs(file) {
  const t = Date.parse(file?.uploaded_time || file?.uploadedTime || '');
  if (Number.isFinite(t)) return t;
  const n = Number(file?.uploaded_timestamp || file?.uploadedTimestamp || 0);
  return Number.isFinite(n) && n > 0 ? n * (n < 1e12 ? 1000 : 1) : 0;
}

function compactFile(file) {
  if (!file) return null;
  return {
    fileId: String(file.file_id || ''),
    name: file.name || file.file_name || '',
    fileName: file.file_name || '',
    version: file.version || '',
    categoryId: Number(file.category_id || 0),
    category: file.category_name || '',
    role: categoryRole(file),
    uploadedTime: file.uploaded_time || '',
  };
}

function chainCandidate({ files, fileUpdates, mine, localName = '', installationFile = '', profile = null }) {
  const filesById = new Map((files || []).map(f => [String(f.file_id || ''), f]));
  const successors = updateChainSuccessors(mine?.file_id, fileUpdates);
  const reachable = [];
  for (const edge of successors) {
    const f = filesById.get(edge.newFileId);
    if (!f || !isActive(f)) continue;
    const scored = scoreCandidate({ mine, candidate: f, localName, installationFile, profile });
    reachable.push({ edge, file: f, scored });
  }
  if (!reachable.length) return { candidate: null, successors, conflicts: [] };

  const accepted = reachable.filter(x => x.scored.accepted);
  if (!accepted.length) {
    const conflicts = [...new Set(reachable.flatMap(x => x.scored.rejects || []))];
    return { candidate: null, successors, conflicts };
  }
  accepted.sort((a, b) => uploadedMs(b.file) - uploadedMs(a.file) || Number(b.file.file_id || 0) - Number(a.file.file_id || 0));
  return { candidate: accepted[0].file, successors, conflicts: [] };
}

function fallbackNewerCandidate({ files, mine, localName = '', installationFile = '', profile = null }) {
  const mineTime = uploadedMs(mine);
  const candidates = [];
  for (const f of files || []) {
    if (!f || String(f.file_id || '') === String(mine?.file_id || '') || !isActive(f)) continue;
    const scored = scoreCandidate({ mine, candidate: f, localName, installationFile, profile });
    if (!scored.accepted || scored.score < 58) continue;
    const t = uploadedMs(f);
    // Version strings are author metadata. They cannot by themselves prove an update.
    if (!(t > mineTime && t > 0)) continue;
    candidates.push({ file: f, ...scored, uploadedMs: t });
  }
  candidates.sort((a, b) => b.score - a.score || b.uploadedMs - a.uploadedMs || Number(b.file.file_id || 0) - Number(a.file.file_id || 0));
  if (!candidates.length) return { candidate: null, ranked: [] };
  const best = candidates[0];
  const second = candidates[1];
  const margin = second ? best.score - second.score : best.score;
  if (second && margin < 10) return { candidate: null, ranked: candidates.slice(0, 8), ambiguous: true, margin };
  return { candidate: best.file, ranked: candidates.slice(0, 8), ambiguous: false, margin };
}

function ignoredTarget(meta, target) {
  if (!versionEqual(meta?.ignoredVersion, meta?.newestVersion)) return false;
  if (!validVersion(target?.version)) return true;
  // Respect an ignored MO2 version, but allow a genuinely later version to surface again.
  return compareVersions(target.version, meta.ignoredVersion) <= 0;
}

function assessUpdateEligibility({ files = [], fileUpdates = [], mine, meta = {}, localName = '', installationFile = '', profile = null }) {
  const mo2 = mo2UpdateSignal(meta);
  if (!mine) {
    return {
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: 'LOCAL_FILE_IDENTITY_UNRESOLVED',
      updateNeeded: false,
      priority: mo2.signal ? 60 : 20,
      mo2,
      target: null,
      evidence: [],
    };
  }

  const chain = chainCandidate({ files, fileUpdates, mine, localName, installationFile, profile });
  if (chain.candidate) {
    const target = chain.candidate;
    if (ignoredTarget(meta, target)) {
      return {
        status: 'SKIP_IGNORED_UPDATE',
        reason: 'MO2_IGNORED_VERSION_MATCHES_TARGET',
        updateNeeded: false,
        priority: 0,
        mo2,
        target: compactFile(target),
        evidence: ['NEXUS_EXACT_UPDATE_CHAIN', 'MO2_IGNORED_VERSION'],
      };
    }
    return {
      status: 'UPDATE_CONFIRMED',
      reason: 'NEXUS_EXACT_UPDATE_CHAIN',
      updateNeeded: true,
      priority: mo2.signal ? 100 : 92,
      mo2,
      target: compactFile(target),
      evidence: ['NEXUS_EXACT_UPDATE_CHAIN', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
      chainDepth: chain.successors.length,
    };
  }

  if (chain.conflicts.length) {
    return {
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: 'NEXUS_UPDATE_CHAIN_VARIANT_CONFLICT',
      updateNeeded: false,
      priority: mo2.signal ? 75 : 45,
      mo2,
      target: null,
      evidence: ['NEXUS_EXACT_UPDATE_CHAIN', 'VARIANT_CONFLICT'],
      conflicts: chain.conflicts,
    };
  }

  const fallback = fallbackNewerCandidate({ files, mine, localName, installationFile, profile });
  if (fallback.candidate) {
    const target = fallback.candidate;
    if (ignoredTarget(meta, target)) {
      return {
        status: 'SKIP_IGNORED_UPDATE',
        reason: 'MO2_IGNORED_VERSION_MATCHES_TARGET',
        updateNeeded: false,
        priority: 0,
        mo2,
        target: compactFile(target),
        evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', 'MO2_IGNORED_VERSION'],
      };
    }
    const sameVersion = validVersion(target.version) && validVersion(mine.version) && compareVersions(target.version, mine.version) === 0;
    return {
      status: sameVersion ? 'HOLD_UPDATE_ELIGIBILITY' : 'UPDATE_CONFIRMED',
      reason: sameVersion ? 'SAME_VERSION_NEWER_FILE_REPLACEMENT' : 'NEWER_COMPATIBLE_FILE_UPLOAD',
      updateNeeded: !sameVersion,
      priority: sameVersion ? (mo2.signal ? 80 : 55) : (mo2.signal ? 96 : 84),
      mo2,
      target: compactFile(target),
      evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
      margin: fallback.margin,
    };
  }

  if (fallback.ambiguous) {
    return {
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: 'MULTIPLE_NEWER_COMPATIBLE_FILES',
      updateNeeded: false,
      priority: mo2.signal ? 78 : 50,
      mo2,
      target: null,
      evidence: ['NEWER_FILE_UPLOADS_AMBIGUOUS', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
      candidates: fallback.ranked.map(x => compactFile(x.file)),
    };
  }

  if (mo2.signal) {
    return {
      status: 'SKIP_METADATA_FALSE_POSITIVE',
      reason: 'MO2_SIGNAL_WITHOUT_NEWER_EXACT_OR_COMPATIBLE_FILE',
      updateNeeded: false,
      priority: 5,
      mo2,
      target: compactFile(mine),
      evidence: ['MO2_UPDATE_SIGNAL_ONLY'],
    };
  }

  return {
    status: 'SKIP_UP_TO_DATE',
    reason: 'NO_NEWER_EXACT_OR_COMPATIBLE_FILE',
    updateNeeded: false,
    priority: 0,
    mo2,
    target: compactFile(mine),
    evidence: ['EXACT_LOCAL_FILE', 'NO_NEWER_FILE_EVIDENCE'],
  };
}

function eligibilityCounts(items = []) {
  const out = {};
  for (const item of items) {
    const key = item?.updateEligibility?.status || item?.status || 'UNKNOWN';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = {
  MO2_ACTIVE_FILE_STATUSES,
  validVersion,
  mo2UpdateSignal,
  normalizeUpdateEdge,
  updateChainSuccessors,
  assessUpdateEligibility,
  eligibilityCounts,
};
