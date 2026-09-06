#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseSignedNxm,
  sanitizeArchiveName,
  choosePublishPath,
  buildMo2Meta,
  publishToMo2Downloads,
} = require('./lib/direct-nexus-download');
const { scanExactDownload } = require('./lib/download-guard');

const nxm = 'nxm://skyrimspecialedition/mods/16495/files/800245?key=SECRET&expires=1999999999&user_id=1';
const parsed = parseSignedNxm(nxm, { expectedGame: 'skyrimspecialedition', expectedModId: '16495', expectedFileId: '800245' });
assert.strictEqual(parsed.game, 'skyrimspecialedition');
assert.strictEqual(parsed.modId, '16495');
assert.strictEqual(parsed.fileId, '800245');
assert.strictEqual(parsed.key, 'SECRET');
assert.strictEqual(parsed.expires, '1999999999');
assert.throws(() => parseSignedNxm(nxm, { expectedFileId: '800246' }), /NXM_IDENTITY_MISMATCH/);
assert.throws(() => parseSignedNxm('https://example.com'), /NXM_INVALID/);

assert.strictEqual(sanitizeArchiveName('bad<name>:file?.7z'), 'bad_name__file_.7z');

const meta = buildMo2Meta({
  gameName: 'SkyrimSE', modId: '16495', fileId: '800245', name: 'JContainers SE', modName: 'JContainers SE', version: '4.3.2', fileCategory: 1,
});
assert.ok(meta.startsWith('[General]\r\n'));
assert.ok(meta.includes('gameName=SkyrimSE'));
assert.ok(meta.includes('modID=16495'));
assert.ok(meta.includes('fileID=800245'));
assert.ok(meta.includes('version=4.3.2'));
assert.ok(!meta.includes('SECRET'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-nexus-test-'));
try {
  const downloads = path.join(tmp, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const source = path.join(tmp, 'source.7z');
  fs.writeFileSync(source, Buffer.from('not-a-real-archive-but-publish-test'));

  const first = choosePublishPath(downloads, 'JContainers-16495-4-3-2.7z', '800245');
  assert.strictEqual(path.basename(first), 'JContainers-16495-4-3-2.7z');

  const published = publishToMo2Downloads({
    sourcePath: source,
    downloadsDir: downloads,
    archiveName: 'JContainers-16495-4-3-2.7z',
    fileId: '800245',
    metaText: meta,
  });
  assert.ok(fs.existsSync(published.finalPath));
  assert.ok(fs.existsSync(published.metaPath));
  const state = scanExactDownload(downloads, '16495', '800245');
  assert.strictEqual(state.status, 'COMPLETE');

  const second = choosePublishPath(downloads, 'JContainers-16495-4-3-2.7z', '800245');
  assert.notStrictEqual(second, published.finalPath, 'collision must not overwrite existing archive');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('direct nexus download tests: OK');
