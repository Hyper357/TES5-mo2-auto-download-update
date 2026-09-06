#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { groupDownloadRows, chooseTransactions } = require('./batch-update');

function writeMeta(dir, folder, { modId, version, fileId }) {
  const modDir = path.join(dir, folder);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'meta.ini'), [
    '[General]',
    `modid=${modId}`,
    `version=${version}`,
    `installationFile=old-${fileId}.7z`,
    '[installedFiles]',
    `0\\fileid=${fileId}`,
    '',
  ].join('\r\n'), 'utf8');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-batch-test-'));
const mods = path.join(root, 'mods');
const downloads = path.join(root, 'downloads');
fs.mkdirSync(mods, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });

try {
  writeMeta(mods, 'Mod A', { modId: 1, version: '1.0', fileId: 10 });
  writeMeta(mods, 'Mod B', { modId: 2, version: '2.0', fileId: 20 });

  const rows = [
    { modId: '1', fileId: '11', ver: '1.1', name: 'Mod A', note: '', action: 'DOWNLOAD' },
    { modId: '101', fileId: '111', ver: '1.0', name: 'Required Patch A', note: 'tx=1:11; closure:PATCH', action: 'DOWNLOAD' },
    { modId: '2', fileId: '21', ver: '2.0', name: 'Mod B', note: '', action: 'DOWNLOAD' },
  ];
  const groups = groupDownloadRows(rows);
  assert.strictEqual(groups.size, 2);
  assert.strictEqual(groups.get('1:11').length, 2);

  const first = chooseTransactions({ groups, count: 20, modsDir: mods, downloadsDir: downloads });
  assert.strictEqual(first.selected.length, 1);
  assert.strictEqual(first.selected[0].tx, '1:11');
  assert.ok(first.excluded.some(x => x.tx === '2:21' && x.reason === 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT'));

  // If the exact target archive is already in Downloads, batch acceptance must choose another target rather than redownload it.
  const archive = path.join(downloads, 'ModA-11.7z');
  fs.writeFileSync(archive, Buffer.from('x'));
  fs.writeFileSync(`${archive}.meta`, '[General]\r\nmodID=1\r\nfileID=11\r\nname=Mod A\r\nversion=1.1\r\n', 'utf8');
  const second = chooseTransactions({ groups, count: 20, modsDir: mods, downloadsDir: downloads });
  assert.strictEqual(second.selected.length, 0);
  assert.ok(second.excluded.some(x => x.tx === '1:11' && x.reason === 'TARGET_ARCHIVE_ALREADY_IN_DOWNLOADS'));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('batch update tests: OK');
