'use strict';

const assert = require('assert');
const { porcelainIsClean, trackedIsClean, untrackedPaths } = require('./agent-bootstrap');

assert.strictEqual(porcelainIsClean(''), true);
assert.strictEqual(porcelainIsClean('   \n'), true);
assert.strictEqual(porcelainIsClean(' M README.md'), false);
assert.strictEqual(porcelainIsClean('?? local.txt\n'), false);

// Untracked files alone must not block the documented startup command.
assert.strictEqual(trackedIsClean(''), true);
assert.strictEqual(trackedIsClean('   \n'), true);
assert.strictEqual(trackedIsClean('?? HANDOFF-20260929.md\n'), true);
assert.strictEqual(trackedIsClean('?? a.txt\n?? b.txt\n'), true);
// Any tracked modification still blocks.
assert.strictEqual(trackedIsClean(' M scripts/agent-bootstrap.js'), false);
assert.strictEqual(trackedIsClean('M  staged.txt'), false);
assert.strictEqual(trackedIsClean('A  added.txt'), false);
assert.strictEqual(trackedIsClean(' D removed.js'), false);
assert.strictEqual(trackedIsClean('?? local.txt\n M README.md'), false);

assert.deepStrictEqual(untrackedPaths('?? HANDOFF-20260929.md\n'), ['HANDOFF-20260929.md']);
assert.deepStrictEqual(untrackedPaths('?? a.txt\n?? "spaced dir/x.txt"\n'), ['a.txt', '"spaced dir/x.txt"']);
assert.deepStrictEqual(untrackedPaths(' M README.md\n'), []);
assert.deepStrictEqual(untrackedPaths(''), []);

console.log('agent bootstrap tests: OK');
