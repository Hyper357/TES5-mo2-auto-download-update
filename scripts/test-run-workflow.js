#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { MODE, buildIndexArgs, workflowDescription, positionalModsDir } = require('./run-workflow');

const updateArgs = buildIndexArgs(MODE.UPDATE, ['E:\\SkyrimAE\\mo2\\mods', 'E:\\SkyrimAE\\tools\\.nexus_api_key']);
assert.ok(updateArgs[0].endsWith(path.join('', 'index.js')));
assert.ok(updateArgs.includes('--go'));
assert.ok(!updateArgs.includes('--debug'), 'normal update runs must not enable verbose debug output by default');
assert.ok(updateArgs.includes('--continue-on-error'));
assert.ok(updateArgs.includes('--force-refresh'));
assert.ok(updateArgs.includes('--no-reconnect'));
assert.ok(updateArgs.includes('E:\\SkyrimAE\\mo2\\mods'));
assert.strictEqual(positionalModsDir(['E:\\SkyrimAE\\mo2\\mods', 'E:\\SkyrimAE\\tools\\.nexus_api_key']), 'E:\\SkyrimAE\\mo2\\mods');

const debugArgs = buildIndexArgs(MODE.UPDATE, ['--debug']);
assert.ok(debugArgs.includes('--debug'), 'debug remains available when explicitly requested');

const auditArgs = buildIndexArgs(MODE.AUDIT, []);
assert.ok(!auditArgs.includes('--go'));
assert.ok(!auditArgs.includes('--no-reconnect'));
assert.ok(auditArgs.includes('--force-refresh'));
assert.throws(() => buildIndexArgs(MODE.AUDIT, ['--go']), /禁止 --go/);
assert.throws(() => buildIndexArgs('wat', []), /未知 workflow mode/);

const full = workflowDescription(MODE.UPDATE);
assert.strictEqual(full.realDownload, true);
assert.strictEqual(full.noMidstreamConfirmation, true);
assert.strictEqual(full.continueOnItemError, true);

const audit = workflowDescription(MODE.AUDIT);
assert.strictEqual(audit.realDownload, false);
assert.strictEqual(audit.noMidstreamConfirmation, true);

console.log('run-workflow tests: OK');
