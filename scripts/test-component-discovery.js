'use strict';

const assert = require('assert');
const {
  classifyComponent,
  componentFamily,
  mergeComponentCandidates,
  candidateRuleMatches,
  assessComponentDiscovery,
  countsByKind,
} = require('./lib/component-discovery');

assert.strictEqual(classifyComponent('Required Resources - install this framework first', { source: 'DESCRIPTION_TEXT' }), 'RESOURCE');
assert.strictEqual(classifyComponent('KS Hairdos HDT-SMP Physics Files'), 'PHYSICS');
assert.strictEqual(classifyComponent('CBBE 3BA BodySlide files'), 'BODYSLIDE');
assert.strictEqual(classifyComponent('HOTFIX - missing textures'), 'HOTFIX');
assert.strictEqual(classifyComponent('Optional 2K texture pack'), 'TEXTURE');
assert.strictEqual(classifyComponent('Chinese Translation'), 'TRANSLATION');
assert.strictEqual(classifyComponent('Plain unrelated sentence'), '');
assert.strictEqual(classifyComponent('Some Framework', { source: 'REQUIREMENTS_FORWARD' }), 'RESOURCE');

const optional = mergeComponentCandidates([
  { source: 'SAME_PAGE_FILE', fileId: '40', name: 'Optional 2K texture pack', mainName: 'Example Main' },
]);
assert.strictEqual(optional[0].kind, 'TEXTURE');
assert.strictEqual(optional[0].optionalHint, true, 'explicit Optional wording should be visible as a hint but not auto-resolved');

// Same Nexus page is not enough when both sides have exact file IDs.
assert.strictEqual(candidateRuleMatches(
  { kind:'PHYSICS', auxModId:'123', fileId:'200', family:'CUSTOM:HDT' },
  { kind:'PHYSICS', auxModId:'123', auxFileId:'201', family:'CUSTOM:HDT', status:'REQUIRED' },
), false);
assert.strictEqual(candidateRuleMatches(
  { kind:'PHYSICS', auxModId:'123', fileId:'200', family:'CUSTOM:HDT' },
  { kind:'PHYSICS', auxModId:'123', auxFileId:'200', family:'CUSTOM:OTHER', status:'REQUIRED' },
), true);

const raw = [
  { source: 'REQUIREMENTS_FORWARD', kind: 'RESOURCE', auxModId: '10', name: 'Required Framework', evidence: 'Nexus requirements', mainName: 'Example Main', requiredHint: true },
  { source: 'SAME_PAGE_FILE', fileId: '20', version: '1.0', name: 'HDT-SMP Physics Files', mainName: 'Example Main' },
  { source: 'SAME_PAGE_FILE', fileId: '30', version: '1.0', name: 'HOTFIX - missing textures', mainName: 'Example Main' },
];
const merged = mergeComponentCandidates(raw);
assert.strictEqual(merged.length, 3);
const counts = countsByKind(merged);
assert.strictEqual(counts.RESOURCE, 1);
assert.strictEqual(counts.PHYSICS, 1);
assert.strictEqual(counts.HOTFIX, 1);
assert.ok(merged.find(x => x.kind === 'RESOURCE').requiredHint);
assert.match(componentFamily('PHYSICS', 'HDT-SMP Physics Files', 'Example Main'), /CUSTOM|GENERAL/);

const resource = merged.find(x => x.kind === 'RESOURCE');
const physics = merged.find(x => x.kind === 'PHYSICS');
const hotfix = merged.find(x => x.kind === 'HOTFIX');
const rules = [
  { kind: 'RESOURCE', family: resource.family, status: 'REQUIRED', auxModId: '10', auxFileId: '101' },
  { kind: 'PHYSICS', family: physics.family, status: 'NOT_APPLICABLE' },
  { kind: 'HOTFIX', family: hotfix.family, status: 'OBSOLETE' },
];
const assessed = assessComponentDiscovery({
  candidates: merged,
  rules,
  coverage: {
    samePageComponents: { required: true, complete: true },
    requirementsForward: { required: true, complete: true },
    requirementsReverse: { required: true, complete: true },
    description: { required: true, complete: true },
  },
});
assert.strictEqual(assessed.complete, true);
assert.strictEqual(assessed.unresolved.length, 0);

const held = assessComponentDiscovery({
  candidates: merged,
  rules: rules.filter(x => x.kind !== 'PHYSICS'),
  coverage: { requirementsForward: { required: true, complete: false, status: 'SECTION_NOT_PROVEN' } },
});
assert.strictEqual(held.complete, false);
assert.ok(held.unresolved.some(x => x.kind === 'PHYSICS'));
assert.ok(held.coverageProblems.some(x => x.source === 'requirementsForward'));

console.log('component discovery tests: OK');
