#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizePageCount, withTargetLock, isNavigationError } = require('./lib/direct-session');

assert.strictEqual(normalizePageCount(0), 1);
assert.strictEqual(normalizePageCount(2), 2);
assert.strictEqual(normalizePageCount(99), 3);

// ISS-008: a client-side re-render of the Nexus mod page destroys the JS
// execution context. That is an expected mid-poll event and must be classified
// as retryable, not surfaced as a hard download failure.
{
  assert.strictEqual(
    isNavigationError(new Error('Execution context was destroyed, most likely because of a navigation.')),
    true,
  );
  assert.strictEqual(isNavigationError(new Error('Cannot find context with specified id')), true);
  assert.strictEqual(isNavigationError(new Error('Target closed')), true);
  assert.strictEqual(isNavigationError(new Error('NXM_DOWNLOAD_CONTROL_MISSING: no Slow download')), false);
  assert.strictEqual(isNavigationError(new Error('DIRECT_TARGET_ARCHIVED: 1:2')), false);
  assert.strictEqual(isNavigationError(null), false);
}

(async () => {
  const events = [];
  const first = withTargetLock('downloads|1:2', async () => {
    events.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 40));
    events.push('first-end');
    return 1;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = withTargetLock('downloads|1:2', async () => {
    events.push('second-start');
    events.push('second-end');
    return 2;
  });
  const independent = withTargetLock('downloads|9:9', async () => {
    events.push('independent');
    return 3;
  });
  const values = await Promise.all([first, second, independent]);
  assert.deepStrictEqual(values, [1, 2, 3]);
  assert.ok(events.indexOf('second-start') > events.indexOf('first-end'));
  assert.ok(events.includes('independent'));
  console.log('direct session pool tests: OK');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
