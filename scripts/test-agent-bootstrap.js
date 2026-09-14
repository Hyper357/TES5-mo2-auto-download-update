'use strict';

const assert = require('assert');
const { porcelainIsClean } = require('./agent-bootstrap');

assert.strictEqual(porcelainIsClean(''), true);
assert.strictEqual(porcelainIsClean('   \n'), true);
assert.strictEqual(porcelainIsClean(' M README.md'), false);
assert.strictEqual(porcelainIsClean('?? local.txt\n'), false);

console.log('agent bootstrap tests: OK');
