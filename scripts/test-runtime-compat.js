'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseRequiredRuntimes,
  runtimeCompatRejects,
  editionTags,
  branchCompatRejects,
  versionCore,
  compareNumericVersions,
  defaultLocalRuntime,
  detectLocalSkse,
  detectLocalRuntime,
  resetRuntimeCache,
  FALLBACK_SKSE_VERSION,
  FALLBACK_RUNTIME_VERSION,
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

// A genuinely newer, runtime-compatible candidate is no longer auto-approved:
// with no exact Nexus chain it is weak evidence and is deferred to a human
// (docs/ISSUES.md ISS-001). What this case still proves is that the RUNTIME gate
// did not reject it.
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
  assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
  assert.strictEqual(x.reason, 'WEAK_UPDATE_EVIDENCE_DEFERRED');
  assert.ok(!/RUNTIME|SKSE|EDITION/.test(x.reason), 'runtime gate must not be the reason');
}

// Env override: with the newer baseline the runtime gate no longer rejects this
// candidate. It is still deferred (weak evidence, ISS-001), but the reason must
// NOT be a runtime one.
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
    assert.strictEqual(x.status, 'HOLD_UPDATE_ELIGIBILITY');
    assert.strictEqual(x.reason, 'WEAK_UPDATE_EVIDENCE_DEFERRED');
    assert.ok(!/RUNTIME|SKSE|EDITION/.test(x.reason), 'runtime gate must not be the reason');
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

// --- Local baseline detection ---------------------------------------------
//
// Every case below restores env + memo state, so the detection tests cannot
// leak into the assertions above or into other suites sharing this process.

const baselineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-runtime-detect-'));
try {
  // Env override beats whatever the machine detectors say.
  {
    process.env.LOCAL_SKSE_VERSION = '2.3.1';
    process.env.LOCAL_RUNTIME_VERSION = '1.7.104';
    resetRuntimeCache();
    try {
      const local = defaultLocalRuntime();
      assert.strictEqual(local.skse, '2.3.1');
      assert.strictEqual(local.runtime, '1.7.104');
      assert.strictEqual(local.sources.skse, 'ENV');
      assert.strictEqual(local.sources.runtime, 'ENV');
      // An env-sourced value is never an unverified assumption, so no
      // fallback warning may be raised for it.
      assert.deepStrictEqual(local.warnings, []);
      // Backward compatibility: old callers only ever read these two strings.
      assert.strictEqual(typeof local.skse, 'string');
      assert.strictEqual(typeof local.runtime, 'string');
    } finally {
      delete process.env.LOCAL_SKSE_VERSION;
      delete process.env.LOCAL_RUNTIME_VERSION;
      resetRuntimeCache();
    }
  }

  // A real skse64.log head is parsed; only the FIRST initialize line counts.
  {
    const log = path.join(baselineTmp, 'skse64.log');
    fs.writeFileSync(log, [
      'SKSE64 runtime: initialize (version = 2.3.5 01064920 01DD4FDD9DED6CC7, os = 6.2 (9200))',
      '[error] System.IO.FileNotFoundException: could not open data file',
      'SKSE64 runtime: initialize (version = 2.2.6 01064920 01DD4FDD9DED6CC7, os = 6.2 (9200))',
      'SKSE64 runtime: handoff address ...',
    ].join('\r\n'));
    process.env.LOCAL_SKSE_LOG_PATH = log;
    resetRuntimeCache();
    try {
      const det = detectLocalSkse();
      assert.strictEqual(det.version, '2.3.5');
      assert.strictEqual(det.path, log);
      assert.ok(det.source.startsWith('DETECTED'));
      // More than one initialize line -> the source must say which one won.
      assert.ok(det.source.includes('MULTIPLE'), `expected a multi-session note, got ${det.source}`);

      const local = defaultLocalRuntime();
      assert.strictEqual(local.skse, '2.3.5');
      assert.strictEqual(local.sources.skse, 'DETECTED');
      // Detection moved away from the hardcoded 2.2.6 -> must be flagged.
      assert.ok(local.warnings.some(w => w.includes('2.3.5') && w.includes('differs from the hardcoded default')));
      assert.ok(!local.warnings.some(w => w.includes('SKSE baseline 2.2.6 is an UNVERIFIED ASSUMPTION')));
    } finally {
      delete process.env.LOCAL_SKSE_LOG_PATH;
      resetRuntimeCache();
    }
  }

  // Detection returning nothing still yields a usable, labelled baseline.
  {
    // A declared list replaces the built-in locations, so these fixtures do not
    // depend on what happens to be installed on the machine running the test.
    process.env.LOCAL_SKSE_LOG_PATHS = 'C:\\tes5-nonexistent\\skse64.log';
    process.env.LOCAL_SKYRIM_EXE_PATHS = 'C:\\tes5-nonexistent\\Skyrim.exe';
    resetRuntimeCache();
    try {
      assert.strictEqual(detectLocalSkse().version, '');
      assert.strictEqual(detectLocalSkse().source, 'NOT_FOUND');
      assert.strictEqual(detectLocalRuntime().source, 'NOT_FOUND');

      const local = defaultLocalRuntime();
      assert.strictEqual(local.skse, FALLBACK_SKSE_VERSION);
      assert.strictEqual(local.runtime, FALLBACK_RUNTIME_VERSION);
      assert.strictEqual(local.sources.skse, 'FALLBACK');
      assert.strictEqual(local.sources.runtime, 'FALLBACK');
      // Never empty, whatever happened upstream: existing callers stay safe.
      assert.ok(local.skse.length > 0);
      assert.ok(local.runtime.length > 0);
      // Both fallbacks must be labelled as unverified and say how to fix it.
      const skseWarn = local.warnings.find(w => w.includes('SKSE baseline'));
      const runtimeWarn = local.warnings.find(w => w.includes('Skyrim runtime baseline'));
      assert.ok(skseWarn, 'expected a SKSE fallback warning');
      assert.ok(runtimeWarn, 'expected a runtime fallback warning');
      assert.ok(skseWarn.includes('UNVERIFIED ASSUMPTION'));
      assert.ok(skseWarn.includes('LOCAL_SKSE_VERSION') || skseWarn.includes('LOCAL_SKSE_LOG_PATH'));
      assert.ok(runtimeWarn.includes('UNVERIFIED ASSUMPTION'));
      assert.ok(runtimeWarn.includes('LOCAL_RUNTIME_VERSION'));
      assert.ok(runtimeWarn.includes('LOCAL_SKYRIM_EXE'));
      // The label travels with the value, not only with the warning list.
      assert.deepStrictEqual(local.detail.skse, { version: '', source: 'NOT_FOUND', path: '' });
      assert.deepStrictEqual(local.detail.runtime, { version: '', source: 'NOT_FOUND', path: '' });
    } finally {
      delete process.env.LOCAL_SKSE_LOG_PATHS;
      delete process.env.LOCAL_SKYRIM_EXE_PATHS;
      resetRuntimeCache();
    }
  }

  // A machine-declared path list is honoured (first existing candidate wins).
  {
    const log = path.join(baselineTmp, 'declared', 'skse64.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, 'SKSE64 runtime: initialize (version = 2.2.7 01064920 ABCDEF0123456789, os = 6.2 (9200))\r\n');
    process.env.LOCAL_SKSE_LOG_PATHS = [
      path.join(baselineTmp, 'declared', 'absent.log'),
      log,
    ].join(';');
    resetRuntimeCache();
    try {
      const det = detectLocalSkse();
      assert.strictEqual(det.version, '2.2.7');
      assert.strictEqual(det.path, log);
      assert.strictEqual(det.source, 'DETECTED');
      const local = defaultLocalRuntime();
      assert.strictEqual(local.skse, '2.2.7');
      assert.strictEqual(local.sources.skse, 'DETECTED');
    } finally {
      delete process.env.LOCAL_SKSE_LOG_PATHS;
      resetRuntimeCache();
    }
  }

  // An existing file that carries no PE version resource is NOT evidence.
  {
    const fakeExe = path.join(baselineTmp, 'Skyrim.exe');
    fs.writeFileSync(fakeExe, 'this is not a PE image');
    // A real PE with a version resource may well sit at a built-in location on
    // the machine running this test (a healthy SSE install has SkyrimSE.exe at
    // its root). The detector deliberately keeps searching past a file that
    // yields no version, so the search space must be pinned here or the
    // fallback candidate would be found and the case would not be testing what
    // it claims to test.
    process.env.LOCAL_SKYRIM_EXE = fakeExe;
    process.env.LOCAL_SKYRIM_EXE_PATHS = 'C:\\tes5-nonexistent\\SkyrimSE.exe';
    resetRuntimeCache();
    try {
      const det = detectLocalRuntime();
      assert.strictEqual(det.source, 'NOT_FOUND');
      assert.strictEqual(det.version, '');
    } finally {
      delete process.env.LOCAL_SKYRIM_EXE;
      delete process.env.LOCAL_SKYRIM_EXE_PATHS;
      resetRuntimeCache();
    }
  }

  // Memoized detection is stable and cheap enough for a per-candidate audit.
  {
    resetRuntimeCache();
    const a = detectLocalSkse();
    const b = detectLocalSkse();
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a, b, 'detector must hand out copies, not the memo itself');
    const first = defaultLocalRuntime();
    const second = defaultLocalRuntime();
    assert.strictEqual(first.skse, second.skse);
    assert.strictEqual(first.runtime, second.runtime);
    assert.deepStrictEqual(first.sources, second.sources);
  }

  // REGRESSION: the decision function is unchanged by the baseline rework.
  // An explicit local baseline pins the comparison away from this machine's
  // detection, so the pre-existing reject semantics are asserted verbatim.
  {
    const local = { skse: '2.2.6', runtime: '1.6.1170' };
    const newer = runtimeCompatRejects('SKSE 2.3.1 / SSE (SAE) 1.7.104', local);
    assert.ok(newer.some(x => x.reason === 'TARGET_REQUIRES_NEWER_SKSE' && x.local === '2.2.6'));
    assert.ok(newer.some(x => x.reason === 'TARGET_REQUIRES_NEWER_RUNTIME' && x.local === '1.6.1170'));
    assert.deepStrictEqual(runtimeCompatRejects('Built for Skyrim 1.6.1170 and 1.7.104, SKSE 2.2.6 or 2.3.1', local), []);
    // Empty text -> no reject (no evidence). Unchanged by design.
    assert.deepStrictEqual(runtimeCompatRejects('', local), []);
    assert.deepStrictEqual(runtimeCompatRejects('Fix a bug in the quest stage.', local), []);
  }
} finally {
  fs.rmSync(baselineTmp, { recursive: true, force: true });
  resetRuntimeCache();
}

console.log('runtime compat tests: OK');
