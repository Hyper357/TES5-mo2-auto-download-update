#!/usr/bin/env node
'use strict';

// v3.4 精确执行器：单执行器锁 + 跨运行提交账本 + Downloads 在途检测 + VERIFIED。
// 核心原则：同一个 modId:fileId 一旦可能已经交给 MO2，就优先等待/核验，绝不盲目再次提交。

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
  shouldSuppressResubmit,
  acquireExecutorLock,
  releaseExecutorLock,
} = require('./lib/download-guard');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
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
  if (!file || !fs.existsSync(file)) return { version: 3, items: {}, transactions: {} };
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.version = 3;
    state.items ||= {};
    state.transactions ||= {};
    return state;
  } catch { return { version: 3, items: {}, transactions: {} }; }
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyVerify(result) {
  const s = result?.status || 'UNKNOWN';
  if (s === 'VERIFIED') return { state: 'VERIFIED', error: null };
  if (['MISSING_META', 'INCOMPLETE', 'MISSING_ARCHIVE', 'VERIFIED_WITH_RESIDUAL'].includes(s)) {
    return { state: 'PENDING', error: classifyFailure(s) };
  }
  if (/SEVENZIP_NOT_FOUND/.test(s)) return { state: 'FATAL_ENV', error: classifyFailure(s) };
  if (/FILE.*MISMATCH|META.*MISMATCH|VERSION.*MISMATCH|ARCHIVE_TEST_FAILED/.test(s)) {
    return { state: 'FATAL_FILE', error: classifyFailure(s) };
  }
  return { state: 'PENDING', error: classifyFailure(s) };
}

async function verifyUntil({ tempManifest, autodl, downloads, sevenzip, timeoutSec, pollSec, logger, context }) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    const args = [autodl, 'verify', tempManifest, '--downloads', downloads, '--json'];
    if (sevenzip) args.push('--sevenzip', sevenzip);
    const r = runNode(args);
    if (r.ok) {
      try {
        const parsed = JSON.parse(r.stdout);
        last = Array.isArray(parsed) ? parsed[0] : parsed;
        const cls = classifyVerify(last);
        logger.debug('VERIFY', `poll=${polls} status=${last?.status || 'UNKNOWN'}`, { ...context, status: last?.status, polls });
        if (cls.state === 'VERIFIED') return { ok: true, result: last, polls };
        if (cls.state.startsWith('FATAL_')) return { ok: false, fatal: true, result: last, error: cls.error, polls };
      } catch (_) {
        last = { status: 'VERIFY_OUTPUT_INVALID', sample: r.stdout.slice(0, 500) };
      }
    } else {
      last = { status: 'VERIFY_COMMAND_FAILED', stderr: r.stderr.slice(0, 500) };
    }
    await sleep(Math.max(1, pollSec) * 1000);
  }
  return { ok: false, fatal: false, timeout: true, result: last, error: classifyFailure('VERIFY_TIMEOUT'), polls };
}

async function captureBrowserSnapshot({ logger, modId, fileId, errorCode }) {
  if (!['BROWSER', 'NXM'].includes(classifyFailure(errorCode).layer) && !/CDP|DOM|NXM|LOGIN/.test(errorCode)) return null;
  try {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    const pages = await browser.pages();
    const page = pages.find(p => String(p.url()).includes(`/mods/${modId}`)) || pages.find(p => /nexusmods\.com/i.test(p.url()));
    if (!page) {
      await browser.disconnect();
      return logger.writeDiagnostic(`${modId}-${fileId}-${errorCode}-browser`, { errorCode, connected: true, nexusPageFound: false, pageCount: pages.length });
    }
    const meta = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const ids = [...document.querySelectorAll('[data-file-id]')].map(el => el.getAttribute('data-file-id')).filter(Boolean).slice(0, 100);
      return {
        title: document.title,
        loginLike: /sign in|log in|登录/i.test(text.slice(0, 20000)),
        cloudflareLike: /cloudflare|checking your browser|verify you are human/i.test(text.slice(0, 20000)),
        fileIds: [...new Set(ids)],
        bodyTextSample: text.slice(0, 1500),
      };
    });
    const url = sanitizeString(page.url());
    const screenshot = path.join(logger.screenshotsDir, `${modId}-${fileId}-${errorCode}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    const diag = logger.writeDiagnostic(`${modId}-${fileId}-${errorCode}-browser`, { errorCode, url, ...meta, screenshot });
    await browser.disconnect();
    return diag;
  } catch (err) {
    return logger.writeDiagnostic(`${modId}-${fileId}-${errorCode}-browser-capture-failed`, { errorCode, captureError: err.message });
  }
}

function submitFailureText(result) {
  return `${result.stderr || ''}\n${result.stdout || ''}`;
}

function submitLooksFailed(result) {
  return !result.ok || /\b(ERROR|VERIFY-FAIL|VARIANT-MISMATCH|NOT-FOUND|NO-NXM-EXTRACTED|MISMATCH|FAILED)\b/i.test(submitFailureText(result));
}

const SAFE_PRE_SUBMIT_RETRY = new Set([
  'NEXUS_API_429',
  'NEXUS_API_TIMEOUT',
  'CDP_UNAVAILABLE',
  'NXM_EXTRACT_FAILED',
  'NXM_EXPIRED',
]);

function compactDiskState(s) {
  if (!s) return null;
  return {
    status: s.status,
    reason: s.reason || null,
    records: (s.records || []).map(r => ({
      fileName: r.fileName,
      unfinishedMeta: r.unfinishedMeta,
      archiveExists: r.archiveExists,
      archiveSize: r.archiveSize,
      unfinishedExists: r.unfinishedExists,
      unfinishedSize: r.unfinishedSize,
      mtimeMs: r.mtimeMs,
    })),
  };
}

async function runLocked(config) {
  const {
    manifest, downloads, installedDir, apiKeyFile, stateFile, runDir, sevenzip,
    timeoutSec, pollSec, maxSubmitAttempts, retryDelaySec, continueOnError,
    reconnect, debug, ledgerFile, submissionTtlMs, forceResubmit,
  } = config;

  const autodl = path.join(__dirname, 'nexus-autodl.js');
  const logger = createLogger(runDir, { debug, runId: path.basename(runDir) });
  const rawRows = parseManifest(manifest).filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  const groups = new Map();
  for (const row of rawRows) {
    const tx = txOf(row);
    if (!groups.has(tx)) groups.set(tx, []);
    groups.get(tx).push(row);
  }
  for (const [tx, list] of groups) list.sort((a, b) => priority(a, tx) - priority(b, tx));

  const duplicateKeys = rawRows.reduce((acc, r) => {
    const k = `${r.modId}:${r.fileId}`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const duplicates = Object.entries(duplicateKeys).filter(([, n]) => n > 1).map(([key, count]) => ({ key, count }));
  if (duplicates.length) logger.warn('IDEMPOTENCY', 'manifest contains repeated exact targets; executor will serialize and suppress re-submit', { duplicates });

  const state = loadState(stateFile);
  const ledger = loadLedger(ledgerFile);
  state.manifest = path.resolve(manifest);
  state.startedAt = state.startedAt || new Date().toISOString();
  state.diagnostics = { runDir, logs: logger.files, ledgerFile };
  let failed = 0;
  let verified = 0;
  let skipped = 0;
  let suppressed = 0;

  const saveLedgerNow = () => saveLedger(ledgerFile, ledger);
  logger.info('EXECUTOR', 'transaction executor started', {
    transactions: groups.size, items: rawRows.length, maxSubmitAttempts,
    ledgerFile, submissionTtlMinutes: Math.round(submissionTtlMs / 60000), forceResubmit,
  });

  for (const [tx, list] of groups) {
    state.transactions[tx] = state.transactions[tx] || { status: 'RUNNING', items: [] };
    state.transactions[tx].status = 'RUNNING';
    let txFailed = false;
    logger.info('TX', 'transaction started', { tx, items: list.length });

    for (const row of list) {
      const itemKey = `${row.modId}:${row.fileId}`;
      const context = { tx, modId: row.modId, fileId: row.fileId };

      if (state.items[itemKey]?.status === 'VERIFIED') {
        skipped++;
        if (!state.transactions[tx].items.includes(itemKey)) state.transactions[tx].items.push(itemKey);
        logger.info('EXECUTOR', 'already VERIFIED in this run; skip resubmit', { ...context, status: 'VERIFIED' });
        continue;
      }
      if (txFailed) {
        state.items[itemKey] = { ...row, tx, status: 'BLOCKED_BY_TX_FAILURE', updatedAt: new Date().toISOString() };
        saveState(stateFile, state);
        logger.warn('TX', 'item blocked by previous transaction failure', { ...context, status: 'BLOCKED_BY_TX_FAILURE' });
        continue;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-mo2-tx-'));
      const one = path.join(tmpDir, 'one.tsv');
      fs.writeFileSync(one, lineOf(row) + '\n', 'utf8');

      const previous = state.items[itemKey] || {};
      state.items[itemKey] = {
        ...previous, ...row, tx,
        attempts: Array.isArray(previous.attempts) ? previous.attempts : [],
        updatedAt: new Date().toISOString(),
      };
      if (!state.transactions[tx].items.includes(itemKey)) state.transactions[tx].items.push(itemKey);

      let diskState = scanExactDownload(downloads, row.modId, row.fileId);
      const ledgerEntry = ledger.items[itemKey] || null;
      const ledgerGuard = shouldSuppressResubmit(ledgerEntry, submissionTtlMs);
      const diskSuppress = diskState.status === 'COMPLETE' || diskState.status === 'INFLIGHT';
      const ledgerSuppress = ledgerGuard.suppress && !forceResubmit;

      if (ledgerSuppress && ledgerGuard.reason === 'LEDGER_VERIFIED' && diskState.status === 'ABSENT') {
        const err = classifyFailure('LEDGER_VERIFIED_MISSING');
        state.items[itemKey].status = 'HOLD_VERIFIED_MISSING';
        state.items[itemKey].error = err;
        state.items[itemKey].guard = { disk: compactDiskState(diskState), ledger: ledgerEntry, ledgerGuard };
        state.items[itemKey].updatedAt = new Date().toISOString();
        saveState(stateFile, state);
        logger.error('IDEMPOTENCY', 'ledger says VERIFIED but archive evidence is absent; refuse automatic re-download', {
          ...context, status: 'HOLD_VERIFIED_MISSING', errorCode: err.code, action: err.action,
        });
        failed++;
        txFailed = true;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        if (!continueOnError) break;
        continue;
      }

      let submissionSuppressed = false;
      if ((diskSuppress || ledgerSuppress) && !forceResubmit) {
        submissionSuppressed = true;
        suppressed++;
        const reason = diskSuppress ? `DISK_${diskState.status}` : ledgerGuard.reason;
        state.items[itemKey].status = diskState.status === 'COMPLETE' ? 'ALREADY_PRESENT' : 'WAITING_EXISTING';
        state.items[itemKey].guard = { reason, disk: compactDiskState(diskState), ledger: ledgerEntry, ledgerGuard };
        patchLedgerEntry(ledger, row.modId, row.fileId, {
          status: ledgerEntry?.status === 'VERIFIED' ? 'VERIFIED' : 'WAITING_EXISTING',
          lastSeenReason: reason,
          runDir,
          tx,
          name: row.name,
          version: row.ver,
          submittedAt: ledgerEntry?.submittedAt || ledgerEntry?.updatedAt || new Date().toISOString(),
        });
        saveLedgerNow();
        saveState(stateFile, state);
        logger.info('IDEMPOTENCY', 'duplicate submission suppressed; wait for existing MO2/download evidence instead', {
          ...context, status: state.items[itemKey].status, reason,
        });
      }

      let submitted = submissionSuppressed ? { ok: true, status: 0, stdout: 'SUBMISSION_SUPPRESSED', stderr: '' } : null;
      let submitError = null;

      if (!submissionSuppressed) {
        for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
          diskState = scanExactDownload(downloads, row.modId, row.fileId);
          if (diskState.status !== 'ABSENT' && !forceResubmit) {
            suppressed++;
            submissionSuppressed = true;
            submitted = { ok: true, status: 0, stdout: 'SUBMISSION_SUPPRESSED_DISK_APPEARED', stderr: '' };
            state.items[itemKey].status = 'WAITING_EXISTING';
            state.items[itemKey].guard = { reason: `DISK_${diskState.status}_BEFORE_ATTEMPT`, disk: compactDiskState(diskState) };
            patchLedgerEntry(ledger, row.modId, row.fileId, {
              status: 'WAITING_EXISTING', lastSeenReason: `DISK_${diskState.status}_BEFORE_ATTEMPT`, runDir, tx,
              name: row.name, version: row.ver,
            });
            saveLedgerNow();
            logger.info('IDEMPOTENCY', 'target appeared in Downloads before submit attempt; suppress NXM handoff', {
              ...context, attempt, status: diskState.status,
            });
            break;
          }

          patchLedgerEntry(ledger, row.modId, row.fileId, {
            status: 'SUBMITTING', attemptStartedAt: new Date().toISOString(), runDir, tx,
            name: row.name, version: row.ver,
          });
          saveLedgerNow();
          state.items[itemKey].status = 'SUBMITTING';
          saveState(stateFile, state);

          logger.info('DOWNLOAD', 'submitting exact modId+fileId', { ...context, attempt, status: 'SUBMITTING' });
          const dlArgs = [
            autodl, 'dl', one, '--go', '--limit', '1', '--wait', '0',
            '--downloads', downloads, '--installed-dir', installedDir,
            '--api-key-file', apiKeyFile,
          ];
          if (reconnect) dlArgs.push('--reconnect');
          if (sevenzip) dlArgs.push('--sevenzip', sevenzip);

          submitted = runNode(dlArgs);
          const failedSubmit = submitLooksFailed(submitted);
          submitError = failedSubmit ? classifyFailure(submitFailureText(submitted)) : null;
          const attemptRec = {
            attempt, ok: !failedSubmit, processOk: submitted.ok, status: submitted.status,
            error: submitError,
            stdout: submitted.stdout.slice(-2500), stderr: submitted.stderr.slice(-2500),
            at: new Date().toISOString(),
          };
          state.items[itemKey].attempts.push(attemptRec);
          state.items[itemKey].submit = attemptRec;
          saveState(stateFile, state);

          if (!failedSubmit) {
            patchLedgerEntry(ledger, row.modId, row.fileId, {
              status: 'SUBMITTED', submittedAt: new Date().toISOString(), runDir, tx,
              name: row.name, version: row.ver, attempt,
            });
            saveLedgerNow();
            logger.info('DOWNLOAD', 'submission accepted', { ...context, attempt, status: 'SUBMITTED' });
            break;
          }

          logger.error('DOWNLOAD', 'submission failed', {
            ...context, attempt, status: 'SUBMIT_FAILED', errorCode: submitError.code,
            layer: submitError.layer, retryable: submitError.retry, action: submitError.action,
          });
          await captureBrowserSnapshot({ logger, modId: row.modId, fileId: row.fileId, errorCode: submitError.code });

          if (!submitError.retry || attempt >= maxSubmitAttempts) {
            patchLedgerEntry(ledger, row.modId, row.fileId, {
              status: 'SUBMIT_FAILED', lastError: submitError, runDir, tx, name: row.name, version: row.ver,
            });
            saveLedgerNow();
            break;
          }

          logger.warn('RECOVERY', `before retry, wait ${retryDelaySec}s and re-check Downloads to avoid duplicate NXM`, {
            ...context, attempt, errorCode: submitError.code,
          });
          await sleep(retryDelaySec * 1000);
          const afterFailure = scanExactDownload(downloads, row.modId, row.fileId);
          if (afterFailure.status !== 'ABSENT') {
            suppressed++;
            submissionSuppressed = true;
            submitted = { ok: true, status: 0, stdout: 'POSSIBLY_SUBMITTED_DISK_APPEARED', stderr: '' };
            patchLedgerEntry(ledger, row.modId, row.fileId, {
              status: 'POSSIBLY_SUBMITTED', submittedAt: new Date().toISOString(), runDir, tx,
              name: row.name, version: row.ver, lastSeenReason: `DISK_${afterFailure.status}_AFTER_FAILED_ATTEMPT`,
            });
            saveLedgerNow();
            state.items[itemKey].guard = { reason: 'DISK_APPEARED_AFTER_FAILED_ATTEMPT', disk: compactDiskState(afterFailure) };
            logger.warn('IDEMPOTENCY', 'failed command may already have reached MO2; disk evidence appeared, so retry is suppressed', {
              ...context, attempt, status: afterFailure.status,
            });
            break;
          }

          if (!SAFE_PRE_SUBMIT_RETRY.has(submitError.code)) {
            submissionSuppressed = true;
            submitted = { ok: true, status: 0, stdout: 'POSSIBLY_SUBMITTED_UNCERTAIN_FAILURE', stderr: '' };
            patchLedgerEntry(ledger, row.modId, row.fileId, {
              status: 'POSSIBLY_SUBMITTED', submittedAt: new Date().toISOString(), runDir, tx,
              name: row.name, version: row.ver, lastError: submitError,
            });
            saveLedgerNow();
            logger.warn('IDEMPOTENCY', 'retryable error occurred after an uncertain submit boundary; do not re-submit automatically', {
              ...context, attempt, errorCode: submitError.code,
            });
            break;
          }

          logger.warn('RECOVERY', 'safe pre-submit failure; exact retry allowed', { ...context, attempt, errorCode: submitError.code });
        }
      }

      if (!submitted || submitLooksFailed(submitted)) {
        state.items[itemKey].status = 'SUBMIT_FAILED';
        state.items[itemKey].error = submitError || classifyFailure('UNKNOWN_FAILURE');
        state.items[itemKey].updatedAt = new Date().toISOString();
        txFailed = true;
        failed++;
        saveState(stateFile, state);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        if (!continueOnError) break;
        continue;
      }

      state.items[itemKey].status = submissionSuppressed ? 'WAITING_EXISTING' : 'SUBMITTED';
      saveState(stateFile, state);

      const vr = await verifyUntil({ tempManifest: one, autodl, downloads, sevenzip, timeoutSec, pollSec, logger, context });
      state.items[itemKey].verify = vr.result || null;
      state.items[itemKey].verifyPolls = vr.polls || 0;
      state.items[itemKey].status = vr.ok ? 'VERIFIED' : (vr.timeout ? 'VERIFY_TIMEOUT' : 'VERIFY_FAILED');
      state.items[itemKey].error = vr.ok ? null : (vr.error || classifyFailure(JSON.stringify(vr.result || {})));
      state.items[itemKey].updatedAt = new Date().toISOString();
      saveState(stateFile, state);

      if (vr.ok) {
        patchLedgerEntry(ledger, row.modId, row.fileId, {
          status: 'VERIFIED', verifiedAt: new Date().toISOString(), runDir, tx,
          name: row.name, version: row.ver,
        });
        saveLedgerNow();
        verified++;
        logger.info('VERIFY', 'archive VERIFIED', { ...context, status: 'VERIFIED', polls: vr.polls });
      } else {
        const e = state.items[itemKey].error;
        patchLedgerEntry(ledger, row.modId, row.fileId, {
          status: vr.timeout ? 'VERIFY_TIMEOUT' : 'VERIFY_FAILED',
          lastError: e, runDir, tx, name: row.name, version: row.ver,
          submittedAt: ledger.items[itemKey]?.submittedAt || new Date().toISOString(),
        });
        saveLedgerNow();
        failed++;
        txFailed = true;
        logger.error('VERIFY', vr.timeout ? 'verification timed out; ledger prevents blind re-submit on next run' : 'verification failed', {
          ...context, status: state.items[itemKey].status, errorCode: e.code,
          layer: e.layer, retryable: e.retry, action: e.action, polls: vr.polls,
        });
        if (!continueOnError) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
          break;
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    state.transactions[tx].status = txFailed ? 'FAILED' : 'VERIFIED';
    state.transactions[tx].updatedAt = new Date().toISOString();
    saveState(stateFile, state);
    logger[txFailed ? 'error' : 'info']('TX', txFailed ? 'transaction failed and remaining dependent items are blocked' : 'transaction VERIFIED', { tx, status: state.transactions[tx].status });
  }

  const failedItems = Object.entries(state.items)
    .filter(([, v]) => /FAILED|TIMEOUT|BLOCKED|HOLD/.test(v.status || ''))
    .map(([key, v]) => ({ key, tx: v.tx, modId: v.modId, fileId: v.fileId, name: v.name, status: v.status, error: v.error || null, guard: v.guard || null }));
  const failedItemsFile = logger.writeDiagnostic('failed-items.json', { generatedAt: new Date().toISOString(), failedItems });
  const payload = {
    stateFile, runDir, logs: logger.files, failedItemsFile, ledgerFile,
    transactions: groups.size, items: rawRows.length, verified,
    skippedVerified: skipped, duplicateSubmissionsSuppressed: suppressed, failed,
  };
  logger.info('EXECUTOR', 'executor finished', { verified, failed, skippedVerified: skipped, duplicateSubmissionsSuppressed: suppressed });
  console.log(JSON.stringify(payload, null, 2));
  if (failed) process.exitCode = 1;
}

async function main() {
  const manifest = process.argv[2];
  if (!manifest) {
    console.error('用法: node execute-plan.js <run.tsv> --downloads DIR --installed-dir DIR --api-key-file FILE --state state.json [--run-dir DIR] [--debug]');
    process.exit(2);
  }

  const downloads = argValue('--downloads');
  const installedDir = argValue('--installed-dir');
  const apiKeyFile = argValue('--api-key-file');
  const stateFile = argValue('--state', path.resolve(process.cwd(), 'execution-state.json'));
  const runDir = argValue('--run-dir', path.dirname(stateFile));
  const sevenzip = argValue('--sevenzip');
  const timeoutSec = Number(argValue('--timeout-sec', '1200')) || 1200;
  const pollSec = Number(argValue('--poll-sec', '5')) || 5;
  const maxSubmitAttempts = Math.max(1, Number(argValue('--max-submit-attempts', '2')) || 2);
  const retryDelaySec = Math.max(1, Number(argValue('--retry-delay-sec', '5')) || 5);
  const continueOnError = process.argv.includes('--continue-on-error');
  const reconnect = process.argv.includes('--reconnect');
  const debug = process.argv.includes('--debug');
  const forceResubmit = process.argv.includes('--force-resubmit');
  const sharedStateDir = argValue('--shared-state-dir', path.resolve(__dirname, '..', '.runtime', 'state'));
  const ledgerFile = argValue('--ledger', path.join(sharedStateDir, 'submission-ledger.json'));
  const lockFile = argValue('--lock-file', path.join(sharedStateDir, 'download-executor.lock'));
  const submissionTtlMin = Math.max(5, Number(argValue('--submission-ttl-min', '720')) || 720);
  const submissionTtlMs = submissionTtlMin * 60 * 1000;

  for (const [name, value] of [['downloads', downloads], ['installed-dir', installedDir], ['api-key-file', apiKeyFile]]) {
    if (!value) throw new Error(`缺少 --${name}`);
  }

  const lock = acquireExecutorLock(lockFile, { runDir: path.resolve(runDir), manifest: path.resolve(manifest) });
  if (!lock.ok) {
    const owner = lock.owner || {};
    throw new Error(`CONCURRENT_EXECUTOR: another --go executor is active pid=${owner.pid || 'unknown'} runDir=${owner.runDir || 'unknown'}`);
  }

  try {
    await runLocked({
      manifest, downloads, installedDir, apiKeyFile, stateFile, runDir, sevenzip,
      timeoutSec, pollSec, maxSubmitAttempts, retryDelaySec, continueOnError,
      reconnect, debug, ledgerFile, submissionTtlMs, forceResubmit,
    });
  } finally {
    releaseExecutorLock(lock);
  }
}

main().catch(err => {
  const runDir = argValue('--run-dir', path.dirname(argValue('--state', path.resolve(process.cwd(), 'execution-state.json'))));
  try {
    const logger = createLogger(runDir, { debug: process.argv.includes('--debug'), runId: path.basename(runDir) });
    const e = classifyFailure(err.message);
    logger.error('EXECUTOR', 'execute-plan crashed', { errorCode: e.code, layer: e.layer, action: e.action, error: err.message });
  } catch (_) {}
  console.error(`execute-plan failed: ${sanitizeString(err.message)}`);
  process.exit(1);
});
