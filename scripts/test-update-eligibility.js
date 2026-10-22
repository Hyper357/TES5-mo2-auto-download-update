'use strict';

const assert = require('assert');
const {
  mo2UpdateSignal,
  updateChainSuccessors,
  localTargetVersionConflict,
  assessUpdateEligibility,
  runtimeEvidenceNote,
} = require('./lib/update-eligibility');

// Pin the runtime baseline so the evidence cases below assert against a known
// comparison target instead of whatever this box happens to have installed.
process.env.LOCAL_SKSE_VERSION = '2.2.6';
process.env.LOCAL_RUNTIME_VERSION = '1.6.1170';

function f(id, name, version, uploaded, categoryId = 1) {
  return {
    file_id: id,
    name,
    file_name: `${name}-${id}.7z`,
    version,
    uploaded_time: uploaded,
    category_id: categoryId,
    category_name: categoryId === 1 ? 'MAIN' : (categoryId === 2 ? 'UPDATE' : 'OPTIONAL'),
  };
}

{
  const s = mo2UpdateSignal({ version: '1.0', newestVersion: '1.1', ignoredVersion: '', nexusFileStatus: 1 });
  assert.strictEqual(s.signal, true);
  assert.strictEqual(s.reason, 'NEWEST_VERSION_GREATER');
}

{
  const s = mo2UpdateSignal({ version: '1.0', newestVersion: '1.1', ignoredVersion: '1.1', nexusFileStatus: 1 });
  assert.strictEqual(s.signal, false);
  assert.strictEqual(s.ignored, true);
}

{
  const edges = updateChainSuccessors('10', [
    { old_file_id: 10, new_file_id: 11 },
    { old_file_id: 11, new_file_id: 12 },
  ]);
  assert.deepStrictEqual(edges.map(x => x.newFileId), ['11', '12']);
}

// Same-version exact replacements are no longer auto-downloaded when local installed
// version already equals the target but the resolved fileId is older/stale.
{
  const mine = f(10, 'Example Main', '1.0', '2026-01-01T00:00:00Z');
  const next = f(11, 'Example Main', '1.0', '2026-02-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 10, new_file_id: 11 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.0', nexusFileStatus: 1 },
    localName: 'Example Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT');
  assert.strictEqual(x.updateNeeded, false);
}

// JContainers-shaped regression: local meta already says target version, while stale
// file identity would otherwise traverse an exact chain and cause a false re-download.
{
  const mine = f(100, 'JContainers SE', '4.2.9', '2026-01-01T00:00:00Z');
  const next = f(101, 'JContainers SE', '4.3.2', '2026-09-04T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 100, new_file_id: 101 }],
    mine,
    meta: { version: '4.3.2', newestVersion: '4.3.2', nexusFileStatus: 1 },
    localName: 'JContainers SE',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT');
  assert.strictEqual(x.target.fileId, '101');
}

// A stale local fileId is not enough to block a clearly newer target: local 4.3.2 -> target 4.4.0.
{
  const mine = f(110, 'Framework', '4.2.9', '2026-01-01T00:00:00Z');
  const next = f(111, 'Framework', '4.4.0', '2026-09-05T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 110, new_file_id: 111 }],
    mine,
    meta: { version: '4.3.2', newestVersion: '4.4.0', nexusFileStatus: 1 },
    localName: 'Framework',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.target.fileId, '111');
}

{
  const conflict = localTargetVersionConflict(
    { version: '5.0' },
    f(120, 'Main', '4.0', '2026-01-01T00:00:00Z'),
    f(121, 'Main', '4.5', '2026-02-01T00:00:00Z')
  );
  assert.strictEqual(conflict.reason, 'LOCAL_VERSION_NEWER_THAN_TARGET');
}

// Metadata false positive remains suppressed.
{
  const mine = f(20, 'Already Current Main', '2.0', '2026-03-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine],
    fileUpdates: [],
    mine,
    meta: { version: '1.0', newestVersion: '9.9', nexusFileStatus: 1 },
    localName: 'Already Current Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'SKIP_METADATA_FALSE_POSITIVE');
  assert.strictEqual(x.updateNeeded, false);
  assert.strictEqual(x.mo2.signal, true);
}

// A newer upload with NO exact Nexus chain is weak evidence and is deferred to a
// human, not auto-downloaded. Rationale + measurements in docs/ISSUES.md ISS-001:
// "a newer file appeared on this page" cannot separate an upgrade from a sibling
// artefact, and every name-based discriminator tried wrongly HOLDed dozens of
// legitimate updates.
{
  const mine = f(30, 'Simple Main', '1.0', '2026-01-01T00:00:00Z');
  const next = f(31, 'Simple Main', '1.1', '2026-04-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '1.0', newestVersion: '1.0', nexusFileStatus: 1 },
    localName: 'Simple Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'WEAK_UPDATE_EVIDENCE_DEFERRED');
  assert.strictEqual(x.updateNeeded, false);
  assert.strictEqual(x.mo2.signal, false);
  // The proposed file stays attached so Review Center can offer it explicitly.
  assert.strictEqual(String(x.target.fileId), '31');
  assert.deepStrictEqual(x.evidence, ['NEWER_COMPATIBLE_FILE_UPLOAD', 'WEAK_EVIDENCE_DEFERRED']);
}

// Same-version later upload without exact chain remains HOLD.
{
  const mine = f(40, 'Replacement Main', '1.0', '2026-01-01T00:00:00Z');
  const next = f(41, 'Replacement Main', '1.0', '2026-04-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '', newestVersion: '', nexusFileStatus: 1 },
    localName: 'Replacement Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'SAME_VERSION_NEWER_FILE_REPLACEMENT');
}

// Hard variant conflicts remain HOLD.
{
  const mine = f(50, 'Armor CBBE 3BA', '1.0', '2026-01-01T00:00:00Z');
  const wrong = f(51, 'Armor BHUNP', '2.0', '2026-05-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, wrong],
    fileUpdates: [{ old_file_id: 50, new_file_id: 51 }],
    mine,
    meta: { version: '1.0', newestVersion: '2.0', nexusFileStatus: 1 },
    localName: 'Armor CBBE 3BA',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'NEXUS_UPDATE_CHAIN_VARIANT_CONFLICT');
}

// Ignored target whose raw version string only looks 'newer' due to a
// suffix ("2.2light" vs normalized "2.2.0.0light"): numeric-core equality
// must keep the IGNORE semantics instead of surfacing compat-gate noise.
{
  const mine = f(65, 'Suffix Ignored Main', '2.2', '2026-01-01T00:00:00Z');
  const next = f(66, 'Suffix Ignored Main', '2.2light', '2026-02-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 65, new_file_id: 66 }],
    mine,
    meta: { version: '2.2.0.0', newestVersion: '2.2.0.0light', ignoredVersion: '2.2.0.0light', nexusFileStatus: 1 },
    localName: 'Suffix Ignored Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'SKIP_IGNORED_UPDATE');
}

// Respect Ignore Update.
{
  const mine = f(60, 'Ignored Main', '1.0', '2026-01-01T00:00:00Z');
  const next = f(61, 'Ignored Main', '1.1', '2026-02-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 60, new_file_id: 61 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', ignoredVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Ignored Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'SKIP_IGNORED_UPDATE');
}

// A genuinely later target after the ignored version surfaces again.
{
  const mine = f(70, 'Ignored Then Updated', '1.0', '2026-01-01T00:00:00Z');
  const next = f(71, 'Ignored Then Updated', '1.2', '2026-03-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 70, new_file_id: 71 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', ignoredVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Ignored Then Updated',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
}

// --- Runtime evidence labelling -------------------------------------------------
// The gate is reject-only, so "no reject" used to conflate "verified
// compatible" with "the description said nothing at all". runtimeEvidence
// separates those. None of the cases below may move a decision.

// An empty description is NOT a reject: the decision is exactly what it was
// before the evidence label existed, and the label says zero evidence.
{
  const mine = f(200, 'Empty Desc Main', '1.0', '2026-01-01T00:00:00Z');
  const next = { ...f(201, 'Empty Desc Main', '1.1', '2026-02-01T00:00:00Z'), description: '' };
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 200, new_file_id: 201 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Empty Desc Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.reason, 'NEXUS_EXACT_UPDATE_CHAIN');
  assert.strictEqual(x.target.fileId, '201');
  assert.strictEqual(x.runtimeEvidence.status, 'EMPTY_DESCRIPTION');
  assert.strictEqual(x.runtimeEvidence.fileId, '201');
  assert.strictEqual(x.runtimeEvidence.descChars, 0);
  assert.deepStrictEqual(x.runtimeEvidence.required, []);
  assert.strictEqual(x.runtimeEvidence.local.skse, '2.2.6');
  assert.strictEqual(x.runtimeEvidence.local.runtime, '1.6.1170');
}

// Markup-only / whitespace-only descriptions carry no readable text either, so
// they are EMPTY_DESCRIPTION rather than "text that merely said no runtime".
{
  const mine = f(210, 'Markup Desc Main', '1.0', '2026-01-01T00:00:00Z');
  const next = { ...f(211, 'Markup Desc Main', '1.1', '2026-02-01T00:00:00Z'), description: '<p></p>  &nbsp; \n ' };
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 210, new_file_id: 211 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Markup Desc Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.runtimeEvidence.status, 'EMPTY_DESCRIPTION');
  assert.strictEqual(x.runtimeEvidence.descChars, 0);
}

// A stated requirement at or below the local baseline: the gate really checked
// something and let it through.
{
  const mine = f(220, 'Evidenced Main', '1.0', '2026-01-01T00:00:00Z');
  const next = {
    ...f(221, 'Evidenced Main', '1.1', '2026-02-01T00:00:00Z'),
    description: 'Supports SKSE 2.2.6 and Skyrim 1.5.97, 1.6.1170 and 1.7.104.',
  };
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 220, new_file_id: 221 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Evidenced Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.runtimeEvidence.status, 'EVIDENCED');
  assert.ok(x.runtimeEvidence.descChars > 0);
  assert.deepStrictEqual(x.runtimeEvidence.required, [
    { kind: 'SKSE', version: '2.2.6', via: 'SKSE_MENTION' },
    { kind: 'RUNTIME', version: '1.5.97', via: 'MENTION' },
    { kind: 'RUNTIME', version: '1.6.1170', via: 'MENTION' },
    { kind: 'RUNTIME', version: '1.7.104', via: 'MENTION' },
  ]);
  assert.strictEqual(x.compatRejects, undefined);
}

// A stated requirement newer than the local baseline: REJECTED, and the
// pre-existing HOLD is untouched.
{
  const mine = f(230, 'Rejected Desc Main', '1.0', '2026-01-01T00:00:00Z');
  const next = { ...f(231, 'Rejected Desc Main', '1.1', '2026-02-01T00:00:00Z'), description: 'For v1.7.104 only.' };
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 230, new_file_id: 231 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Rejected Desc Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'TARGET_REQUIRES_NEWER_RUNTIME');
  assert.ok(x.compatRejects.some(r => r.reason === 'TARGET_REQUIRES_NEWER_RUNTIME'));
  assert.strictEqual(x.runtimeEvidence.status, 'REJECTED');
  assert.deepStrictEqual(x.runtimeEvidence.required, [
    { kind: 'RUNTIME', version: '1.7.104', via: 'FOR_PHRASE' },
  ]);
}

// A changelog-only description states no runtime requirement at all: readable
// text, zero claim, still accepted exactly as before.
{
  const mine = f(240, 'Changelog Main', '1.0', '2026-01-01T00:00:00Z');
  const next = {
    ...f(241, 'Changelog Main', '1.1', '2026-02-01T00:00:00Z'),
    description: "Please endorse if you have enjoyed this mod. Fixed a crash in the inventory menu.",
  };
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 240, new_file_id: 241 }],
    mine,
    meta: { version: '1.0', newestVersion: '1.1', nexusFileStatus: 1 },
    localName: 'Changelog Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.runtimeEvidence.status, 'NO_RUNTIME_CLAIM');
  assert.ok(x.runtimeEvidence.descChars > 0);
  assert.deepStrictEqual(x.runtimeEvidence.required, []);
}

// The fallback (no exact chain) path carries the same label.
{
  const mine = f(250, 'Silent Fallback Main', '1.0', '2026-01-01T00:00:00Z');
  const next = { ...f(251, 'Silent Fallback Main', '1.1', '2026-02-01T00:00:00Z'), description: '   ' };
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '1.0', newestVersion: '1.0', nexusFileStatus: 1 },
    localName: 'Silent Fallback Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'WEAK_UPDATE_EVIDENCE_DEFERRED');
  assert.strictEqual(x.runtimeEvidence.status, 'EMPTY_DESCRIPTION');
  assert.strictEqual(x.runtimeEvidence.fileId, '251');
}

// The note token is additive; the existing note tokens stay byte-identical.
{
  assert.strictEqual(runtimeEvidenceNote({ runtimeEvidence: { status: 'EMPTY_DESCRIPTION' } }), 'runtimeEvidence=EMPTY_DESCRIPTION');
  assert.strictEqual(runtimeEvidenceNote({ runtimeEvidence: { status: 'NO_RUNTIME_CLAIM' } }), 'runtimeEvidence=NO_RUNTIME_CLAIM');
  assert.strictEqual(runtimeEvidenceNote({ runtimeEvidence: { status: 'EVIDENCED' } }), 'runtimeEvidence=EVIDENCED');
  assert.strictEqual(runtimeEvidenceNote({ runtimeEvidence: { status: 'REJECTED' } }), 'runtimeEvidence=REJECTED');
  assert.strictEqual(runtimeEvidenceNote({}), '');
  assert.strictEqual(runtimeEvidenceNote({ runtimeEvidence: {} }), '');
}

console.log('update eligibility tests: OK');
