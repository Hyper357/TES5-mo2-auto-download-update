#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { matchFamilyInEnvironment } = require('./lib/mo2-environment');
const { assessAuxRowEnvironment } = require('./lib/aux-applicability');

function graphWith(names) {
  return {
    profile: { usableForApplicability: true },
    mods: names.map((name, i) => ({
      name,
      state: 'ENABLED',
      enabled: true,
      separator: false,
      installationFile: `${name}.7z`,
      plugins: [],
      modId: String(1000 + i),
    })),
    missingModlistEntries: [],
    plugins: [],
  };
}

// Regression: Lux Orbis must never satisfy a plain Lux compatibility patch.
{
  const graph = graphWith(['Lux Orbis']);
  assert.strictEqual(matchFamilyInEnvironment(graph, 'LUX_ORBIS').status, 'ENABLED');
  assert.strictEqual(matchFamilyInEnvironment(graph, 'LUX').status, 'ABSENT');
  const d = assessAuxRowEnvironment({ note: 'tx=1:2; closure:PATCH:LUX for 1:2' }, graph);
  assert.strictEqual(d.decision, 'SKIP');
  assert.strictEqual(d.family, 'LUX');
}

// Plain Lux does satisfy a Lux patch.
{
  const graph = graphWith(['Lux']);
  const d = assessAuxRowEnvironment({ note: 'tx=1:2; closure:PATCH:LUX for 1:2' }, graph);
  assert.strictEqual(d.decision, 'ALLOW');
}

// Unknown custom compatibility targets are never auto-downloaded merely because a registry row exists.
{
  const graph = graphWith(['Lux Orbis', 'JK Skyrim']);
  const d = assessAuxRowEnvironment({ note: 'tx=1:2; closure:PATCH:CUSTOM:CAPITAL_WINDHELM for 1:2' }, graph);
  assert.strictEqual(d.decision, 'HOLD');
  assert.strictEqual(d.reason, 'CUSTOM_COUNTERPART_NOT_PROVEN');
}

// A strong two-token active-context hit can positively prove a custom counterpart.
{
  const graph = graphWith(['Capital Windhelm Expansion']);
  const d = assessAuxRowEnvironment({ note: 'tx=1:2; closure:PATCH:CUSTOM:CAPITAL_WINDHELM for 1:2' }, graph);
  assert.strictEqual(d.decision, 'ALLOW');
}

console.log('patch applicability tests: OK');
