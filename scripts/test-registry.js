'use strict';

const assert = require('assert');
const { parseRegistryText, findRules, isFresh } = require('./lib/aux-registry');
const today = new Date().toISOString().slice(0, 10);

const v2 = [
  '# v2',
  `123\t456\t2.0\tPATCH\tNONE\t\t\t\t\t${today}\tFiles checked\tno patch`,
  `123\t456\t2.0\tTRANSLATION\tREQUIRED\t999\t1001\t2.0\tChinese\t${today}\tTranslations page\tmatched`,
].join('\n');
const rules = parseRegistryText(v2);
assert.strictEqual(rules.length, 2);
assert.strictEqual(rules[0].schema, 2);
assert.strictEqual(rules[0].family, '');
assert.ok(isFresh(rules[0], 14).fresh);
assert.strictEqual(findRules(rules,{mainModId:'123',mainFileId:'456',mainVersion:'2.0'}).length,2);
assert.strictEqual(findRules(rules,{mainModId:'123',mainFileId:'457',mainVersion:'2.0'}).length,0);

const v3 = parseRegistryText([
  `123\t456\t2.0\tPATCH\tUSSEP\tREQUIRED\t777\t888\t1.1\tUSSEP Patch\t${today}\tRequirements reverse\trequired`,
  `123\t456\t2.0\tPATCH\tLUX\tNOT_APPLICABLE\t\t\t\t\t${today}\tLux absent locally\tnot needed`,
].join('\n'));
assert.strictEqual(v3.length,2);
assert.strictEqual(v3[0].schema,3);
assert.strictEqual(v3[0].family,'USSEP');
assert.strictEqual(v3[1].status,'NOT_APPLICABLE');
assert.match(v3[0].id,/PATCH:USSEP:REQUIRED/);

const legacy=parseRegistryText('123\t2.0\tPATCH\tNONE\t\t\t\t\tlegacy');
assert.strictEqual(legacy[0].schema,1);
assert.strictEqual(legacy[0].mainFileId,'*');
assert.strictEqual(isFresh(legacy[0],14).fresh,false);
console.log('registry tests: OK');
