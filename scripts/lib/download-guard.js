'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function parseMetaText(text) {
  const get = key => {
    const m = String(text || '').match(new RegExp(`^${key}=(.*)$`, 'mi'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  };
  return {
    modId: get('modID'),
    fileId: get('fileID'),
    name: get('name'),
    version: get('version'),
  };
}

function metaRecord(downloadsDir, fileName) {
  const metaPath = path.join(downloadsDir, fileName);
  let text = '';
  try { text = fs.readFileSync(metaPath, 'utf8'); } catch { return null; }
  const meta = parseMetaText(text);
  const unfinishedMeta = fileName.toLowerCase().endsWith('.unfinished.meta');
  const baseName = unfinishedMeta
    ? fileName.slice(0, -'.unfinished.meta'.length)
    : fileName.slice(0, -'.meta'.length);
  const archivePath = path.join(downloadsDir, baseName);
  const unfinishedPath = `${archivePath}.unfinished`;
  const archiveStat = safeStat(archivePath);
  const unfinishedStat = safeStat(unfinishedPath);
  const metaStat = safeStat(metaPath);
  return {
    fileName,
    metaPath,
    archivePath,
    unfinishedPath,
    unfinishedMeta,
    meta,
    archiveExists: !!archiveStat?.isFile(),
    archiveSize: archiveStat?.isFile() ? archiveStat.size : 0,
    unfinishedExists: !!unfinishedStat?.isFile(),
    unfinishedSize: unfinishedStat?.isFile() ? unfinishedStat.size : 0,
    mtimeMs: Math.max(metaStat?.mtimeMs || 0, archiveStat?.mtimeMs || 0, unfinishedStat?.mtimeMs || 0),
  };
}

function scanExactDownload(downloadsDir, modId, fileId) {
  const wantedMod = String(modId || '');
  const wantedFile = String(fileId || '');
  if (!downloadsDir || !wantedMod || !wantedFile || !fs.existsSync(downloadsDir)) {
    return { status: 'ABSENT', modId: wantedMod, fileId: wantedFile, records: [] };
  }

  let names = [];
  try { names = fs.readdirSync(downloadsDir); } catch { return { status: 'ABSENT', modId: wantedMod, fileId: wantedFile, records: [] }; }
  const records = names
    .filter(n => n.toLowerCase().endsWith('.meta'))
    .map(n => metaRecord(downloadsDir, n))
    .filter(Boolean)
    .filter(r => String(r.meta.modId) === wantedMod && String(r.meta.fileId) === wantedFile);

  if (!records.length) return { status: 'ABSENT', modId: wantedMod, fileId: wantedFile, records: [] };

  const complete = records.find(r => !r.unfinishedMeta && r.archiveExists && r.archiveSize > 0 && !r.unfinishedExists);
  if (complete) {
    return {
      status: 'COMPLETE', modId: wantedMod, fileId: wantedFile,
      records, primary: complete,
      newestMtimeMs: Math.max(...records.map(r => r.mtimeMs || 0)),
    };
  }

  const newest = records.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
  return {
    status: 'INFLIGHT', modId: wantedMod, fileId: wantedFile,
    records, primary: newest,
    newestMtimeMs: Math.max(...records.map(r => r.mtimeMs || 0)),
    reason: newest.unfinishedMeta ? 'UNFINISHED_META' : (newest.unfinishedExists ? 'UNFINISHED_ARCHIVE' : 'META_WITHOUT_COMPLETE_ARCHIVE'),
  };
}

function entryKey(modId, fileId) {
  return `${String(modId || '')}:${String(fileId || '')}`;
}

function loadLedger(file) {
  if (!file || !fs.existsSync(file)) return { version: 1, items: {}, updatedAt: null };
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!x || typeof x !== 'object') throw new Error('bad ledger');
    x.version = 1;
    x.items ||= {};
    return x;
  } catch {
    return { version: 1, items: {}, updatedAt: null };
  }
}

function saveLedger(file, ledger) {
  ledger.version = 1;
  ledger.updatedAt = nowIso();
  atomicWriteJson(file, ledger);
}

function patchLedgerEntry(ledger, modId, fileId, patch) {
  const key = entryKey(modId, fileId);
  const prev = ledger.items[key] || { modId: String(modId), fileId: String(fileId), firstSeenAt: nowIso() };
  ledger.items[key] = {
    ...prev,
    ...patch,
    modId: String(modId),
    fileId: String(fileId),
    updatedAt: nowIso(),
  };
  return ledger.items[key];
}

function entryAgeMs(entry, now = Date.now()) {
  const ts = Date.parse(entry?.submittedAt || entry?.updatedAt || entry?.firstSeenAt || '');
  return Number.isFinite(ts) ? Math.max(0, now - ts) : Infinity;
}

const ACTIVE_LEDGER_STATES = new Set([
  'SUBMITTING', 'SUBMITTED', 'WAITING_EXISTING', 'VERIFY_TIMEOUT', 'POSSIBLY_SUBMITTED',
]);

function shouldSuppressResubmit(entry, ttlMs, now = Date.now()) {
  if (!entry) return { suppress: false, reason: 'NO_LEDGER_ENTRY', ageMs: Infinity };
  const ageMs = entryAgeMs(entry, now);
  if (entry.status === 'VERIFIED') return { suppress: true, reason: 'LEDGER_VERIFIED', ageMs };
  if (ACTIVE_LEDGER_STATES.has(entry.status) && ageMs <= ttlMs) {
    return { suppress: true, reason: `LEDGER_${entry.status}`, ageMs };
  }
  if (ACTIVE_LEDGER_STATES.has(entry.status) && ageMs > ttlMs) {
    return { suppress: false, reason: 'LEDGER_STALE', ageMs };
  }
  return { suppress: false, reason: `LEDGER_${entry.status || 'UNKNOWN'}`, ageMs };
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function acquireExecutorLock(file, metadata = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  const payload = { pid: process.pid, token, startedAt: nowIso(), ...metadata };

  const attempt = () => {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fs.closeSync(fd);
      return { ok: true, file, token, payload };
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      if (owner && isPidAlive(owner.pid)) return { ok: false, file, owner, stale: false };
      try { fs.unlinkSync(file); } catch (_) {}
      return null;
    }
  };

  const first = attempt();
  if (first) return first;
  const second = attempt();
  return second || { ok: false, file, owner: null, stale: true };
}

function releaseExecutorLock(handle) {
  if (!handle?.ok || !handle.file) return false;
  try {
    const owner = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
    if (owner.token !== handle.token || Number(owner.pid) !== process.pid) return false;
  } catch { return false; }
  try { fs.unlinkSync(handle.file); return true; } catch { return false; }
}

module.exports = {
  parseMetaText,
  scanExactDownload,
  entryKey,
  loadLedger,
  saveLedger,
  patchLedgerEntry,
  entryAgeMs,
  shouldSuppressResubmit,
  acquireExecutorLock,
  releaseExecutorLock,
  isPidAlive,
};
