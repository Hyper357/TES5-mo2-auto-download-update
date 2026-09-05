'use strict';

const assert = require('assert');
const { detectVariantReview, branchKey } = require('./lib/variant-review');

// Regression fixture derived from the Sassy Salt and Wind layout: Vanilla, KS Full and KS HDT are separate MAIN branches.
const files = [
  { file_id: 100, category_id: 1, category_name: 'MAIN', name: 'Sassy SnW Hair Retexture - Vanilla 2k-1k', version: '1.0', description: 'ONLY works for hairs that use Vanilla textures.' },
  { file_id: 200, category_id: 1, category_name: 'MAIN', name: 'Sassy SnW Retexture - KS Hairdos Full', version: '1.02', description: 'Texture replacer. For use with KS Hairdos.' },
  { file_id: 300, category_id: 1, category_name: 'MAIN', name: 'Sassy SnW Retexture - KS Hairdos HDT', version: '1.02.1', description: 'Texture replacer. For use with KS Hairdos HDT-SMP.' },
  { file_id: 301, category_id: 2, category_name: 'UPDATE', name: 'HOTFIX 1.02.1 - KS Hairdos HDT Missing Textures', version: '1.02.1' },
];
const mine = files[0];
const review = detectVariantReview({ files, mine, localNames: ['KS Hairdos HDT-SMP', 'Faster HDT-SMP', 'RaceMenu'] });
assert.strictEqual(review.required, true);
assert.ok(review.options.some(x => x.fileId === '300' && /KS_HAIRDOS/.test(x.branchKey) && /HDT_SMP/.test(x.branchKey)));
assert.strictEqual(review.recommendedFileId, '300', 'installed KS Hairdos HDT context should recommend HDT branch for human review');
assert.strictEqual(review.recommendedDifferentFromCurrent, true);
assert.match(branchKey(files[0]), /VANILLA/);

// Multiple historical releases of one generic branch should not become an automatic multi-variant review.
const ordinary = detectVariantReview({
  files: [
    { file_id: 1, category_id: 1, category_name: 'MAIN', name: 'Example Mod 1.0', version: '1.0' },
    { file_id: 2, category_id: 1, category_name: 'MAIN', name: 'Example Mod 1.1', version: '1.1' },
  ],
  mine: { file_id: 1, category_id: 1, category_name: 'MAIN', name: 'Example Mod 1.0', version: '1.0' },
  localNames: [],
});
assert.strictEqual(ordinary.required, false);

console.log('variant review tests: OK');
