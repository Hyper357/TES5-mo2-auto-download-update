'use strict';

const assert = require('assert');
const ModProfile = require('./lib/profile');

function mods(names) {
  return names.map(folderName => ({ folderName, installationFile: '' }));
}

{
  const p = ModProfile.analyzeFromMods(mods(['SkyUI', 'USSEP', 'RaceMenu', 'Lux']));
  assert.strictEqual(p.platform, 'UNKNOWN', 'no runtime evidence must stay UNKNOWN');
  assert.strictEqual(p.bodyType, 'UNKNOWN', 'no body evidence must stay UNKNOWN');
  assert.strictEqual(p.textureTier, 'UNKNOWN', 'no texture evidence must stay UNKNOWN');
}

{
  const p = ModProfile.analyzeFromMods(mods([
    'Engine Fixes Skyrim AE 1.6.1170',
    'Address Library 1.6.1170',
    'Crash Logger Skyrim AE',
    'Papyrus Extender 1.6.1170',
  ]));
  assert.strictEqual(p.platform, 'AE');
  assert.notStrictEqual(p.confidence.platform, 'low');
}

{
  const p = ModProfile.analyzeFromMods(mods([
    'CBBE 3BA', '3BA BodySlide', '3BA Physics', 'CBBE textures', 'BHUNP optional',
  ]));
  assert.strictEqual(p.bodyType, '3BA');
}

{
  const p = ModProfile.analyzeFromMods(mods([
    'CBBE Body', 'BHUNP Body',
  ]));
  assert.strictEqual(p.bodyType, 'UNKNOWN', 'ambiguous body evidence must remain UNKNOWN');
}

{
  const p = new ModProfile({ platform: 'UNKNOWN', bodyType: 'UNKNOWN' });
  assert.strictEqual(p.isCompatible({ name: 'VR build', file_name: 'vr.zip', category_id: 1 }, {}), true,
    'UNKNOWN profile must not invent a non-VR hard rejection');
}

console.log('profile tests: OK');
