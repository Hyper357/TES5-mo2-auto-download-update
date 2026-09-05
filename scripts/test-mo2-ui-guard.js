#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  nameMatch,
  classifyDialogText,
  classifyQueueText,
  evaluateSnapshot,
  buttonRegexForRole,
} = require('./lib/mo2-ui-guard');

assert.strictEqual(classifyDialogText('此文件已在下载队列中 模组 173086 文件 799456'), 'DUPLICATE_QUEUE_INFO');
assert.strictEqual(classifyDialogText('重新下载？ 已存在同名的下载文件：ShowRaceMenu NG - Latest Version'), 'REDOWNLOAD_PROMPT');
assert.strictEqual(classifyQueueText('ShowRaceMenu NG 下载中 2.4 MB/s 38%'), 'DOWNLOADING');
assert.strictEqual(classifyQueueText('ShowRaceMenu NG 已下载'), 'COMPLETE');

const match = nameMatch('ShowRaceMenu NG - Latest Version', 'ShowRaceMenu NG - Latest Version 173086 1.0.5 2026-09-02T22-13Z.zip');
assert(match.score >= 0.9, `expected strong name match, got ${match.score}`);

const duplicateSnapshot = {
  ok: true,
  process: { pid: 100, name: 'ModOrganizer' },
  windows: [{
    handle: 11,
    title: '已经启动',
    texts: ['此文件已在下载队列中', '模组 173086', '文件 799456', 'ShowRaceMenu NG - Latest Version 173086 1.0.5'],
    buttons: ['确定'],
  }],
  queueItems: [],
};
const dup = evaluateSnapshot(duplicateSnapshot, {
  modId: '173086', fileId: '799456', name: 'ShowRaceMenu NG - Latest Version',
});
assert.strictEqual(dup.safeActions.length, 1);
assert.strictEqual(dup.safeActions[0].buttonRole, 'OK');
assert.strictEqual(dup.dialogs[0].exactIds, true);

const nameOnlyDuplicate = evaluateSnapshot({
  ok: true,
  windows: [{
    handle: 12,
    title: '已经启动',
    texts: ['此文件已在下载队列中', 'ShowRaceMenu NG - Latest Version 173086 1.0.5'],
    buttons: ['确定'],
  }],
  queueItems: [],
}, { name: 'ShowRaceMenu NG - Latest Version' });
assert.strictEqual(nameOnlyDuplicate.safeActions.length, 1);
assert.strictEqual(nameOnlyDuplicate.safeActions[0].buttonRole, 'OK');

const redownloadSnapshot = {
  ok: true,
  windows: [{
    handle: 21,
    title: '重新下载?',
    texts: ['已有同名的下载文件：ShowRaceMenu NG - Latest Version 173086 1.0.5 2026-09-02T22-13Z.zip。您想要重新下载？'],
    buttons: ['是(Y)', '否(N)'],
  }],
  queueItems: [],
};
const redl = evaluateSnapshot(redownloadSnapshot, { name: 'ShowRaceMenu NG - Latest Version' });
assert.strictEqual(redl.safeActions.length, 1);
assert.strictEqual(redl.safeActions[0].buttonRole, 'NO');
assert(!redl.safeActions.some(a => /YES|Y|是/i.test(a.buttonRole)), 'must never emit affirmative re-download action');

const unrelated = evaluateSnapshot(redownloadSnapshot, { name: 'Precision - Accurate Melee Collisions' });
assert.strictEqual(unrelated.safeActions.length, 0);
assert.strictEqual(unrelated.ambiguousDialogs.length, 1);

const queue = evaluateSnapshot({
  ok: true,
  windows: [],
  queueItems: [
    { name: 'ShowRaceMenu NG - Latest Version', texts: ['ShowRaceMenu NG - Latest Version', '正在下载', '42%', '1.7 MB/s'] },
    { name: 'Precision', texts: ['Precision', '已下载'] },
  ],
}, { name: 'ShowRaceMenu NG - Latest Version' });
assert.strictEqual(queue.queue.state, 'DOWNLOADING');
assert.strictEqual(queue.queue.inflight, true);

assert(/确定/.test(buttonRegexForRole('OK')));
assert(/否/.test(buttonRegexForRole('NO')));
assert.throws(() => buttonRegexForRole('YES'));

console.log('mo2 ui guard tests: OK');
