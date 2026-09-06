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
assert.strictEqual(classifyComponent('Mandarin translation'), 'TRANSLATION');
assert.strictEqual(classifyComponent('Plain unrelated sentence'), '');
assert.strictEqual(classifyComponent('Some Framework', { source: 'REQUIREMENTS_FORWARD' }), 'RESOURCE');

const optional = mergeComponentCandidates([
  { source: 'SAME_PAGE_FILE', fileId: '40', name: 'Optional 2K texture pack', mainName: 'Example Main' },
]);
assert.strictEqual(optional[0].kind, 'TEXTURE');
assert.strictEqual(optional[0].optionalHint, true);
assert.strictEqual(candidateRelevance(optional[0]).blocking, false, 'explicit optional/uninstalled file is evidence, not an automatic closure blocker');

// A translation list often has shared context containing many languages. Do not label
// French/German/etc. links ZH_CN merely because their parent block also mentions Mandarin.
const translationLinks = mergeComponentCandidates([
  { source:'DESCRIPTION_LINK', auxModId:'100', name:'French', evidence:'French translation; Mandarin Author:Someone moreHUD CHS', mainName:'moreHUD' },
  { source:'DESCRIPTION_LINK', auxModId:'101', name:'Mandarin', evidence:'Mandarin Author:Someone moreHUD CHS', mainName:'moreHUD' },
]);
assert.strictEqual(translationLinks.length, 1);
assert.strictEqual(translationLinks[0].auxModId, '101');
assert.strictEqual(translationLinks[0].family, 'ZH_CN');

assert.strictEqual(candidateRuleMatches(
  { kind:'PHYSICS', auxModId:'123', fileId:'200', family:'CUSTOM:HDT' },
  { kind:'PHYSICS', auxModId:'123', auxFileId:'201', family:'CUSTOM:HDT', status:'REQUIRED' },
), false);
assert.strictEqual(candidateRuleMatches(
  { kind:'PHYSICS', auxModId:'123', fileId:'200', family:'CUSTOM:HDT' },
  { kind:'PHYSICS', auxModId:'123', auxFileId:'200', family:'CUSTOM:OTHER', status:'REQUIRED' },
), true);

const raw = [
  { source: 'REQUIREMENTS_FORWARD', kind: 'RESOURCE', auxModId: '10', name: 'Required Framework', evidence: 'This mod requires Required Framework', mainName: 'Example Main', requiredHint: true },
  { source: 'SAME_PAGE_FILE', fileId: '20', version: '1.0', name: 'HDT-SMP Physics Files', mainName: 'Example Main', requiredHint: true, evidence: 'required files component' },
  { source: 'SAME_PAGE_FILE', fileId: '30', version: '1.0', name: 'HOTFIX - missing textures', mainName: 'Example Main', requiredHint: true, evidence: 'required file hotfix' },
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

// Old same-page archives whose names are the same product are historical evidence,
// not required hotfix/component companions for the newest Main.
const historical = assessComponentDiscovery({
  candidates: mergeComponentCandidates([
    { source:'SAME_PAGE_FILE', kind:'HOTFIX', fileId:'37893', version:'3.0.7a', name:'moreHUD SE Alpha', mainName:'moreHUD Light Master - SE and AE', evidence:'More bug fixes' },
  ]),
  rules: [],
  mainVersion: '5.4.4.0',
  mainName: 'moreHUD Light Master - SE and AE',
  coverage: { samePageComponents:{required:true,complete:true}, requirementsForward:{required:true,complete:true}, description:{required:true,complete:true} },
});
assert.strictEqual(historical.complete, true);
assert.strictEqual(historical.nonBlocking.length, 1);
assert.strictEqual(historical.nonBlocking[0].relevance.disposition, 'NON_BLOCKING_HISTORICAL_SIBLING');

// Reverse Nexus requirements are downstream consumers, never companion download authorization.
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

// Nexus markup sometimes does not prove a distinct forward Requirements section. If
// Description was inspected successfully and no forward required candidate was found,
// SECTION_NOT_PROVEN is advisory rather than a blanket zero-download gate.
const forwardMarkupAmbiguous = assessComponentDiscovery({
  candidates: [], rules: [],
  coverage: {
    requirementsForward:{required:true,complete:false,status:'SECTION_NOT_PROVEN'},
    description:{required:true,complete:true},
  },
});
assert.strictEqual(forwardMarkupAmbiguous.complete, true);
assert.strictEqual(forwardMarkupAmbiguous.coverageProblems.length, 0);
assert.strictEqual(forwardMarkupAmbiguous.advisoryCoverage.length, 1);

// Even an installed downstream consumer stays advisory: reverse dependency does not mean companion file.
const reverseInstalled = assessComponentDiscovery({
  candidates: [{
    kind: 'PATCH', family: 'CUSTOM:SOME_DOWNSTREAM_MOD', source: 'REQUIREMENTS_REVERSE', key: 'PATCH:mod:900:',
    auxModId: '900', name: 'Some downstream compatibility mod', installedContextMatch: true,
  }],
  rules: [],
  coverage: { requirementsForward: { required: true, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(reverseInstalled.complete, true);
assert.strictEqual(reverseInstalled.unresolved.length, 0);
assert.strictEqual(reverseInstalled.nonBlocking[0].relevance.disposition, 'NON_BLOCKING_REVERSE_UNINSTALLED');

// Explicit optional same-page evidence does not hold an otherwise clean Main.
const optionalAssessed = assessComponentDiscovery({
  candidates: optional,
  rules: [],
  coverage: { samePageComponents: { required: true, complete: true }, requirementsForward: { required: true, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(optionalAssessed.complete, true);
assert.strictEqual(optionalAssessed.unresolved.length, 0);
assert.strictEqual(optionalAssessed.nonBlocking.length, 1);

// A directly discovered Chinese translation remains blocking so localization is never silently forgotten.
const translationHeld = assessComponentDiscovery({
  candidates: mergeComponentCandidates([{ kind: 'TRANSLATION', family: 'ZH_CN', source: 'SAME_PAGE_FILE', fileId: '77', name: 'Chinese Translation' }]),
  rules: [],
  coverage: { samePageComponents: { required: true, complete: true }, requirementsForward: { required: true, complete: true }, description: { required: true, complete: true } },
});
assert.strictEqual(translationHeld.complete, false);
assert.strictEqual(translationHeld.unresolved.length, 1);
assert.strictEqual(translationHeld.unresolved[0].kind, 'TRANSLATION');

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

// A positively explicit required Resource that is absent still HOLDs.
const envRequiredStillHeld = assessComponentDiscovery({
  candidates: [{
    kind: 'RESOURCE', family: 'GENERAL', source: 'REQUIREMENTS_FORWARD', key: 'RESOURCE:mod:99:', requiredHint: true,
    name: 'Missing Runtime Library', evidence: 'This mod requires Missing Runtime Library',
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
