#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gateClearedRow, runtimeConfig } = require('./smoke-download');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-target-test-'));
try {
  fs.writeFileSync(path.join(tmp, 'manifest-final.tsv'), [
    '16495\tJContainers SE\t4.3.2\tclosure=PASS\t800245\tDOWNLOAD',
    '12688\tmoreHUD\t5.4.4\tcomponentDiscovery=HOLD\t800457\tHOLD_COMPONENT_DISCOVERY',
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'review-center-config.json'), JSON.stringify({
    modsDir: 'X:/MO2/mods', downloadsDir: 'X:/MO2/downloads', apiKeyFile: 'X:/key', sevenzip: 'X:/7z.exe',
  }), 'utf8');

  const cleared = gateClearedRow(tmp, '16495');
  assert.ok(cleared);
  assert.strictEqual(cleared.fileId, '800245');
  assert.strictEqual(cleared.action, 'DOWNLOAD');
  assert.strictEqual(gateClearedRow(tmp, '12688'), null, 'Smoke must never convert a HOLD row into DOWNLOAD');
  assert.strictEqual(gateClearedRow(tmp, '99999'), null);

  const cfg = runtimeConfig(tmp);
  assert.strictEqual(cfg.modsDir, 'X:/MO2/mods');
  assert.strictEqual(cfg.downloadsDir, 'X:/MO2/downloads');
  assert.strictEqual(cfg.apiKeyFile, 'X:/key');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('smoke download tests: OK');
