#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizePageCount, withTargetLock } = require('./lib/direct-session');

assert.strictEqual(normalizePageCount(0), 1);
assert.strictEqual(normalizePageCount(2), 2);
assert.strictEqual(normalizePageCount(99), 3);

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
