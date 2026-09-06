'use strict';

const assert = require('assert');
const {
  classifyComponent,
  componentFamily,
  mergeComponentCandidates,
  candidateRuleMatches,
  candidateRelevance,
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
assert.strictEqual(optional[0].optionalHint, true);
assert.strictEqual(candidateRelevance(optional[0]).blocking, false, 'explicit optional/uninstalled file is evidence, not an automatic closure blocker');

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

// A reverse Nexus requirement is a downstream consumer, not automatically a Main companion.
const reverseOnly = assessComponentDiscovery({
  candidates: [{
    kind: 'PATCH', family: 'CUSTOM:SOME_DOWNSTREAM_MOD', source: 'REQUIREMENTS_REVERSE', key: 'PATCH:mod:900:',
    auxModId: '900', name: 'Some downstream compatibility mod', installedContextMatch: false,
  }],
  rules: [],
  coverage: {
    requirementsForward: { required: true, complete: true },
    requirementsReverse: { required: true, complete: false, status: 'SECTION_NOT_PROVEN' },
    description: { required: true, complete: true },
  },
});
assert.strictEqual(reverseOnly.complete, true, 'reverse-section coverage is advisory for Main closure');
assert.strictEqual(reverseOnly.unresolved.length, 0);
assert.strictEqual(reverseOnly.nonBlocking.length, 1);
assert.strictEqual(reverseOnly.nonBlocking[0].relevance.disposition, 'NON_BLOCKING_REVERSE_UNINSTALLED');

// If the same downstream/companion evidence matches active local context, it becomes blocking again.
const reverseInstalled = assessComponentDiscovery({
  candidates: [{
    kind: 'PATCH', family: 'CUSTOM:SOME_DOWNSTREAM_MOD', source: 'REQUIREMENTS_REVERSE', key: 'PATCH:mod:900:',
    auxModId: '900', name: 'Some downstream compatibility mod', installedContextMatch: true,
  }],
  rules: [],
  coverage: { requirementsForward: { required: true, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(reverseInstalled.complete, false);
assert.strictEqual(reverseInstalled.unresolved.length, 1);
assert.strictEqual(reverseInstalled.unresolved[0].relevance.disposition, 'BLOCKING_INSTALLED_CONTEXT');

// Explicit optional same-page evidence does not hold an otherwise clean Main.
const optionalAssessed = assessComponentDiscovery({
  candidates: optional,
  rules: [],
  coverage: { samePageComponents: { required: true, complete: true }, requirementsForward: { required: true, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(optionalAssessed.complete, true);
assert.strictEqual(optionalAssessed.unresolved.length, 0);
assert.strictEqual(optionalAssessed.nonBlocking.length, 1);

// A directly discovered translation remains blocking so localization is never silently forgotten.
const translationHeld = assessComponentDiscovery({
  candidates: [{ kind: 'TRANSLATION', family: 'ZH_CN', source: 'SAME_PAGE_FILE', fileId: '77', name: 'Chinese Translation', optionalHint: true }],
  rules: [],
  coverage: { samePageComponents: { required: true, complete: true }, requirementsForward: { required: true, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(translationHeld.complete, false);
assert.strictEqual(translationHeld.unresolved.length, 1);
assert.strictEqual(translationHeld.unresolved[0].relevance.disposition, 'BLOCKING_DISCOVERED_TRANSLATION');

// A resolved active-profile compatibility decision is allowed to close a PATCH/HOTFIX candidate without a persisted registry row.
const envResolved = assessComponentDiscovery({
  candidates: [{
    kind: 'PATCH', family: 'LUX', source: 'DESCRIPTION_LINK', key: 'PATCH:mod:42:',
    environmentDecision: {
      source: 'ENVIRONMENT_GRAPH', resolved: true, status: 'NOT_APPLICABLE', confidence: 'high', reason: 'COUNTERPART_ABSENT_FROM_PROFILE', evidence: [],
    },
  }],
  rules: [],
  coverage: { environmentGraph: { required: false, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(envResolved.complete, true);
assert.strictEqual(envResolved.unresolved.length, 0);
assert.strictEqual(envResolved.candidates[0].decision.source, 'ENVIRONMENT_GRAPH');
assert.strictEqual(envResolved.candidates[0].decision.status, 'NOT_APPLICABLE');

// Environment hints must not auto-resolve required resources.
const envRequiredStillHeld = assessComponentDiscovery({
  candidates: [{
    kind: 'RESOURCE', family: 'GENERAL', source: 'REQUIREMENTS_FORWARD', key: 'RESOURCE:mod:99:', requiredHint: true,
    environmentDecision: {
      source: 'ENVIRONMENT_GRAPH', resolved: false, status: 'UNRESOLVED', confidence: 'high', reason: 'REQUIRED_DEPENDENCY_ABSENT', evidence: [],
    },
  }],
  rules: [],
  coverage: { requirementsForward: { required: true, complete: true } },
});
assert.strictEqual(envRequiredStillHeld.complete, false);
assert.strictEqual(envRequiredStillHeld.unresolved.length, 1);

const held = assessComponentDiscovery({
  candidates: merged,
  rules: rules.filter(x => x.kind !== 'PHYSICS'),
  coverage: { requirementsForward: { required: true, complete: false, status: 'SECTION_NOT_PROVEN' } },
});
assert.strictEqual(held.complete, false);
assert.ok(held.unresolved.some(x => x.kind === 'PHYSICS'));
assert.ok(held.coverageProblems.some(x => x.source === 'requirementsForward'));

console.log('component discovery tests: OK');
