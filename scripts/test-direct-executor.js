#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildDirectDownloadArgs,
  fastVerifyPublished,
  localExecutionGuard,
  clampConcurrency,
  isTransactionMain,
  txOf,
  priority,
} = require('./execute-plan');

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
assert.strictEqual(isTransactionMain({ modId: '1', fileId: '2' }, '1:2'), true);
assert.strictEqual(priority({ modId: '1', fileId: '2', note: '' }, '1:2'), 0);
assert.strictEqual(priority({ modId: '3', fileId: '4', note: 'closure:PATCH' }, '1:2'), 1);
assert.strictEqual(priority({ modId: '5', fileId: '6', note: 'closure:TRANSLATION' }, '1:2'), 2);
assert.strictEqual(clampConcurrency(0), 1);
assert.strictEqual(clampConcurrency(2), 2);
assert.strictEqual(clampConcurrency(99), 3);

// Executor defense-in-depth: exact target already installed => never download again.
{
  const idx = new Map([['16495', [{ version: '4.3.2', installedFiles: [800245] }]]]);
  const d = localExecutionGuard({ modId: '16495', fileId: '800245', ver: '4.3.2' }, idx);
  assert.strictEqual(d.decision, 'SKIP');
  assert.strictEqual(d.reason, 'EXACT_TARGET_ALREADY_INSTALLED');
}

// JContainers-shaped stale file identity: local version already equals target but fileId differs => HOLD.
{
  const idx = new Map([['16495', [{ version: '4.3.2', installedFiles: [700000] }]]]);
  const d = localExecutionGuard({ modId: '16495', fileId: '800245', ver: '4.3.2' }, idx);
  assert.strictEqual(d.decision, 'HOLD');
  assert.strictEqual(d.reason, 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT');
}

// Main row disappearing between scan and execution is unsafe and must HOLD.
{
  const d = localExecutionGuard(
    { modId: '999', fileId: '1000', ver: '2.0' },
    new Map(),
    { requireExistingLocal: true }
  );
  assert.strictEqual(d.decision, 'HOLD');
  assert.strictEqual(d.reason, 'LOCAL_MOD_NOT_FOUND_AT_EXECUTION');
}

// A newly-required auxiliary component may legitimately be absent locally; Closure owns that decision.
{
  const d = localExecutionGuard(
    { modId: '999', fileId: '1000', ver: '2.0' },
    new Map(),
    { requireExistingLocal: false }
  );
  assert.strictEqual(d.decision, 'ALLOW');
  assert.strictEqual(d.reason, 'AUX_NOT_INSTALLED_REQUIRED_BY_CLOSURE');
}

// Real newer target remains allowed.
{
  const idx = new Map([['16495', [{ version: '4.3.2', installedFiles: [700000] }]]]);
  const d = localExecutionGuard({ modId: '16495', fileId: '900000', ver: '4.4.0' }, idx);
  assert.strictEqual(d.decision, 'ALLOW');
}

// Unreliable target version is not safe for automatic replacement of an installed main.
{
  const idx = new Map([['1', [{ version: '1.0', installedFiles: [10] }]]]);
  const d = localExecutionGuard({ modId: '1', fileId: '11', ver: '' }, idx);
  assert.strictEqual(d.decision, 'HOLD');
  assert.strictEqual(d.reason, 'TARGET_VERSION_UNRELIABLE_AT_EXECUTION');
}

// Fast final verification trusts the already completed pre-publish 7-Zip test only when
// exact modId:fileId is visible in Downloads.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-fast-verify-'));
  try {
    const archive = path.join(dir, 'Example.7z');
    fs.writeFileSync(archive, Buffer.from('not-used-by-fast-verify'));
    fs.writeFileSync(`${archive}.meta`, '[General]\r\nmodID=1\r\nfileID=2\r\nname=Example\r\nversion=1.1\r\n');
    const v = fastVerifyPublished(
      { modId: '1', fileId: '2', ver: '1.1' },
      dir,
      { archiveValidated: true, archive: 'Example.7z' }
    );
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.result.status, 'VERIFIED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('direct executor tests: OK');
