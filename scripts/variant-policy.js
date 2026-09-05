#!/usr/bin/env node
'use strict';

const path = require('path');
const { defaultPolicyFile, loadVariantPolicies, getVariantPolicy, forgetVariantPolicy } = require('./lib/variant-policy');

const rootDir = path.resolve(__dirname, '..');
const file = defaultPolicyFile(rootDir);
const cmd = process.argv[2] || 'list';
const modId = process.argv[3] || '';

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (cmd === 'list' || cmd === 'status') {
  const doc = loadVariantPolicies(file);
  out({ file, count: Object.keys(doc.policies || {}).length, updatedAt: doc.updatedAt, policies: doc.policies });
} else if (cmd === 'show') {
  if (!modId) throw new Error('用法: node scripts/variant-policy.js show <modId>');
  out({ file, modId: String(modId), policy: getVariantPolicy(loadVariantPolicies(file), modId) });
} else if (cmd === 'forget') {
  if (!modId) throw new Error('用法: node scripts/variant-policy.js forget <modId>');
  out({ file, modId: String(modId), ...forgetVariantPolicy(file, modId) });
} else {
  throw new Error(`unknown variant-policy command: ${cmd}`);
}
