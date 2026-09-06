#!/usr/bin/env node
'use strict';

// v4.1.11 exact direct executor.
// Reuses one managed-browser/API session across the whole batch, avoids duplicate
// archive verification for newly published files, and re-checks local installed
// version/file identity immediately before any network download.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger, classifyFailure, sanitizeString } = require('./lib/diagnostics');
const {
  scanExactDownload,
  loadLedger,
  saveLedger,
  patchLedgerEntry,
  acquireExecutorLock,
  releaseExecutorLock,
} = require('./lib/download-guard');
const { scanModsDirectory } = require('./lib/mo2-reader');
const { compareVersions } = require('./lib/semver');
const { validVersion } = require('./lib/update-eligibility');
const {
  createDirectSession,
  closeDirectSession,
  runDirectTarget,
} = require('./lib/direct-session');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function parseManifest(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(line => {
      const [modId, name, ver, note, fileId, action] = line.split('\t').map(x => (x || '').trim());
      return { modId, name, ver, note, fileId, action: action || 'HOLD_REVIEW' };
    });
}

function lineOf(r) {
  return [r.modId, r.name, r.ver, r.note, r.fileId, r.action].join('\t');
}

function txOf(row) {
  const m = String(row.note || '').match(/(?:^|;\s*)tx=([^;\s]+)/);
  return m ? m[1] : `${row.modId}:${row.fileId}`;
}

function priority(row, tx) {
  const own = `${row.modId}:${row.fileId}`;
  if (own === tx) return 0;
  if (/closure:PATCH/i.test(row.note || '')) return 1;
  if (/closure:TRANSLATION/i.test(row.note || '')) return 2;
  return 3;
}

function loadState(file) {
  if (!file || !fs.existsSync(file)) return { version: 5, items: {}, transactions: {} };
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    x.version = 5; x.items ||= {}; x.transactions ||= {}; return x;
  } catch { return { version: 5, items: {}, transactions: {} }; }
}

function saveState(file, state) {
  state.version = 5;
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function runNode(args) {
  const r = cp.spawnSync(process.execPath, args, {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: sanitizeString(String(r.stdout || '')),
    stderr: sanitizeString(String(r.stderr || '')),
  };
}

// Compatibility helper retained for tests/agents; v4.1.11 executor no longer spawns
// a new direct-download process per item.
function buildDirectDownloadArgs({ directScript, manifest, downloads, apiKeyFile, sevenzip, timeoutSec }) {
  const args = [directScript, manifest, '--downloads', downloads, '--api-key-file', apiKeyFile, '--timeout-sec', String(timeoutSec)];
  if (sevenzip) args.push('--sevenzip', sevenzip);
  return args;
}

function verifyOne({ autodl, manifest, downloads, sevenzip }) {
  const args = [autodl, 'verify', manifest, '--downloads', downloads, '--json'];
  if (sevenzip) args.push('--sevenzip', sevenzip);
  const r = runNode(args);
  if (!r.ok) return { ok: false, result: { status: 'VERIFY_COMMAND_FAILED', stderr: r.stderr.slice(-800) } };
  try {
    const doc = JSON.parse(r.stdout);
    const item = Array.isArray(doc) ? doc[0] : doc;
    return { ok: item?.status === 'VERIFIED', result: item || { status: 'VERIFY_OUTPUT_EMPTY' } };
  } catch {
    return { ok: false, result: { status: 'VERIFY_OUTPUT_INVALID', sample: r.stdout.slice(0, 500) } };
  }
}

function fastVerifyPublished(row, downloads, directResult) {
  const disk = scanExactDownload(downloads, row.modId, row.fileId);
  const archive = path.basename(disk.primary?.archivePath || '');
  const sameArchive = !directResult?.archive || archive === directResult.archive;
  const ok = directResult?.archiveValidated === true && disk.status === 'COMPLETE' && sameArchive;
  return {
    ok,
    result: {
      status: ok ? 'VERIFIED' : 'FAST_VERIFY_FAILED',
      modId: String(row.modId),
      fileId: String(row.fileId),
      archive,
      archiveIntegrity: directResult?.archiveValidated ? 'PREPUBLISH_7Z_OK' : 'UNKNOWN',
      diskStatus: disk.status,
    },
  };
}

function extractErrorCode(result) {
  if (result?.code) return String(result.code).toUpperCase();
  const text = `${result?.stderr || ''}\n${result?.stdout || ''}\n${result?.message || ''}`;
  const m = text.match(/DIRECT_DOWNLOAD_FAILED\s+([A-Z0-9_]+)/i);
  return m ? m[1].toUpperCase() : (classifyFailure(text).code || 'DIRECT_DOWNLOAD_FAILED');
}

function buildLocalIndex(installedDir) {
  const map = new Map();
  if (!installedDir || !fs.existsSync(installedDir)) return map;
  for (const mod of scanModsDirectory(installedDir)) {
    const key = String(mod.modId || '');
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mod);
  }
  return map;
}

function localExecutionGuard(row, localIndex) {
  const local = localIndex.get(String(row.modId)) || [];
  if (!local.length) return { decision: 'ALLOW', reason: 'LOCAL_MOD_NOT_FOUND_AT_EXECUTION' };

  const exactInstalled = local.some(m => (m.installedFiles || []).map(String).includes(String(row.fileId)));
  if (exactInstalled) {
    return { decision: 'SKIP', reason: 'EXACT_TARGET_ALREADY_INSTALLED', localVersions: local.map(m => m.version || '') };
  }

  const versions = [...new Set(local.map(m => m.version || '').filter(validVersion))];
  if (!validVersion(row.ver) || !versions.length) return { decision: 'ALLOW', reason: 'LOCAL_VERSION_NOT_COMPARABLE', localVersions: versions };
  if (versions.length > 1) {
    return { decision: 'HOLD', reason: 'LOCAL_MULTI_VERSION_IDENTITY', localVersions: versions, targetVersion: row.ver };
  }

  const cmp = compareVersions(versions[0], row.ver);
  if (cmp === 0) {
    return {
      decision: 'HOLD',
      reason: 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT',
      localVersions: versions,
      targetVersion: row.ver,
      targetFileId: String(row.fileId),
    };
  }
  if (cmp > 0) {
    return {
      decision: 'HOLD',
      reason: 'LOCAL_VERSION_NEWER_THAN_TARGET',
      localVersions: versions,
      targetVersion: row.ver,
      targetFileId: String(row.fileId),
    };
  }
  return { decision: 'ALLOW', reason: 'LOCAL_VERSION_OLDER_THAN_TARGET', localVersions: versions, targetVersion: row.ver };
}

function addTiming(total, one = {}) {
  for (const [k, v] of Object.entries(one || {})) {
    if (!Number.isFinite(Number(v))) continue;
    total[k] = (total[k] || 0) + Number(v);
  }
}

async function runLocked(config) {
  const {
    manifest, downloads, installedDir, apiKeyFile, stateFile, runDir, sevenzip,
    timeoutSec, maxSubmitAttempts, continueOnError, debug, ledgerFile,
  } = config;
  const logger = createLogger(runDir, { debug, runId: path.basename(runDir) });
  const autodl = path.join(__dirname, 'nexus-autodl.js');
  const rows = parseManifest(manifest).filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const groups = new Map();
  for (const row of rows) {
    const tx = txOf(row);
    if (!groups.has(tx)) groups.set(tx, []);
    groups.get(tx).push(row);
  }
  for (const [tx, list] of groups) list.sort((a, b) => priority(a, tx) - priority(b, tx));

  const state = loadState(stateFile);
  const ledger = loadLedger(ledgerFile);
  const localIndex = buildLocalIndex(installedDir);
  state.manifest = path.resolve(manifest);
  state.transport = 'DIRECT_NEXUS_CDN_SHARED_SESSION';
  state.startedAt ||= new Date().toISOString();
  let requested = 0, published = 0, verified = 0, failed = 0, skipped = 0, heldLocalIdentity = 0;
  const timingTotals = {};
  const timingItems = [];
  let directSession = null;

  logger.info('EXECUTOR', 'shared-session direct transaction executor started', {
    transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION', transactions: groups.size, items: rows.length,
  });

  try {
    for (const [tx, list] of groups) {
      state.transactions[tx] = state.transactions[tx] || { status: 'RUNNING', items: [] };
      state.transactions[tx].status = 'RUNNING';
      let txFailed = false;

      for (const row of list) {
        const key = `${row.modId}:${row.fileId}`;
        const ctx = { tx, modId: row.modId, fileId: row.fileId };
        if (!state.transactions[tx].items.includes(key)) state.transactions[tx].items.push(key);

        if (state.items[key]?.status === 'VERIFIED') {
          skipped++;
          logger.info('EXECUTOR', 'already VERIFIED in run state', { ...ctx, status: 'VERIFIED' });
          continue;
        }
        if (txFailed) {
          state.items[key] = { ...row, tx, status: 'BLOCKED_BY_TX_FAILURE', updatedAt: new Date().toISOString() };
          saveState(stateFile, state);
          continue;
        }

        const localGuard = localExecutionGuard(row, localIndex);
        if (localGuard.decision === 'SKIP') {
          skipped++;
          state.items[key] = { ...row, tx, status: 'SKIP_ALREADY_INSTALLED_EXACT', localExecutionGuard: localGuard, updatedAt: new Date().toISOString() };
          logger.info('ELIGIBILITY', 'target exact file is already installed; skip network download', { ...ctx, reason: localGuard.reason });
          saveState(stateFile, state);
          continue;
        }
        if (localGuard.decision === 'HOLD') {
          heldLocalIdentity++;
          failed++;
          txFailed = true;
          state.items[key] = {
            ...row, tx, status: 'HOLD_LOCAL_IDENTITY_CONFLICT',
            localExecutionGuard: localGuard,
            error: classifyFailure('HOLD_LOCAL_IDENTITY_CONFLICT'),
            updatedAt: new Date().toISOString(),
          };
          logger.error('ELIGIBILITY', 'local installed version contradicts planned target; refuse automatic download', {
            ...ctx, reason: localGuard.reason, localVersions: localGuard.localVersions, targetVersion: row.ver,
          });
          saveState(stateFile, state);
          if (!continueOnError) break;
          continue;
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-direct-tx-'));
        const one = path.join(tmpDir, 'one.tsv');
        fs.writeFileSync(one, lineOf({ ...row, action: 'DOWNLOAD' }) + '\n', 'utf8');
        state.items[key] = {
          ...(state.items[key] || {}), ...row, tx,
          transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION', attempts: [],
          localExecutionGuard: localGuard, updatedAt: new Date().toISOString(),
        };

        try {
          let disk = scanExactDownload(downloads, row.modId, row.fileId);
          if (disk.status === 'INFLIGHT') {
            const error = classifyFailure('EXACT_INFLIGHT_EXISTS');
            state.items[key].status = 'HOLD_EXISTING_INFLIGHT';
            state.items[key].error = error;
            failed++; txFailed = true; saveState(stateFile, state);
            logger.error('DOWNLOAD', 'exact unfinished record exists; direct transport will not overwrite it', { ...ctx, status: disk.status });
            if (!continueOnError) break;
            continue;
          }

          let directResult = null;
          if (disk.status !== 'COMPLETE') {
            let success = false;
            if (!directSession) directSession = await createDirectSession({ apiKeyFile });
            for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
              requested++;
              state.items[key].status = 'DIRECT_DOWNLOADING';
              state.items[key].attempt = attempt;
              patchLedgerEntry(ledger, row.modId, row.fileId, {
                status: 'SUBMITTING', transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION', runDir, tx,
                name: row.name, version: row.ver, attemptStartedAt: new Date().toISOString(),
              });
              saveLedger(ledgerFile, ledger); saveState(stateFile, state);
              logger.info('DOWNLOAD', 'fetching exact file via shared direct Nexus session', { ...ctx, attempt });

              try {
                directResult = await runDirectTarget({ row, downloads, sevenzip, timeoutSec, session: directSession });
                state.items[key].attempts.push({
                  attempt, ok: true, status: directResult.status, timings: directResult.timings || {}, at: new Date().toISOString(),
                });
                disk = scanExactDownload(downloads, row.modId, row.fileId);
                if (directResult.ok && disk.status === 'COMPLETE') {
                  success = true;
                  if (directResult.status !== 'ALREADY_PRESENT') published++;
                  state.items[key].status = directResult.status === 'ALREADY_PRESENT' ? 'ALREADY_PRESENT' : 'PUBLISHED';
                  state.items[key].timings = directResult.timings || {};
                  addTiming(timingTotals, directResult.timings || {});
                  timingItems.push({ modId: row.modId, fileId: row.fileId, name: row.name, ...(directResult.timings || {}) });
                  patchLedgerEntry(ledger, row.modId, row.fileId, {
                    status: 'SUBMITTED', transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION', submittedAt: new Date().toISOString(), runDir, tx,
                    name: row.name, version: row.ver,
                  });
                  saveLedger(ledgerFile, ledger); saveState(stateFile, state);
                  break;
                }
              } catch (err) {
                const code = extractErrorCode(err);
                state.items[key].attempts.push({ attempt, ok: false, errorCode: code, at: new Date().toISOString() });
                state.items[key].error = classifyFailure(code);
                disk = scanExactDownload(downloads, row.modId, row.fileId);
                logger.error('DOWNLOAD', 'shared direct exact download attempt failed', { ...ctx, attempt, errorCode: code, diskStatus: disk.status });
                if (disk.status === 'COMPLETE') { success = true; break; }
                if (disk.status === 'INFLIGHT' || attempt >= maxSubmitAttempts) break;
              }
            }
            if (!success) {
              state.items[key].status = disk.status === 'INFLIGHT' ? 'HOLD_EXISTING_INFLIGHT' : 'DIRECT_DOWNLOAD_FAILED';
              failed++; txFailed = true; saveState(stateFile, state);
              if (!continueOnError) break;
              continue;
            }
          } else {
            skipped++;
            state.items[key].status = 'ALREADY_PRESENT';
            logger.info('IDEMPOTENCY', 'exact archive already present; skip network download', { ...ctx, status: 'COMPLETE' });
          }

          // Newly published files were already byte-checked, 7-Zip-tested and atomically moved.
          // Existing files still use the independent legacy verifier.
          const vr = directResult?.archiveValidated
            ? fastVerifyPublished(row, downloads, directResult)
            : verifyOne({ autodl, manifest: one, downloads, sevenzip });
          state.items[key].verify = vr.result;
          state.items[key].status = vr.ok ? 'VERIFIED' : 'VERIFY_FAILED';
          state.items[key].updatedAt = new Date().toISOString();
          if (vr.ok) {
            verified++;
            patchLedgerEntry(ledger, row.modId, row.fileId, {
              status: 'VERIFIED', transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION', verifiedAt: new Date().toISOString(), runDir, tx,
              name: row.name, version: row.ver,
            });
            saveLedger(ledgerFile, ledger);
            logger.info('VERIFY', 'exact archive VERIFIED', { ...ctx, status: 'VERIFIED', fastPath: !!directResult?.archiveValidated });
          } else {
            failed++; txFailed = true;
            state.items[key].error = classifyFailure(vr.result?.status || 'VERIFY_FAILED');
            logger.error('VERIFY', 'archive failed final verification', { ...ctx, status: vr.result?.status || 'UNKNOWN' });
          }
          saveState(stateFile, state);
          if (txFailed && !continueOnError) break;
        } finally {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        }
      }

      state.transactions[tx].status = txFailed ? 'FAILED' : 'VERIFIED';
      state.transactions[tx].updatedAt = new Date().toISOString();
      saveState(stateFile, state);
    }
  } finally {
    await closeDirectSession(directSession);
  }

  const failedItems = Object.entries(state.items)
    .filter(([, v]) => /FAILED|HOLD|BLOCKED/.test(v.status || ''))
    .map(([key, v]) => ({ key, tx: v.tx, modId: v.modId, fileId: v.fileId, name: v.name, status: v.status, error: v.error || null, localExecutionGuard: v.localExecutionGuard || null }));
  const failedItemsFile = logger.writeDiagnostic('failed-items.json', { generatedAt: new Date().toISOString(), failedItems });
  const timedCount = timingItems.length;
  const timingAverageMs = Object.fromEntries(Object.entries(timingTotals).map(([k, v]) => [k, timedCount ? Math.round(v / timedCount) : 0]));
  const timingFile = logger.writeDiagnostic('download-timings.json', {
    generatedAt: new Date().toISOString(), count: timedCount, averageMs: timingAverageMs, items: timingItems,
  });
  const payload = {
    transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION', stateFile, runDir, ledgerFile, failedItemsFile, timingFile,
    transactions: groups.size, items: rows.length, requested, published, verified, skipped, heldLocalIdentity, failed,
    timingAverageMs,
  };
  logger.info('EXECUTOR', 'shared-session direct executor finished', payload);
  console.log(JSON.stringify(payload, null, 2));
  if (failed) process.exitCode = 1;
}

async function main() {
  const manifest = process.argv[2];
  if (!manifest) throw new Error('用法: node execute-plan.js <run.tsv> --downloads DIR --installed-dir DIR --api-key-file FILE --state state.json [--run-dir DIR]');
  const downloads = argValue('--downloads');
  const installedDir = argValue('--installed-dir');
  const apiKeyFile = argValue('--api-key-file');
  const stateFile = argValue('--state', path.resolve(process.cwd(), 'execution-state.json'));
  const runDir = argValue('--run-dir', path.dirname(stateFile));
  const sevenzip = argValue('--sevenzip');
  const timeoutSec = Math.max(30, Number(argValue('--timeout-sec', '1200')) || 1200);
  const maxSubmitAttempts = Math.max(1, Number(argValue('--max-submit-attempts', '2')) || 2);
  const continueOnError = process.argv.includes('--continue-on-error');
  const debug = process.argv.includes('--debug');
  const sharedStateDir = argValue('--shared-state-dir', path.resolve(__dirname, '..', '.runtime', 'state'));
  const ledgerFile = argValue('--ledger', path.join(sharedStateDir, 'submission-ledger.json'));
  const lockFile = argValue('--lock-file', path.join(sharedStateDir, 'download-executor.lock'));
  if (!downloads) throw new Error('缺少 --downloads');
  if (!installedDir) throw new Error('缺少 --installed-dir');
  if (!apiKeyFile) throw new Error('缺少 --api-key-file');

  const lock = acquireExecutorLock(lockFile, {
    runDir: path.resolve(runDir), manifest: path.resolve(manifest), transport: 'DIRECT_NEXUS_CDN_SHARED_SESSION',
  });
  if (!lock.ok) {
    const o = lock.owner || {};
    throw new Error(`CONCURRENT_EXECUTOR: another executor is active pid=${o.pid || 'unknown'} runDir=${o.runDir || 'unknown'}`);
  }
  try {
    await runLocked({
      manifest, downloads, installedDir, apiKeyFile, stateFile, runDir, sevenzip,
      timeoutSec, maxSubmitAttempts, continueOnError, debug, ledgerFile,
    });
  } finally {
    releaseExecutorLock(lock);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`EXECUTOR_FAILED ${err.code || ''} ${String(err.message || err)}`);
    process.exit(1);
  });
}

module.exports = {
  buildDirectDownloadArgs,
  verifyOne,
  fastVerifyPublished,
  extractErrorCode,
  buildLocalIndex,
  localExecutionGuard,
  txOf,
  priority,
};
