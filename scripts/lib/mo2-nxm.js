'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { scanExactDownload } = require('./download-guard');

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(v => path.resolve(v)))];
}

function mo2Roots({ modsDir = '', downloadsDir = '' } = {}) {
  return unique([
    process.env.MO2_ROOT || '',
    modsDir ? path.dirname(path.resolve(modsDir)) : '',
    downloadsDir ? path.dirname(path.resolve(downloadsDir)) : '',
  ]);
}

function findMo2Executable({ modsDir = '', downloadsDir = '' } = {}) {
  const explicit = [process.env.MO2_EXE, process.env.MO2_NXM_HANDLER].filter(existsFile);
  if (explicit.length) return path.resolve(explicit[0]);
  for (const root of mo2Roots({ modsDir, downloadsDir })) {
    for (const name of ['ModOrganizer.exe', 'ModOrganizer2.exe']) {
      const candidate = path.join(root, name);
      if (existsFile(candidate)) return candidate;
    }
  }
  return '';
}

// ModOrganizer.exe itself accepts an nxm:// URL on its command line. If another
// MO2 process is already primary, MO2 forwards that link to the primary instance.
// This is a more direct handoff than going through nxmhandler.exe as a proxy.
function configureDirectNxmTarget({ modsDir = '', downloadsDir = '' } = {}) {
  const executable = findMo2Executable({ modsDir, downloadsDir });
  if (!executable) return { ok: false, executable: '', reason: 'MO2_EXE_NOT_FOUND' };
  process.env.MO2_NXM_HANDLER = executable;
  process.env.MO2_EXE = process.env.MO2_EXE || executable;
  process.env.MO2_ROOT = process.env.MO2_ROOT || path.dirname(executable);
  return { ok: true, executable, reason: 'DIRECT_MODORGANIZER_NXM' };
}

function launchNxmDirect(executable, nxm, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!existsFile(executable)) return reject(new Error(`MO2_EXE_NOT_FOUND: ${executable || '(empty)'}`));
    if (!String(nxm || '').startsWith('nxm://')) return reject(new Error('NXM_INVALID: signed nxm URL missing'));
    cp.execFile(executable, [nxm], {
      cwd: path.dirname(executable),
      windowsHide: true,
      timeout: timeoutMs,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`NXM_LAUNCH_FAILED: ${err.message}`), { cause: err }));
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExactHandoff({ downloadsDir, modId, fileId, timeoutMs = 25000, pollMs = 500 } = {}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let last = scanExactDownload(downloadsDir, modId, fileId);
  while (Date.now() < deadline) {
    if (last.status !== 'ABSENT') return { accepted: true, state: last };
    await sleep(Math.max(100, pollMs));
    last = scanExactDownload(downloadsDir, modId, fileId);
  }
  return { accepted: false, state: last, errorCode: 'NXM_HANDOFF_NOT_ACCEPTED' };
}

async function waitForExactComplete({ downloadsDir, modId, fileId, timeoutMs = 180000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let last = scanExactDownload(downloadsDir, modId, fileId);
  while (Date.now() < deadline) {
    if (last.status === 'COMPLETE') return { complete: true, state: last };
    await sleep(Math.max(100, pollMs));
    last = scanExactDownload(downloadsDir, modId, fileId);
  }
  return { complete: false, state: last, errorCode: last.status === 'ABSENT' ? 'NXM_HANDOFF_NOT_ACCEPTED' : 'MO2_DOWNLOAD_STALLED' };
}

module.exports = {
  existsFile,
  mo2Roots,
  findMo2Executable,
  configureDirectNxmTarget,
  launchNxmDirect,
  waitForExactHandoff,
  waitForExactComplete,
};
