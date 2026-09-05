'use strict';

const assert = require('assert');
const { parseRegistryText, findRules, isFresh } = require('./lib/aux-registry');

const today = new Date().toISOString().slice(0, 10);
const text = [
  '# v2',
  `123\t456\t2.0\tPATCH\tNONE\t\t\t\t\t${today}\tFiles checked\tno patch`,
  `123\t456\t2.0\tTRANSLATION\tREQUIRED\t999\t1001\t2.0\tChinese\t${today}\tTranslations page\tmatched`,
].join('\n');

const rules = parseRegistryText(text);
assert.strictEqual(rules.length, 2);
assert.strictEqual(rules[0].schema, 2);
assert.strictEqual(rules[0].mainFileId, '456');
assert.ok(isFresh(rules[0], 14).fresh);

const exact = findRules(rules, { mainModId: '123', mainFileId: '456', mainVersion: '2.0' });
assert.strictEqual(exact.length, 2);

const wrongFile = findRules(rules, { mainModId: '123', mainFileId: '457', mainVersion: '2.0' });
assert.strictEqual(wrongFile.length, 0, 'registry conclusion must be bound to exact mainFileId');

const legacy = parseRegistryText('123\t2.0\tPATCH\tNONE\t\t\t\t\tlegacy');
assert.strictEqual(legacy[0].schema, 1);
assert.strictEqual(legacy[0].mainFileId, '*');
assert.strictEqual(isFresh(legacy[0], 14).fresh, false);

console.log('registry tests: OK');
