'use strict';

const assert = require('assert');
const {
  mo2UpdateSignal,
  updateChainSuccessors,
  localTargetVersionConflict,
  assessUpdateEligibility,
} = require('./lib/update-eligibility');

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

// MO2 can miss a real update.
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
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.reason, 'NEWER_COMPATIBLE_FILE_UPLOAD');
  assert.strictEqual(x.mo2.signal, false);
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

console.log('update eligibility tests: OK');
