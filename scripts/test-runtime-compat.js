'use strict';

const assert = require('assert');
const {
  parseRequiredRuntimes,
  runtimeCompatRejects,
  editionTags,
  branchCompatRejects,
  versionCore,
  compareNumericVersions,
  defaultLocalRuntime,
} = require('./lib/runtime-compat');
const { assessUpdateEligibility } = require('./lib/update-eligibility');

function f(id, name, version, uploaded, categoryId = 1) {
  return {
    file_id: id,
    name,
    file_name: `${name}-${id}.7z`,
    version,
    uploaded_time: uploaded,
    category_id: categoryId,
    category_name: categoryId === 1 ? 'MAIN' : 'UPDATE',
  };
}

// Parsing.
{
  const r = parseRequiredRuntimes('SKSE 2.3.1 / SSE (SAE) 1.7.104');
  assert.deepStrictEqual(r.skseVersions, ['2.3.1']);
  assert.deepStrictEqual(r.runtimeVersions, ['1.7.104']);
}

// JContainers 4.3.2-shaped description must be rejected on a 2.2.6 / 1.6.1170 box.
{
  const rejects = runtimeCompatRejects('SKSE 2.3.1 / SSE (SAE) 1.7.104');
  assert.ok(rejects.some(x => x.reason === 'TARGET_REQUIRES_NEWER_SKSE'));
  assert.ok(rejects.some(x => x.reason === 'TARGET_REQUIRES_NEWER_RUNTIME'));
}

// Files that explicitly support the local runtime pass.
{
  const rejects = runtimeCompatRejects('Built for Skyrim 1.6.1170 and 1.7.104, SKSE 2.2.6 or 2.3.1');
  assert.deepStrictEqual(rejects, []);
}

// No evidence -> no reject.
{
// Chinese description stating the target runtime ("适配SE1.7") must reject
// on 1.6.1170; older targets ("适配SE1.5.97") and dual targets must not.
{
  const rejects = runtimeCompatRejects('Chinese Translation For USSEP 4.3.9a 适配SE1.7');
  assert.ok(rejects.some(x => x.reason === 'TARGET_REQUIRES_NEWER_RUNTIME' && x.required === '1.7'));
  assert.deepStrictEqual(runtimeCompatRejects('基于1.6.1170的最后一个非官方补丁4.3.8a'), []);
  assert.deepStrictEqual(runtimeCompatRejects('适配SE1.5.97'), []);
  assert.deepStrictEqual(runtimeCompatRejects('适配1.6.1170、1.7 双版本'), []);
}

// Edition-tagged digits ("SE1.7.104") are runtime mentions even without a
// space; a mod version like "v1.9.1-SE" must NOT read as a runtime.
{
  const rejects = runtimeCompatRejects('This build is for SE1.7.104 only');
  assert.ok(rejects.some(x => x.reason === 'TARGET_REQUIRES_NEWER_RUNTIME' && x.required === '1.7.104'));
  assert.deepStrictEqual(runtimeCompatRejects('Enhanced Combat AI v1.9.1-SE'), []);
}

  assert.deepStrictEqual(runtimeCompatRejects(''), []);
  assert.deepStrictEqual(runtimeCompatRejects('Fix a bug in the quest stage.'), []);
}

// skse2.3.1 inside a version string (sztkUtil style) is detected.
{
  const rejects = runtimeCompatRejects('sztkUtilAE 57863 20220312-skse2.3.1');
  assert.ok(rejects.some(x => x.reason === 'TARGET_REQUIRES_NEWER_SKSE'));
}

// "Updated for compatibility with Skyrim v1.7.104 ... Last Compatible 1.6
// version: 2.0" (LeveledList Crash Fix 2.0.1): the hard-requirement phrase
// wins even though 1.5.97 is mentioned as a port suggestion.
{
  const desc = 'Download and install with your mod manager. Updated for compatibility with Skyrim v1.7.104. No new features added. Last Compatible 1.6 version: 2.0.';
  const rejects = runtimeCompatRejects(desc);
  assert.ok(rejects.some(x => x.reason === 'TARGET_REQUIRES_NEWER_RUNTIME' && x.required === '1.7.104'));
}
// A build updated FOR 1.6.1170 itself is fine.
{
  assert.deepStrictEqual(runtimeCompatRejects('Updated for compatibility with Skyrim v1.6.1170.'), []);
}

// Edition tags.
{
  assert.deepStrictEqual(editionTags('Enhanced Combat AI SE'), ['SE']);
  assert.deepStrictEqual(editionTags('JContainers AE'), ['AE']);
  assert.deepStrictEqual(editionTags('PapyrusUtil AE SE').sort(), ['AE', 'SE']);
  assert.deepStrictEqual(editionTags('Plain Name'), []);
}

{
  const r = branchCompatRejects('My Mod 1.0.0-AE', 'My Mod SE 1.1');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].reason, 'TARGET_EDITION_MISMATCH');
}
{
  // Both-listed local ("AE SE") vs SE candidate: not a mismatch.
  assert.deepStrictEqual(branchCompatRejects('PapyrusUtil AE SE', 'PapyrusUtil SE 4.8'), []);
}
{
  assert.deepStrictEqual(branchCompatRejects('Some Mod', 'Some Mod SE 2.0'), []);
}

// Version cores.
{
  assert.strictEqual(versionCore('2.2light'), '2.2');
  assert.strictEqual(versionCore('1.9.1.0-AE'), '1.9.1.0');
  assert.strictEqual(versionCore('v1.9.1-SE'), '1.9.1');
  assert.strictEqual(compareNumericVersions('2.2', '2.2.0.0'), 0);
}

// End to end: fallback candidate compiled for a newer runtime is HOLD, not CONFIRMED.
{
  const mine = f(30, 'Simple Framework', '4.6', '2026-01-01T00:00:00Z');
  const next = f(31, 'Simple Framework', '4.8', '2026-04-01T00:00:00Z');
  next.description = 'Version 4.8 for SKSE 2.3.1, Skyrim 1.7.104';
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '4.6.0.0', newestVersion: '4.6.0.0', nexusFileStatus: 1 },
    localName: 'Simple Framework',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'TARGET_REQUIRES_NEWER_SKSE');
  assert.strictEqual(x.updateNeeded, false);
  assert.ok(x.compatRejects.some(r => r.reason === 'TARGET_REQUIRES_NEWER_RUNTIME'));
}

// End to end: exact-chain candidate for a newer runtime is HOLD too.
{
  const mine = f(80, 'JContainers SE', '4.3.0', '2026-01-01T00:00:00Z');
  const next = f(81, 'JContainers SE', '4.3.2', '2026-09-04T00:00:00Z');
  next.description = 'SKSE 2.3.1 / SSE (SAE) 1.7.104';
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [{ old_file_id: 80, new_file_id: 81 }],
    mine,
    meta: { version: '4.3.0.0', newestVersion: '4.3.2', nexusFileStatus: 1 },
    localName: 'JContainers SE',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'TARGET_REQUIRES_NEWER_SKSE');
}

// End to end: "2.2light" against installed 2.2.0.0 is a same-core replacement -> HOLD.
{
  const mine = f(40, 'Stealth Detection Fixes', '2.2.0.0', '2026-01-01T00:00:00Z');
  const next = f(41, 'Stealth Detection Fixes', '2.2light', '2026-04-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '2.2.0.0', newestVersion: '2.2.0.0', nexusFileStatus: 1 },
    localName: 'Stealth Detection Fixes',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'SAME_VERSION_NEWER_FILE_REPLACEMENT');
}

// End to end: AE installed, SE-only newer upload -> HOLD, never CONFIRMED.
{
  const mine = f(90, 'Enhanced Combat AI', '1.9.1.0-AE', '2026-01-01T00:00:00Z');
  const next = f(91, 'Enhanced Combat AI', 'v1.9.1-SE', '2026-08-18T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '1.9.1.0-AE', newestVersion: '1.9.1.0', nexusFileStatus: 1 },
    localName: 'Enhanced Combat AI',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.ok(['SAME_VERSION_NEWER_FILE_REPLACEMENT', 'TARGET_EDITION_MISMATCH'].includes(x.reason));
}

// A genuinely newer, runtime-compatible candidate still confirms.
{
  const mine = f(95, 'Simple Main', '1.0', '2026-01-01T00:00:00Z');
  const next = f(96, 'Simple Main', '1.1', '2026-04-01T00:00:00Z');
  const x = assessUpdateEligibility({
    files: [mine, next],
    fileUpdates: [],
    mine,
    meta: { version: '1.0', newestVersion: '1.0', nexusFileStatus: 1 },
    localName: 'Simple Main',
    installationFile: mine.file_name,
  });
  assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
}

// Env override: pretend we are on the new runtime, the same candidate confirms.
{
  process.env.LOCAL_SKSE_VERSION = '2.3.1';
  process.env.LOCAL_RUNTIME_VERSION = '1.7.104';
  try {
    const mine = f(97, 'Simple Framework', '4.6', '2026-01-01T00:00:00Z');
    const next = f(98, 'Simple Framework', '4.8', '2026-04-01T00:00:00Z');
    next.description = 'Version 4.8 for SKSE 2.3.1, Skyrim 1.7.104';
    const x = assessUpdateEligibility({
      files: [mine, next],
      fileUpdates: [],
      mine,
      meta: { version: '4.6.0.0', newestVersion: '4.6.0.0', nexusFileStatus: 1 },
      localName: 'Simple Framework',
      installationFile: mine.file_name,
    });
    assert.strictEqual(x.status, 'UPDATE_CONFIRMED');
  } finally {
    delete process.env.LOCAL_SKSE_VERSION;
    delete process.env.LOCAL_RUNTIME_VERSION;
  }
}

// Bare "For vX" statements (the Instantly Skip incident): "For v1.7.104" must
// reject on 1.6.1170; backwards-compat mentions of OLDER runtimes must pass;
// mod versions with a short build tail ("for v1.9.1 of the framework") must
// stay unrecognized.
{
  const r = runtimeCompatRejects('For v1.7.104');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].reason, 'TARGET_REQUIRES_NEWER_RUNTIME');
  assert.strictEqual(r[0].evidence, 'FOR_VERSION_PHRASE');
  assert.strictEqual(r[0].required, '1.7.104');
  assert.ok(r[0].quote.includes('For v1.7.104'));

  assert.strictEqual(runtimeCompatRejects('Requires 1.7.104').length, 1);
  assert.deepStrictEqual(runtimeCompatRejects('Backwards compatible (CommonlibNG) for 1.6.1130'), []);
  assert.deepStrictEqual(runtimeCompatRejects('for 1.6.353'), []);
  assert.deepStrictEqual(runtimeCompatRejects('for 1.6.1170 and 1.7.104'), []);
  // "v1.9.1" has a 1-digit build tail -> not runtime-shaped -> the bare-for
  // pattern must not fire on it.
  assert.deepStrictEqual(runtimeCompatRejects('Compatible with v1.9.1 of the framework'), []);
  // Additive phrasing with the exemption sentence must still pass.
  assert.deepStrictEqual(
    runtimeCompatRejects('Added support for 1.7.104, previous versions are still compatible'),
    []
  );
}

console.log('runtime compat tests: OK');
