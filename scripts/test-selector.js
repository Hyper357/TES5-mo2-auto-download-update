#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  categoryRole,
  groupLatestAuxFiles,
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

console.log('selector tests: OK');
