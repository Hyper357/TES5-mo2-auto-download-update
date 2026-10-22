'use strict';

const { compareVersions, normalizeVer } = require('./semver');
const { categoryRole, isActive, scoreCandidate } = require('./file-selector');
const { runtimeCompatRejects, branchCompatRejects, versionCore, compareNumericVersions, parseRequiredRuntimes, defaultLocalRuntime } = require('./runtime-compat');

const MO2_ACTIVE_FILE_STATUSES = new Set([1, 2, 3, 5]);

// Runtime evidence labels. Only EMPTY_DESCRIPTION and NO_RUNTIME_CLAIM mean
// "the gate had nothing to check"; neither one ever rejects anything.
const RUNTIME_EVIDENCE_STATUSES = new Set(['EMPTY_DESCRIPTION', 'NO_RUNTIME_CLAIM', 'EVIDENCED', 'REJECTED']);

function validVersion(v) {
  const n = normalizeVer(v);
  return !!n && !['0', 'unknown', 'none', 'null'].includes(n);
}

function versionEqual(a, b) {
  return validVersion(a) && validVersion(b) && compareVersions(a, b) === 0;
}

function normalizeArchiveIdentity(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/').pop()
    .replace(/\.(?:7z|zip|rar)$/i, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function installationFileMatchesTarget(installationFile, target) {
  const local = normalizeArchiveIdentity(installationFile);
  const remote = normalizeArchiveIdentity(target?.file_name || target?.fileName || '');
  return !!local && !!remote && local === remote;
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
  const queue = [{ id: start, depth: 0 }];
  const visited = new Set([start]);
  while (queue.length) {
    const current = queue.shift();
    for (const e of byOld.get(current.id) || []) {
      if (visited.has(e.newFileId)) continue;
      visited.add(e.newFileId);
      const depth = current.depth + 1;
      out.push({ ...e, depth });
      queue.push({ id: e.newFileId, depth });
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

function compatibilityProbe({ mine, candidate, localName = '', installationFile = '', profile = null }) {
  const probe = { ...candidate, version: mine?.version || candidate?.version || '' };
  return scoreCandidate({ mine, candidate: probe, localName, installationFile, profile });
}

// Readable-text view of a Nexus description. Used ONLY to decide whether the
// candidate carries description text at all (see candidateRuntimeEvidence).
// The gate itself still scans the raw description, so this can never hide a
// real runtime claim; it can only move markup-only descriptions ("<p></p>",
// "&nbsp;") from "text but no claim" to the more honest EMPTY_DESCRIPTION.
function readableDescText(description) {
  return String(description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every runtime/SKSE version the description actually states, folded into one
// flat list so a reviewer can see WHICH requirement the gate evaluated. The
// parsing itself is NOT re-implemented here: parseRequiredRuntimes is the same
// function runtimeCompatRejects uses, so `required` can never disagree with the
// gate it describes.
function statedRequirements(descText) {
  const parsed = parseRequiredRuntimes(descText);
  const out = [];
  const seen = new Set();
  const push = (kind, version, via) => {
    const v = String(version || '').trim();
    if (!v) return;
    const key = `${kind}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, version: v, via });
  };
  for (const v of parsed.skseVersions) push('SKSE', v, 'SKSE_MENTION');
  for (const v of parsed.hardRuntimeVersions) push('RUNTIME', v, 'HARD_PHRASE');
  for (const v of parsed.adaptedRuntimeVersions) push('RUNTIME', v, 'ADAPTED_PHRASE');
  for (const v of parsed.forRuntimeVersions) push('RUNTIME', v, 'FOR_PHRASE');
  for (const v of parsed.runtimeVersions) push('RUNTIME', v, 'MENTION');
  return out;
}

// The two scalars the gate compares against, detached from whatever provenance
// fields the baseline resolver happens to attach, so this label's own shape
// stays stable.
function localRuntimeBaseline() {
  const local = defaultLocalRuntime();
  return { skse: local?.skse || '', runtime: local?.runtime || '' };
}

// What the runtime gate actually SAW for one candidate file. This is a pure
// label: it reports evidence quality, it never decides anything.
//   EMPTY_DESCRIPTION - the description is missing/blank, so the gate had
//                       nothing to check at all (it does NOT reject).
//   NO_RUNTIME_CLAIM  - readable text, but no runtime/SKSE version stated.
//   EVIDENCED         - at least one stated requirement, all <= local
//                       baseline, so the gate really checked and let it pass.
//   REJECTED          - the gate produced compatRejects (reason/quote there).
// "no reject" used to conflate EVIDENCED with the two no-evidence states; this
// object is what makes them distinguishable to a human reviewer.
//
// Emptiness is judged on the HTML-stripped text (see readableDescText), which
// is strictly narrower than what the gate scans: the gate always sees the raw
// description. A markup-only file therefore reports EMPTY_DESCRIPTION, which
// is the truthful answer -- the gate really had nothing to read.
function candidateRuntimeEvidence(file, rejects = []) {
  const descText = String(file?.description || '');
  const readable = readableDescText(descText);
  const required = statedRequirements(descText);
  let status;
  if (rejects && rejects.length) status = 'REJECTED';
  else if (!readable) status = 'EMPTY_DESCRIPTION';
  else if (!required.length) status = 'NO_RUNTIME_CLAIM';
  else status = 'EVIDENCED';
  return {
    status,
    fileId: String(file?.file_id || ''),
    descChars: readable.length,
    required,
    local: localRuntimeBaseline(),
  };
}

// Compatibility gate on top of name scoring: a candidate must not require a
// newer SKSE/runtime than the local installation, and must not switch AE/SE
// edition branches. Uses the full Nexus file (description included).
// Returns the rejects plus the evidence label describing this same check.
function candidateCompatGate({ file, mine, localName = '', installationFile = '' }) {
  const localText = [localName, installationFile, mine?.name, mine?.file_name, mine?.version].join(' ');
  const candText = [file?.description, file?.file_name, file?.name, file?.version].join(' ');
  // Runtime evidence comes from the DESCRIPTION only. The version field and
  // version-suffixed file names are full of MOD version numbers (1.5-1.9
  // range) that are not runtime requirements — scanning them produced mass
  // false TARGET_REQUIRES_NEWER_RUNTIME positives (e.g. "Skyrim 3D Furniture
  // 1.9.0" rejected because its own version looked like "runtime 1.9").
  const descText = String(file?.description || '');
  const rejects = [...runtimeCompatRejects(descText), ...branchCompatRejects(localText, candText)];
  return { rejects, runtimeEvidence: candidateRuntimeEvidence(file, rejects) };
}

// Array-only view of the same gate, kept for callers that only need rejects.
function candidateCompatRejects(args) {
  return candidateCompatGate(args).rejects;
}

// `runtimeEvidence=...` token for the human-readable plan note. The existing
// note tokens stay byte-identical; this is one extra '; '-separated field.
function runtimeEvidenceNote(eligibility) {
  const status = String(eligibility?.runtimeEvidence?.status || '');
  if (!status) return '';
  return `runtimeEvidence=${status}`;
}

// Attach the evidence label additively. A null/absent label leaves the
// decision object byte-identical to what it was before this feature existed.
function withRuntimeEvidence(result, evidence) {
  if (!evidence) return result;
  return { ...result, runtimeEvidence: evidence };
}

function chainCandidate({ files, fileUpdates, mine, localName = '', installationFile = '', profile = null, meta = null }) {
  const filesById = new Map((files || []).map(f => [String(f.file_id || ''), f]));
  const successors = updateChainSuccessors(mine?.file_id, fileUpdates);
  const reachable = [];
  for (const edge of successors) {
    const f = filesById.get(edge.newFileId);
    if (!f || !isActive(f)) continue;
    const scored = compatibilityProbe({ mine, candidate: f, localName, installationFile, profile });
    reachable.push({ edge, file: f, scored });
  }
  if (!reachable.length) return { candidate: null, successors, conflicts: [], compatRejects: [] };

  const accepted = [];
  const compatRejects = [];
  let rejectedEvidence = null;
  for (const x of reachable) {
    if (!x.scored.accepted) continue;
    // A user-ignored version keeps its IGNORE semantics even when the same
    // file would fail the runtime/edition gate: silence wins, SKIP_IGNORED
    // is emitted downstream instead of compat noise.
    if (meta && ignoredTarget(meta, x.file)) {
      accepted.push(x);
      continue;
    }
    const gate = candidateCompatGate({ file: x.file, mine, localName, installationFile });
    if (gate.rejects.length) {
      compatRejects.push(...gate.rejects);
      if (!rejectedEvidence) rejectedEvidence = gate.runtimeEvidence;
      continue;
    }
    accepted.push(x);
  }
  if (!accepted.length) {
    const conflicts = [...new Set(reachable.flatMap(x => x.scored.rejects || []))];
    return { candidate: null, successors, conflicts, compatRejects, runtimeEvidence: rejectedEvidence };
  }

  accepted.sort((a, b) => b.edge.depth - a.edge.depth || uploadedMs(b.file) - uploadedMs(a.file) || Number(b.file.file_id || 0) - Number(a.file.file_id || 0));
  return { candidate: accepted[0].file, successors, conflicts: [], compatRejects, runtimeEvidence: candidateRuntimeEvidence(accepted[0].file) };
}

function fallbackNewerCandidate({ files, mine, localName = '', installationFile = '', profile = null, meta = null }) {
  const mineTime = uploadedMs(mine);
  const candidates = [];
  const compatRejects = [];
  let rejectedEvidence = null;
  for (const f of files || []) {
    if (!f || String(f.file_id || '') === String(mine?.file_id || '') || !isActive(f)) continue;
    const scored = compatibilityProbe({ mine, candidate: f, localName, installationFile, profile });
    if (!scored.accepted || scored.score < 58) continue;
    const gate = candidateCompatGate({ file: f, mine, localName, installationFile });
    if (gate.rejects.length && !(meta && ignoredTarget(meta, f))) {
      compatRejects.push(...gate.rejects);
      if (!rejectedEvidence) rejectedEvidence = gate.runtimeEvidence;
      continue;
    }
    const t = uploadedMs(f);
    if (!(t > mineTime && t > 0)) continue;
    candidates.push({ file: f, ...scored, uploadedMs: t, runtimeEvidence: gate.runtimeEvidence });
  }
  candidates.sort((a, b) => b.score - a.score || b.uploadedMs - a.uploadedMs || Number(b.file.file_id || 0) - Number(a.file.file_id || 0));
  if (!candidates.length) return { candidate: null, ranked: [], compatRejects, runtimeEvidence: rejectedEvidence };
  const best = candidates[0];
  const second = candidates[1];
  const margin = second ? best.score - second.score : best.score;
  if (second && margin < 10) return { candidate: null, ranked: candidates.slice(0, 8), ambiguous: true, margin, compatRejects, runtimeEvidence: best.runtimeEvidence };
  return { candidate: best.file, ranked: candidates.slice(0, 8), ambiguous: false, margin, compatRejects, runtimeEvidence: best.runtimeEvidence };
}

function ignoredTarget(meta, target) {
  if (!versionEqual(meta?.ignoredVersion, meta?.newestVersion)) return false;
  if (!validVersion(target?.version)) return true;
  if (compareVersions(target.version, meta.ignoredVersion) <= 0) return true;
  // Suffix noise ("2.2light" vs ignored "2.2.0.0light", "v1.9.1-SE" vs
  // "1.9.1.0-SE"): raw compareVersions may rank the suffixed string as
  // "newer" even though the release number did not move. Numeric-core
  // equality still counts as "not newer than the ignored version".
  const coreT = versionCore(target.version);
  const coreI = versionCore(meta.ignoredVersion);
  if (coreT && coreI) return compareNumericVersions(coreT, coreI) <= 0;
  return false;
}

function localTargetVersionConflict(meta, mine, target) {
  const localVersion = meta?.version || meta?.installedVersion || '';
  if (!validVersion(localVersion) || !validVersion(target?.version)) return null;
  if (String(mine?.file_id || '') === String(target?.file_id || '')) return null;
  const cmp = compareVersions(localVersion, target.version);
  if (cmp === 0) {
    const installationFile = meta?.installationFile || meta?.instFile || '';
    if (installationFileMatchesTarget(installationFile, target)) {
      return {
        reason: 'HIGH_CONFIDENCE_METADATA_DRIFT_UP_TO_DATE',
        localVersion,
        resolvedFileId: String(mine?.file_id || ''),
        resolvedVersion: mine?.version || '',
        targetFileId: String(target?.file_id || ''),
        targetVersion: target?.version || '',
        installationFile,
        metadataDrift: true,
      };
    }
    return {
      reason: 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT',
      localVersion,
      resolvedFileId: String(mine?.file_id || ''),
      resolvedVersion: mine?.version || '',
      targetFileId: String(target?.file_id || ''),
      targetVersion: target?.version || '',
    };
  }
  if (cmp > 0) {
    return {
      reason: 'LOCAL_VERSION_NEWER_THAN_TARGET',
      localVersion,
      resolvedFileId: String(mine?.file_id || ''),
      resolvedVersion: mine?.version || '',
      targetFileId: String(target?.file_id || ''),
      targetVersion: target?.version || '',
    };
  }
  return null;
}

function localConflictDecision({ conflict, target, mo2, sourceEvidence }) {
  if (conflict.reason === 'HIGH_CONFIDENCE_METADATA_DRIFT_UP_TO_DATE') {
    return {
      status: 'SKIP_UP_TO_DATE',
      reason: conflict.reason,
      updateNeeded: false,
      priority: 0,
      mo2,
      target: compactFile(target),
      evidence: [...sourceEvidence, 'LOCAL_VERSION_MATCHES_TARGET', 'INSTALLATION_FILE_MATCHES_EXACT_TARGET'],
      metadataDrift: conflict,
    };
  }
  return {
    status: 'HOLD_UPDATE_ELIGIBILITY',
    reason: conflict.reason,
    updateNeeded: false,
    priority: 90,
    mo2,
    target: compactFile(target),
    evidence: [...sourceEvidence, 'LOCAL_INSTALLED_VERSION_CONTRADICTION'],
    localIdentityConflict: conflict,
  };
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

  const chain = chainCandidate({ files, fileUpdates, mine, localName, installationFile, profile, meta });
  if (chain.candidate) {
    const target = chain.candidate;
    const conflict = localTargetVersionConflict(meta, mine, target);
    if (conflict) return withRuntimeEvidence(localConflictDecision({ conflict, target, mo2, sourceEvidence: ['NEXUS_EXACT_UPDATE_CHAIN'] }), chain.runtimeEvidence);
    if (ignoredTarget(meta, target)) {
      return withRuntimeEvidence({
        status: 'SKIP_IGNORED_UPDATE',
        reason: 'MO2_IGNORED_VERSION_MATCHES_TARGET',
        updateNeeded: false,
        priority: 0,
        mo2,
        target: compactFile(target),
        evidence: ['NEXUS_EXACT_UPDATE_CHAIN', 'MO2_IGNORED_VERSION'],
      }, chain.runtimeEvidence);
    }
    return withRuntimeEvidence({
      status: 'UPDATE_CONFIRMED',
      reason: 'NEXUS_EXACT_UPDATE_CHAIN',
      updateNeeded: true,
      priority: mo2.signal ? 100 : 92,
      mo2,
      target: compactFile(target),
      evidence: ['NEXUS_EXACT_UPDATE_CHAIN', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
      chainDepth: Math.max(0, ...chain.successors.map(x => Number(x.depth || 0))),
    }, chain.runtimeEvidence);
  }

  if (chain.compatRejects && chain.compatRejects.length) {
    return withRuntimeEvidence({
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: chain.compatRejects[0].reason,
      updateNeeded: false,
      priority: 85,
      mo2,
      target: null,
      evidence: ['NEXUS_EXACT_UPDATE_CHAIN', 'RUNTIME_COMPAT_GATE'],
      compatRejects: chain.compatRejects,
    }, chain.runtimeEvidence);
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

  const fallback = fallbackNewerCandidate({ files, mine, localName, installationFile, profile, meta });
  if (fallback.candidate) {
    const target = fallback.candidate;
    const conflict = localTargetVersionConflict(meta, mine, target);
    if (conflict) return withRuntimeEvidence(localConflictDecision({ conflict, target, mo2, sourceEvidence: ['NEWER_COMPATIBLE_FILE_UPLOAD'] }), fallback.runtimeEvidence);
    if (ignoredTarget(meta, target)) {
      return withRuntimeEvidence({
        status: 'SKIP_IGNORED_UPDATE',
        reason: 'MO2_IGNORED_VERSION_MATCHES_TARGET',
        updateNeeded: false,
        priority: 0,
        mo2,
        target: compactFile(target),
        evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', 'MO2_IGNORED_VERSION'],
      }, fallback.runtimeEvidence);
    }

    const comparable = validVersion(target.version) && validVersion(mine.version);
    const versionCmp = comparable ? compareVersions(target.version, mine.version) : null;
    if (versionCmp === null || versionCmp <= 0) {
      const reason = versionCmp === 0
        ? 'SAME_VERSION_NEWER_FILE_REPLACEMENT'
        : (versionCmp !== null ? 'NONMONOTONIC_VERSION_NEWER_FILE' : 'UNRELIABLE_VERSION_NEWER_FILE');
      return withRuntimeEvidence({
        status: 'HOLD_UPDATE_ELIGIBILITY',
        reason,
        updateNeeded: false,
        priority: mo2.signal ? 80 : 55,
        mo2,
        target: compactFile(target),
        evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', 'VERSION_METADATA_NOT_AUTHORITATIVE', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
        margin: fallback.margin,
      }, fallback.runtimeEvidence);
    }

    // Numeric-core equality ("2.2light" vs "2.2.0.0", "v1.9.1-SE" vs
    // "1.9.1.0-AE"): the version strings may compare as "newer" only because
    // of suffix parsing; the actual release number did not move. Replacement,
    // not an update -> HOLD.
    {
      const coreT = versionCore(target.version);
      const coreM = versionCore(mine.version);
      if (coreT && coreM && compareNumericVersions(coreT, coreM) === 0) {
        return withRuntimeEvidence({
          status: 'HOLD_UPDATE_ELIGIBILITY',
          reason: 'SAME_VERSION_NEWER_FILE_REPLACEMENT',
          updateNeeded: false,
          priority: mo2.signal ? 80 : 55,
          mo2,
          target: compactFile(target),
          evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', 'VERSION_CORE_UNCHANGED', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
          margin: fallback.margin,
        }, fallback.runtimeEvidence);
      }
    }

    // Weak evidence is deliberately NOT auto-approved. "A newer file was
    // uploaded on this page" cannot tell an upgrade from a sibling artefact:
    // modId 98945 proposed "… - Helmets" 3.0.5 as the update of an installed
    // "… - Guards" 2.4.1, and there is no Guards file at 3.0.5 at all (ISS-001).
    // Two name-based discriminators were tried and both wrongly HOLDed dozens of
    // legitimate updates (68 and 99 items), because local folder names are
    // Chinese-decorated and authors rename files between versions. So the whole
    // class is deferred to a human instead of guessed at. The proposed target is
    // still attached so Review Center can show exactly what would be fetched;
    // only the exact Nexus chain (NEXUS_EXACT_UPDATE_CHAIN) auto-downloads.
    return withRuntimeEvidence({
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: 'WEAK_UPDATE_EVIDENCE_DEFERRED',
      updateNeeded: false,
      priority: mo2.signal ? 80 : 45,
      mo2,
      target: compactFile(target),
      evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', 'WEAK_EVIDENCE_DEFERRED', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
      margin: fallback.margin,
    }, fallback.runtimeEvidence);
  }

  if (fallback.ambiguous) {
    return withRuntimeEvidence({
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: 'MULTIPLE_NEWER_COMPATIBLE_FILES',
      updateNeeded: false,
      priority: mo2.signal ? 78 : 50,
      mo2,
      target: null,
      evidence: ['NEWER_FILE_UPLOADS_AMBIGUOUS', ...(mo2.signal ? ['MO2_UPDATE_SIGNAL'] : [])],
      candidates: fallback.ranked.map(x => compactFile(x.file)),
    }, fallback.runtimeEvidence);
  }

  if (fallback.compatRejects && fallback.compatRejects.length) {
    return withRuntimeEvidence({
      status: 'HOLD_UPDATE_ELIGIBILITY',
      reason: fallback.compatRejects[0].reason,
      updateNeeded: false,
      priority: mo2.signal ? 85 : 55,
      mo2,
      target: null,
      evidence: ['NEWER_COMPATIBLE_FILE_UPLOAD', 'RUNTIME_COMPAT_GATE'],
      compatRejects: fallback.compatRejects,
    }, fallback.runtimeEvidence);
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
  RUNTIME_EVIDENCE_STATUSES,
  validVersion,
  normalizeArchiveIdentity,
  installationFileMatchesTarget,
  mo2UpdateSignal,
  normalizeUpdateEdge,
  updateChainSuccessors,
  localTargetVersionConflict,
  readableDescText,
  statedRequirements,
  candidateRuntimeEvidence,
  candidateCompatRejects,
  candidateCompatGate,
  runtimeEvidenceNote,
  assessUpdateEligibility,
  eligibilityCounts,
};
