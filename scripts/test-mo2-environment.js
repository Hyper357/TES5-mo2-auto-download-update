'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseSelectedProfileText,
  parseModlistText,
  parsePluginsText,
  buildEnvironmentGraph,
  enabledContextNames,
  matchFamilyInEnvironment,
  modIdState,
  assessCandidateEnvironment,
} = require('./lib/mo2-environment');

assert.strictEqual(parseSelectedProfileText('[General]\nselected_profile=@ByteArray(Default)\n'), 'Default');
assert.deepStrictEqual(parseModlistText('+Lux\n-USSEP\n*Visuals_separator\n').map(x => x.state), ['ENABLED', 'DISABLED', 'SEPARATOR']);
assert.deepStrictEqual(parsePluginsText('*Lux.esp\nUSSEP.esp\n').map(x => x.enabled), [true, false]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-env-'));
try {
  const modsDir = path.join(dir, 'mods');
  const profiles = path.join(dir, 'profiles');
  const profileDir = path.join(profiles, 'Default');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  function makeMod(name, modId, plugin = '') {
    const p = path.join(modsDir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'meta.ini'), `[General]\nmodid=${modId}\nversion=1.0\ninstallationFile=${name}.7z\n[installedFiles]\n0\\fileid=${Number(modId) + 1000}\n`, 'utf8');
    if (plugin) fs.writeFileSync(path.join(p, plugin), '', 'utf8');
  }

  makeMod('Lux', 43158, 'Lux.esp');
  makeMod('Unofficial Skyrim Special Edition Patch', 266, 'Unofficial Skyrim Special Edition Patch.esp');
  makeMod('KS Hairdos HDT-SMP', 31300);
  makeMod('Loose Unlisted Tool', 99999);
  fs.mkdirSync(path.join(modsDir, 'Visuals_separator'));

  fs.writeFileSync(path.join(dir, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\n', 'utf8');
  fs.writeFileSync(path.join(profileDir, 'modlist.txt'), [
    '+Lux',
    '-Unofficial Skyrim Special Edition Patch',
    '+KS Hairdos HDT-SMP',
    '*Visuals_separator',
    '+Missing Enabled Mod',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(profileDir, 'plugins.txt'), '*Lux.esp\nUnofficial Skyrim Special Edition Patch.esp\n', 'utf8');
  fs.writeFileSync(path.join(profileDir, 'loadorder.txt'), 'Lux.esp\nUnofficial Skyrim Special Edition Patch.esp\n', 'utf8');

  const graph = buildEnvironmentGraph({ modsDir });
  assert.strictEqual(graph.profile.resolved, true);
  assert.strictEqual(graph.profile.name, 'Default');
  assert.strictEqual(graph.profile.source, 'MODORGANIZER_INI');
  assert.strictEqual(graph.profile.usableForApplicability, true);
  assert.strictEqual(graph.uiWarningPolicy.trustedForUpdateDecision, false);
  assert.strictEqual(graph.summary.enabledMods, 2);
  assert.strictEqual(graph.summary.disabledMods, 1);
  assert.strictEqual(graph.summary.unlistedMods, 1);
  assert.strictEqual(graph.summary.missingModlistEntries, 1);

  const names = enabledContextNames(graph).join(' | ');
  assert.match(names, /Lux/);
  assert.match(names, /KS Hairdos HDT-SMP/);
  assert.ok(!/Unofficial Skyrim Special Edition Patch\.7z/.test(names));

  assert.strictEqual(matchFamilyInEnvironment(graph, 'LUX').status, 'ENABLED');
  assert.strictEqual(matchFamilyInEnvironment(graph, 'USSEP').status, 'DISABLED_ONLY');
  assert.strictEqual(modIdState(graph, '43158').status, 'ENABLED');
  assert.strictEqual(modIdState(graph, '266').status, 'DISABLED_ONLY');

  const ussepPatch = assessCandidateEnvironment({
    kind: 'PATCH', family: 'USSEP', source: 'DESCRIPTION_LINK', name: 'USSEP compatibility patch',
  }, graph);
  assert.strictEqual(ussepPatch.resolved, true);
  assert.strictEqual(ussepPatch.status, 'NOT_APPLICABLE');
  assert.strictEqual(ussepPatch.reason, 'COUNTERPART_DISABLED_IN_PROFILE');

  const luxPatch = assessCandidateEnvironment({
    kind: 'PATCH', family: 'LUX', source: 'DESCRIPTION_LINK', name: 'Lux patch',
  }, graph);
  assert.strictEqual(luxPatch.resolved, false);
  assert.strictEqual(luxPatch.reason, 'COMPAT_COUNTERPART_ENABLED');

  const disabledRequirement = assessCandidateEnvironment({
    kind: 'RESOURCE', source: 'REQUIREMENTS_FORWARD', auxModId: '266', requiredHint: true, name: 'USSEP',
  }, graph);
  assert.strictEqual(disabledRequirement.resolved, false);
  assert.strictEqual(disabledRequirement.reason, 'REQUIRED_DEPENDENCY_DISABLED');

  // Multiple profiles without a selected-profile signal must never silently choose Default.
  fs.rmSync(path.join(dir, 'ModOrganizer.ini'));
  const second = path.join(profiles, 'Other');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'modlist.txt'), '+Lux\n', 'utf8');
  const ambiguous = buildEnvironmentGraph({ modsDir });
  assert.strictEqual(ambiguous.profile.resolved, false);
  assert.strictEqual(ambiguous.profile.source, 'AMBIGUOUS_PROFILES');
  const noInference = assessCandidateEnvironment({ kind: 'PATCH', family: 'USSEP', source: 'DESCRIPTION_LINK' }, ambiguous);
  assert.strictEqual(noInference.resolved, false);
  assert.strictEqual(noInference.reason, 'PROFILE_UNRESOLVED');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('mo2 environment graph tests: OK');
