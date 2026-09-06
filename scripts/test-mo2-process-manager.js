'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executableCandidates, findExecutable } = require('./mo2-process-manager');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-mo2-process-'));
const mods = path.join(root, 'mods');
fs.mkdirSync(mods, { recursive: true });
const exe = path.join(root, 'ModOrganizer.exe');
fs.writeFileSync(exe, 'fixture', 'utf8');
try {
  const candidates = executableCandidates(mods);
  assert.ok(candidates.some(x => path.resolve(x) === path.resolve(exe)));
  assert.strictEqual(path.resolve(findExecutable(mods)), path.resolve(exe));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('MO2 process manager tests: OK');
