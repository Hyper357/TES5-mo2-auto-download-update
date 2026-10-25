#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  categoryRole,
  groupLatestAuxFiles,
  hardVariantConflicts,
  selectUpdateTarget,
} = require('./lib/file-selector');

function f(file_id, name, version, category_id = 1, uploaded_time = '2026-01-01T00:00:00Z', category_name = '') {
  return { file_id, name, file_name: `${name}.7z`, version, category_id, category_name, uploaded_time };
}

(function selectsSameProductLineNotNewestWrongVariant() {
  const mine = f(100, 'Engine Widget AE', '1.0.0', 1, '2026-01-01T00:00:00Z', 'MAIN FILES');
  const good = f(200, 'Engine Widget AE', '1.1.0', 1, '2026-02-01T00:00:00Z', 'MAIN FILES');
  const wrongVr = f(999, 'Engine Widget VR', '9.0.0', 1, '2026-09-01T00:00:00Z', 'MAIN FILES');
  const patch = f(1000, 'Engine Widget compatibility patch', '10.0.0', 3, '2026-09-02T00:00:00Z', 'OPTIONAL FILES');

  const res = selectUpdateTarget({
    files: [mine, wrongVr, patch, good],
    mine,
    localName: 'Engine Widget AE',
    installationFile: 'Engine Widget AE.7z',
    profile: { platform: 'AE', bodyType: '3BA', textureTier: '2K' },
  });

  assert.strictEqual(res.decision, 'DOWNLOAD');
  assert.strictEqual(String(res.target.file_id), '200');
  assert.strictEqual(res.confidence, 'high');
})();

(function rejectsTextureVariantDrift() {
  const mine = f(10, 'Mountain Textures 2K', '1.0', 1, '2026-01-01T00:00:00Z', 'MAIN FILES');
  const good = f(11, 'Mountain Textures 2K', '1.1', 1, '2026-02-01T00:00:00Z', 'MAIN FILES');
  const wrong = f(12, 'Mountain Textures 8K', '2.0', 1, '2026-03-01T00:00:00Z', 'MAIN FILES');
  const res = selectUpdateTarget({
    files: [mine, wrong, good], mine,
    localName: 'Mountain Textures 2K',
    profile: { platform: 'AE', textureTier: '2K' },
  });
  assert.strictEqual(String(res.target.file_id), '11');
})();

(function sameVersionReplacementNeedsReview() {
  const mine = f(20, 'UI Core AE', '2.0', 1, '2026-01-01T00:00:00Z', 'MAIN FILES');
  const replacement = f(21, 'UI Core AE', '2.0', 1, '2026-02-01T00:00:00Z', 'MAIN FILES');
  const res = selectUpdateTarget({ files: [mine, replacement], mine, localName: 'UI Core AE', profile: { platform: 'AE' } });
  assert.strictEqual(res.decision, 'HOLD_SAME_VERSION_REPLACEMENT');
})();

(function keepsMultiplePatchFamilies() {
  const files = [
    f(301, 'JK Skyrim Patch', '1.0', 3, '2026-01-01T00:00:00Z', 'OPTIONAL FILES'),
    f(302, 'JK Skyrim Patch v1.1', '1.1', 3, '2026-02-01T00:00:00Z', 'OPTIONAL FILES'),
    f(401, 'USSEP Patch', '1.0', 3, '2026-02-02T00:00:00Z', 'OPTIONAL FILES'),
    f(501, 'Chinese Translation', '1.1', 3, '2026-02-03T00:00:00Z', 'OPTIONAL FILES'),
  ];
  const grouped = groupLatestAuxFiles(files);
  assert.strictEqual(grouped.length, 3);
  assert.ok(grouped.some(x => String(x.file_id) === '302'));
  assert.ok(grouped.some(x => String(x.file_id) === '401'));
  assert.ok(grouped.some(x => categoryRole(x) === 'TRANSLATION'));
})();

// Regression, ISS-002 (modId 128582): "NG" is the community label for the
// 1.6+/AE build, not a third runtime branch. The installed file and its Nexus
// chain replacement are both NG, so the profile gate must not answer
// `profile-runtime:AE!=NG` and reject a real update.
(function ngIsTheAeBranchNotANewRuntime() {
  const conflicts = hardVariantConflicts(
    'Unequip Quiver NG',
    'Unequip Quiver NG 1.3.1',
    { platform: 'AE', bodyType: 'UNKNOWN', textureTier: 'UNKNOWN' },
  );
  assert.deepStrictEqual(conflicts, [], 'NG must not conflict with an AE profile');
})();

(function selectsNgUpdateOfAnInstalledNgMod() {
  const mine = f(797013, 'Unequip Quiver NG', '1.3.0', 1, '2026-08-29T14:04:03Z', 'MAIN FILES');
  const target = f(814615, 'Unequip Quiver NG', '1.3.1', 1, '2026-10-04T17:27:17Z', 'MAIN FILES');
  const res = selectUpdateTarget({
    files: [mine, target],
    mine,
    localName: '取消装备箭袋 — Unequip Quiver NG — 【系统·装备】【技术·SKSE】',
    installationFile: 'Unequip Quiver NG 128582 1.3.0 2026-08-29T14-04Z UK35XnhA5.zip',
    profile: { platform: 'AE', bodyType: '3BA', textureTier: '2K' },
  });
  assert.strictEqual(res.decision, 'DOWNLOAD');
  assert.strictEqual(String(res.target.file_id), '814615');
})();

// Regression, ISS-003 (modIds 150727 / 142566 / 173074): when the installed
// file itself declares its game edition, that branch is what the user runs.
// The profile must not hard-reject the same branch as `profile-runtime:AE!=SE`.
(function installedEditionBranchOutranksTheProfile() {
  const conflicts = hardVariantConflicts(
    'Glorious Doors of Skyrim (GDOS) SE',
    'Glorious Doors of Skyrim (GDOS) SE PBR 4.0',
    { platform: 'AE', bodyType: '3BA', textureTier: '2K' },
  );
  assert.deepStrictEqual(conflicts, [], 'installed SE branch must not be rejected by an AE profile');
})();

(function profileRuntimeStillGuardsAnUnknownInstalledBranch() {
  const conflicts = hardVariantConflicts('Mystery Widget', 'Mystery Widget VR 2.0', { platform: 'AE' });
  assert.ok(
    conflicts.some(x => /profile-runtime/.test(x)),
    'when the installed file states no branch the profile must still guard',
  );
})();

(function selectsSeBranchUpdateForAnInstalledSeMod() {
  const mine = f(756444, 'Glorious Doors of Skyrim (GDOS) SE', '3.5.1', 1, '2026-06-01T00:00:00Z', 'MAIN FILES');
  const target = f(824267, 'Glorious Doors of Skyrim (GDOS) SE PBR', '4.0', 1, '2026-10-24T00:00:00Z', 'MAIN FILES');
  const res = selectUpdateTarget({
    files: [mine, target],
    mine,
    localName: '天际之门 — Glorious Doors of Skyrim (GDOS) SE PBR',
    installationFile: 'Glorious Doors of Skyrim (GDOS) SE PBR 150727 3.5.1 2026-06-01T00:00Z achSzYJfW.rar',
    profile: { platform: 'AE', bodyType: '3BA', textureTier: '2K' },
  });
  assert.strictEqual(res.decision, 'DOWNLOAD');
  assert.strictEqual(String(res.target.file_id), '824267');
})();

console.log('selector tests: OK');
