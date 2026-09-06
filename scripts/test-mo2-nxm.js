#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mo2Roots,
  findMo2Executable,
  configureDirectNxmTarget,
  waitForExactHandoff,
} = require('./lib/mo2-nxm');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mo2-nxm-test-'));
  const root = path.join(tmp, 'mo2');
  const mods = path.join(root, 'mods');
  const downloads = path.join(root, 'downloads');
  fs.mkdirSync(mods, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  const exe = path.join(root, 'ModOrganizer.exe');
  fs.writeFileSync(exe, 'fake', 'utf8');

  const old = {
    MO2_ROOT: process.env.MO2_ROOT,
    MO2_EXE: process.env.MO2_EXE,
    MO2_NXM_HANDLER: process.env.MO2_NXM_HANDLER,
  };
  delete process.env.MO2_ROOT;
  delete process.env.MO2_EXE;
  delete process.env.MO2_NXM_HANDLER;

  try {
    assert.ok(mo2Roots({ modsDir: mods, downloadsDir: downloads }).includes(path.resolve(root)));
    assert.strictEqual(findMo2Executable({ modsDir: mods, downloadsDir: downloads }), path.resolve(exe));
    const configured = configureDirectNxmTarget({ modsDir: mods, downloadsDir: downloads });
    assert.strictEqual(configured.ok, true);
    assert.strictEqual(configured.executable, path.resolve(exe));
    assert.strictEqual(process.env.MO2_NXM_HANDLER, path.resolve(exe));

    setTimeout(() => {
      const archive = path.join(downloads, 'Example.7z');
      fs.writeFileSync(archive, 'data', 'utf8');
      fs.writeFileSync(`${archive}.meta`, 'modID=123\nfileID=456\nname=Example\nversion=1.0\n', 'utf8');
    }, 60);
    const accepted = await waitForExactHandoff({ downloadsDir: downloads, modId: '123', fileId: '456', timeoutMs: 1000, pollMs: 20 });
    assert.strictEqual(accepted.accepted, true);
    assert.strictEqual(accepted.state.status, 'COMPLETE');

    const absent = await waitForExactHandoff({ downloadsDir: downloads, modId: '999', fileId: '888', timeoutMs: 120, pollMs: 20 });
    assert.strictEqual(absent.accepted, false);
    assert.strictEqual(absent.errorCode, 'NXM_HANDOFF_NOT_ACCEPTED');
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('mo2 nxm tests: OK');
})().catch(err => { console.error(err); process.exit(1); });
