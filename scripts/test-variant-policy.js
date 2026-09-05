'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { branchKey, detectVariantReview } = require('./lib/variant-review');
const {
  loadVariantPolicies,
  getVariantPolicy,
  resolveVariantPolicy,
  rememberVariantPolicy,
  forgetVariantPolicy,
} = require('./lib/variant-policy');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-variant-policy-'));
const file = path.join(dir, 'variant-policies.json');

try {
  assert.strictEqual(branchKey({ name: 'KS Hairdos HDT-SMP' }), 'HDT_SMP+KS_HAIRDOS');

  const files = [
    { file_id: 100, category_id: 1, category_name: 'MAIN', name: 'Vanilla 2K', version: '1.0', uploaded_time: '2026-01-01' },
    { file_id: 200, category_id: 1, category_name: 'MAIN', name: 'KS Hairdos Full', version: '1.0', uploaded_time: '2026-01-01' },
    { file_id: 300, category_id: 1, category_name: 'MAIN', name: 'KS Hairdos HDT-SMP', version: '1.0', uploaded_time: '2026-01-01' },
  ];
  const review = detectVariantReview({ files, mine: files[0], localNames: ['KS Hairdos HDT-SMP'] });
  assert.strictEqual(review.required, true);
  assert.ok(review.options.some(x => x.branchKey === 'HDT_SMP+KS_HAIRDOS'));

  const saved = rememberVariantPolicy(file, {
    modId: '160675', fileId: '300', name: 'KS Hairdos HDT-SMP', version: '1.0',
    branchKey: 'HDT_SMP+KS_HAIRDOS', tags: ['HDT_SMP', 'KS_HAIRDOS'],
  });
  assert.strictEqual(saved.saved, true);

  const doc = loadVariantPolicies(file);
  const policy = getVariantPolicy(doc, '160675');
  assert.strictEqual(policy.branchKey, 'HDT_SMP+KS_HAIRDOS');
  assert.strictEqual(resolveVariantPolicy(review, policy).status, 'MATCHED');

  const changedReview = detectVariantReview({ files: [files[0], files[1]], mine: files[0], localNames: [] });
  assert.strictEqual(resolveVariantPolicy(changedReview, policy).status, 'CHANGED');

  const generic = rememberVariantPolicy(file, { modId: '9', fileId: '9', branchKey: 'GENERIC' });
  assert.strictEqual(generic.saved, false);
  assert.strictEqual(getVariantPolicy(loadVariantPolicies(file), '9'), null);

  const removed = forgetVariantPolicy(file, '160675');
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(getVariantPolicy(loadVariantPolicies(file), '160675'), null);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('variant policy tests: OK');
