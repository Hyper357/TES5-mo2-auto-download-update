#!/usr/bin/env node
'use strict';

// ISS-011 regression: a 403 "Mod not available" is permanent, not throttling.
// It must (a) be classified separately from 429/HTTP errors, (b) be remembered
// so ~700 hidden mods are not requeried every run, and (c) never be counted as
// an apiFail that marks the whole audit untrustworthy.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyApiError, createFilesClient } = require('./lib/nexus-api');

assert.strictEqual(classifyApiError(403, '{"code":403,"message":"Mod not available: 19"}'), 'API_MOD_UNAVAILABLE');
assert.strictEqual(classifyApiError(403, 'Forbidden'), 'API_FORBIDDEN');
assert.strictEqual(classifyApiError(429, 'error code: 1015'), 'API_RATE_LIMITED');
assert.strictEqual(classifyApiError(404, 'nope'), 'API_NOT_FOUND');
assert.strictEqual(classifyApiError(500, 'boom'), 'API_HTTP_500');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-api-'));
  try {
    // A cached "unavailable" marker must short-circuit without any network call.
    fs.writeFileSync(path.join(dir, '19.unavailable.json'), JSON.stringify({
      code: 'API_MOD_UNAVAILABLE', statusCode: 403, message: 'Mod not available: 19', at: new Date().toISOString(),
    }), 'utf8');
    const client = createFilesClient({ cacheDir: dir });
    await assert.rejects(client.getFiles('19', 'fake-key'), (err) => {
      assert.strictEqual(err.code, 'API_MOD_UNAVAILABLE');
      assert.strictEqual(err.statusCode, 403);
      return true;
    });

    // An expired marker must not block a fresh attempt (no network here, so the
    // request fails with a network error -- which is not the unavailable code).
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    const marker = path.join(dir, '19.unavailable.json');
    fs.writeFileSync(marker, fs.readFileSync(marker, 'utf8'), 'utf8');
    fs.utimesSync(marker, old, old);
    await assert.rejects(client.getFiles('19', ''), (err) => {
      assert.notStrictEqual(err.code, 'API_MOD_UNAVAILABLE');
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('nexus api tests: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
