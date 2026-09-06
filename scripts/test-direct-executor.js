#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { buildDirectDownloadArgs, txOf, priority } = require('./execute-plan');

const args = buildDirectDownloadArgs({
  directScript: path.join('scripts', 'direct-download-one.js'),
  manifest: 'one.tsv',
  downloads: 'E:\\SkyrimAE\\mo2\\downloads',
  apiKeyFile: 'E:\\SkyrimAE\\tools\\.nexus_api_key',
  sevenzip: 'C:\\Program Files\\7-Zip\\7z.exe',
  timeoutSec: 600,
});
assert.ok(args[0].endsWith(path.join('scripts', 'direct-download-one.js')));
assert.ok(args.includes('--downloads'));
assert.ok(args.includes('--api-key-file'));
assert.ok(args.includes('--sevenzip'));
assert.ok(!args.includes('dl'));
assert.ok(!args.includes('--go'));
assert.strictEqual(txOf({ modId: '1', fileId: '2', note: '' }), '1:2');
assert.strictEqual(priority({ modId: '1', fileId: '2', note: '' }, '1:2'), 0);
assert.strictEqual(priority({ modId: '3', fileId: '4', note: 'closure:PATCH' }, '1:2'), 1);
assert.strictEqual(priority({ modId: '5', fileId: '6', note: 'closure:TRANSLATION' }, '1:2'), 2);
console.log('direct executor tests: OK');
