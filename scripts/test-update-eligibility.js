'use strict';

const assert = require('assert');
const {
  mo2UpdateSignal,
  updateChainSuccessors,
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

// MO2 yellow-arrow-equivalent metadata signal.
{
  const s = mo2UpdateSignal({ version: '1.0', newestVersion: '1.1', ignoredVersion: '', nexusFileStatus: 1 });
  assert.strictEqual(s.signal, true);
  assert.strictEqual(s.reason, 'NEWEST_VERSION_GREATER');
}

// Ignore Update suppresses that exact MO2 newestVersion.
{
  const s = mo2UpdateSignal({ version: '1.0', newestVersion: '1.1', ignoredVersion: '1.1', nexusFileStatus: 1 });
  assert.strictEqual(s.signal, false);
  assert.strictEqual(s.ignored, true);
}

// Update-chain traversal follows exact old_file_id -> new_file_id rather than trusting page version strings.
{
  const edges = updateChainSuccessors('10', [
    { old_file_id: 10, new_file_id: 11 },
    { old_file_id: 11, new_file_id: 12 },
  ]);
  assert.deepStrictEqual(edges.map(x => x.newFileId), ['11', '12']);
}

// Strongest case: exact Nexus update chain confirms a real update even when version strings are unchanged.
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
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  assert.strictEqual(x.reason, 'NEXUS_EXACT_UPDATE_CHAIN');
  assert.strictEqual(x.target.fileId, '11');
}

// Critical false-positive case: MO2 metadata says a newer version exists, but exact Files API has no newer compatible file.
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

// MO2 can also miss an update. A genuinely later compatible upload still surfaces.
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

// A same-version later upload without an exact update-chain is real change evidence, but not safe enough to auto-update.
{
  const mine = f(40, 'Replacement Main', '1.0', '2026-01-01T00:00:00Z');
  const next = f(41, 'Replacement Main', '1.0', '2026-04-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '1.0', newestVersion: '1.0', nexusFileStatus: 1 },
    localName: 'Replacement Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'SAME_VERSION_NEWER_FILE_REPLACEMENT');
}

// Bad Nexus update chains must not override a hard body/runtime conflict.
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

// Respect MO2 Ignore Update for the ignored target version.
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

// If a genuinely later version appears after the ignored version, surface it again.
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
