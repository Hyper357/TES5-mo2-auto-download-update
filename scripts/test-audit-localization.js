#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { productKeys, bumpClass, bestTranslationMatch } = require('./audit-localization');

// Product tokens: short/generic words are ignored, so matching stays meaningful.
assert.deepStrictEqual(productKeys('Simple Follower Framework'), ['simple', 'follower', 'framework']);
assert.ok(!productKeys('The Mod SE').includes('the'));
assert.ok(!productKeys('The Mod SE').includes('se'));

// Version bump classes.
assert.strictEqual(bumpClass('1.0.17', '2.0.1'), 'MAJOR');
assert.strictEqual(bumpClass('4.3.2', '5.0.6'), 'MAJOR');
assert.strictEqual(bumpClass('1.7.3', '1.7.5'), 'PATCH');
assert.strictEqual(bumpClass('2.2.0', '2.3.0'), 'MINOR');
assert.strictEqual(bumpClass('', '1.0'), 'UNKNOWN');

// Translation matching: needs >=50% of the product tokens in the folder name.
const translations = [
  { folder: 'BUVARP SE RE - Chronicles of the College-CHS', version: '1.3.7', modId: '111', keys: productKeys('BUVARP SE RE - Chronicles of the College') },
  { folder: 'Unrelated Chinese Patch', version: '1.0', modId: '222', keys: productKeys('Unrelated Chinese Patch') },
];
const hit = bestTranslationMatch({ name: 'BUVARP SE RE' }, translations);
assert.ok(hit, 'expected the BUVARP translation folder to match');
assert.strictEqual(hit.modId, '111');

const miss = bestTranslationMatch({ name: 'Natural Waterfalls' }, translations);
assert.strictEqual(miss, null, 'unrelated folders must not match');

console.log('audit localization tests: OK');
