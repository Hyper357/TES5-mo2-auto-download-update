'use strict';

const assert = require('assert');
const {
  SENTINEL_PREFIX,
  sentinelUrl,
  targetHasSentinel,
  getCdpPort,
} = require('./lib/browser-session');
const { classifyFailure } = require('./lib/diagnostics');

{
  const token = '11111111-2222-3333-4444-555555555555';
  const url = sentinelUrl(token);
  assert.ok(url.startsWith('data:text/html'));
  assert.ok(url.includes(`${SENTINEL_PREFIX}${encodeURIComponent(token)}`));
  assert.strictEqual(targetHasSentinel([{ url }], token), true);
  assert.strictEqual(targetHasSentinel([{ url: 'https://github.com/' }], token), false);
  assert.strictEqual(targetHasSentinel([], token), false);
}

{
  const e = classifyFailure('BROWSER_PROFILE_MISMATCH: port 9222 is occupied by an unmanaged browser/profile');
  assert.strictEqual(e.code, 'BROWSER_PROFILE_MISMATCH');
  assert.strictEqual(e.retry, false);
  assert.strictEqual(e.layer, 'BROWSER');
}

{
  assert.ok(Number.isInteger(getCdpPort()));
  assert.ok(getCdpPort() > 0);
}

console.log('browser isolation tests: OK');
