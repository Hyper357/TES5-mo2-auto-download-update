'use strict';

const assert = require('assert');
const { candidateRelevance, assessComponentDiscovery } = require('./lib/component-discovery');

function rel(overrides) {
  return candidateRelevance({
    kind: 'RESOURCE',
    source: 'DESCRIPTION_TEXT',
    family: 'GENERAL',
    name: '',
    evidence: '',
    requiredHint: false,
    optionalHint: false,
    installed: false,
    installedContextMatch: false,
    environmentDecision: { resolved: false, status: 'UNRESOLVED', reason: 'NO_SAFE_INFERENCE', evidence: [] },
    decision: { resolved: false, status: 'UNRESOLVED' },
    ...overrides,
  }, { mainName: 'Example Main', mainVersion: '2.0' });
}

// Natural language must never become a hard dependency merely because it says "required".
assert.strictEqual(rel({ source: 'DESCRIPTION_TEXT', kind: 'CONFIG', requiredHint: true, name: 'general syntax of the document required for these settings' }).blocking, false);
assert.strictEqual(rel({ source: 'DESCRIPTION_TEXT', kind: 'OPTIONAL_COMPONENT', requiredHint: true, name: 'mark pieces as required, optional or locked' }).blocking, false);
assert.strictEqual(rel({ source: 'DESCRIPTION_TEXT', kind: 'PATCH', requiredHint: true, name: "It's not required to use both Icy Fixes and Meshes together." }).blocking, false);

// Description links to installed runtimes/frameworks are context, not companion archives.
assert.strictEqual(rel({ source: 'DESCRIPTION_LINK', kind: 'RESOURCE', name: 'Address Library for SKSE Plugins', installedContextMatch: true }).blocking, false);
assert.strictEqual(rel({ source: 'DESCRIPTION_LINK', kind: 'PHYSICS', name: 'FSMP - Faster HDT-SMP', installedContextMatch: true }).blocking, false);

// Direct Chinese translation relationships stay blocking.
assert.strictEqual(rel({ source: 'DESCRIPTION_LINK', kind: 'TRANSLATION', family: 'ZH_CN', name: 'Mandarin Translation' }).blocking, true);

// A satisfied prerequisite must not block a Main update.
assert.strictEqual(rel({
  source: 'REQUIREMENTS_FORWARD', kind: 'RESOURCE', requiredHint: true, name: 'Address Library for SKSE Plugins',
  evidence: 'This mod requires Address Library for SKSE Plugins',
  environmentDecision: { resolved: false, status: 'UNRESOLVED', reason: 'REQUIRED_DEPENDENCY_ENABLED', evidence: ['Address Library'] },
}).blocking, false);

// A generic Requirements-section scrape is advisory, even if the scraper set requiredHint.
assert.strictEqual(rel({
  source: 'REQUIREMENTS_FORWARD', kind: 'RESOURCE', requiredHint: true, name: 'ConsoleUtilSSE NG',
  evidence: 'Nexus Requirements ConsoleUtilSSE NG',
  environmentDecision: { resolved: false, status: 'UNRESOLVED', reason: 'REQUIRED_DEPENDENCY_ABSENT', evidence: [] },
}).blocking, false);

// A genuinely explicit missing requirement still HOLDs.
assert.strictEqual(rel({
  source: 'REQUIREMENTS_FORWARD', kind: 'RESOURCE', requiredHint: true, name: 'New Runtime Library',
  evidence: 'This mod requires New Runtime Library',
  environmentDecision: { resolved: false, status: 'UNRESOLVED', reason: 'REQUIRED_DEPENDENCY_ABSENT', evidence: [] },
}).blocking, true);

// Same-page non-Main files are not automatically required just because they exist.
assert.strictEqual(rel({ source: 'SAME_PAGE_FILE', kind: 'PATCH', category: 'OPTIONAL FILES', family: 'CUSTOM:OTHER_ARMOR', name: 'Children of the First - Skypatcher Patch - GDPR' }).blocking, false);
assert.strictEqual(rel({ source: 'SAME_PAGE_FILE', kind: 'MESH', category: 'MISCELLANEOUS', family: 'CUSTOM:OTHER_MODEL', name: 'Other armor meshes - GDPR' }).blocking, false);

// A same-page compatibility patch becomes blocking only with positive active counterpart evidence; explicit Optional wins.
assert.strictEqual(rel({
  source: 'SAME_PAGE_FILE', kind: 'PATCH', category: 'OPTIONAL FILES', family: 'LUX_ORBIS', name: 'Lux Orbis compatibility patch', optionalHint: true,
  environmentDecision: { resolved: false, status: 'UNRESOLVED', reason: 'COMPAT_COUNTERPART_ENABLED', evidence: ['Lux Orbis.esp'] },
}).blocking, false);
assert.strictEqual(rel({
  source: 'SAME_PAGE_FILE', kind: 'PATCH', category: '', family: 'LUX_ORBIS', name: 'Lux Orbis compatibility patch',
  environmentDecision: { resolved: false, status: 'UNRESOLVED', reason: 'COMPAT_COUNTERPART_ENABLED', evidence: ['Lux Orbis.esp'] },
}).blocking, true);

// Installed neighbors do not become companions by fuzzy name match; installed translations do.
assert.strictEqual(rel({ source: 'INSTALLED_COMPONENT', kind: 'PHYSICS', installed: true, installedContextMatch: true, name: 'Third-party SMP Hair' }).blocking, false);
assert.strictEqual(rel({ source: 'INSTALLED_COMPONENT', kind: 'TRANSLATION', family: 'ZH_CN', installed: true, installedContextMatch: true, name: 'Horde 汉化包' }).blocking, true);

// Integration: false evidence should produce a complete discovery record, while a Chinese translation stays unresolved.
const falseOnly = assessComponentDiscovery({
  candidates: [
    { kind: 'RESOURCE', source: 'DESCRIPTION_LINK', name: 'Address Library', family: 'CUSTOM:ADDRESS', installedContextMatch: true, decision: { resolved: false }, environmentDecision: { reason: 'NO_SAFE_INFERENCE' } },
    { kind: 'CONFIG', source: 'DESCRIPTION_TEXT', name: 'settings are required here', family: 'CUSTOM:TEXT', requiredHint: true, decision: { resolved: false }, environmentDecision: { reason: 'NO_SAFE_INFERENCE' } },
  ],
  rules: [], coverage: { description: { required: true, complete: true, status: 'COMPLETE' } }, mainName: 'QuickLootRE', mainVersion: '2.3.6',
});
assert.strictEqual(falseOnly.complete, true);
assert.strictEqual(falseOnly.unresolved.length, 0);

const translation = assessComponentDiscovery({
  candidates: [{ kind: 'TRANSLATION', source: 'DESCRIPTION_LINK', name: 'Mandarin Translation', family: 'ZH_CN', decision: { resolved: false }, environmentDecision: { reason: 'NO_SAFE_INFERENCE' } }],
  rules: [], coverage: { description: { required: true, complete: true, status: 'COMPLETE' } }, mainName: 'Icy Mesh Remaster', mainVersion: '2.2.1',
});
assert.strictEqual(translation.complete, false);
assert.strictEqual(translation.unresolved.length, 1);

console.log('component false-blocker tests: OK');
