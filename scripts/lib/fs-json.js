'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Windows takes transient exclusive handles on a file for a moment after it is
// closed: Defender's real-time scanner and the search indexer both open one.
// A rename onto a file in that window fails with EPERM/EBUSY/EACCES even though
// nothing is wrong. Treating that as fatal is what aborted a whole download
// batch on 2026-10-10 after a single state write, so retry with a bounded
// backoff before giving up.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Replace `to` with `from` atomically, retrying transient Windows locks.
// Worst case with the defaults is ~2s of backoff. Never deletes anything: the
// caller owns `from` and must clean it up itself, because not every rename here
// has a disposable source (a cross-volume download staging file, for example,
// would be real data loss to remove).
function atomicReplace(from, to, { attempts = 8, baseDelayMs = 25, maxDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(from, to); return; }
    catch (err) {
      lastErr = err;
      if (!TRANSIENT_RENAME_CODES.has(err && err.code)) throw err;
      sleepSync(Math.min(baseDelayMs * (2 ** i), maxDelayMs));
    }
  }
  throw lastErr;
}

function loadJson(file, fallback = null) {
  if (!file || !fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function saveJson(file, value, { atomic = true } = {}) {
  ensureDir(path.dirname(file));
  const body = JSON.stringify(value, null, 2);
  if (!atomic) {
    fs.writeFileSync(file, body, 'utf8');
    return file;
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    atomicReplace(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw err;
  }
  return file;
}

function safeJson(text, fallback = null) {
  try { return JSON.parse(String(text || '')); }
  catch { return fallback; }
}

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return fallback; }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

module.exports = { ensureDir, loadJson, saveJson, safeJson, readText, writeText, atomicReplace, sleepSync };
