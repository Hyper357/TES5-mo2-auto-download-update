'use strict';

const fs = require('fs');
const path = require('path');

function failedAttemptCode(item) {
  const attempts = Array.isArray(item?.attempts) ? item.attempts : [];
  const hit = [...attempts].reverse().find(x => x && x.ok === false && x.errorCode);
  return hit ? String(hit.errorCode) : '';
}

function failureCode(item) {
  return failedAttemptCode(item)
    || String(item?.localExecutionGuard?.reason || '')
    || String(item?.verify?.status || '')
    || String(item?.error?.code || '')
    || String(item?.status || 'UNKNOWN_FAILURE');
}

function compactAttempts(item) {
  return (Array.isArray(item?.attempts) ? item.attempts : []).map(x => ({
    attempt: Number(x?.attempt || 0) || null,
    ok: x?.ok === true,
    errorCode: x?.errorCode ? String(x.errorCode) : '',
    status: x?.status ? String(x.status) : '',
  }));
}

function failureEntry(key, item) {
  const local = item?.localExecutionGuard || {};
  return {
    exact: item?.modId && item?.fileId ? `${item.modId}:${item.fileId}` : String(key),
    modId: String(item?.modId || ''),
    fileId: String(item?.fileId || ''),
    name: String(item?.name || ''),
    version: String(item?.ver || item?.version || ''),
    status: String(item?.status || ''),
    errorCode: failureCode(item),
    tx: String(item?.tx || ''),
    workerId: item?.workerId ?? null,
    updatedAt: String(item?.updatedAt || ''),
    attempts: compactAttempts(item),
    localIdentity: local && Object.keys(local).length ? {
      reason: String(local.reason || ''),
      localVersions: Array.isArray(local.localVersions) ? local.localVersions.map(String) : [],
      targetVersion: String(local.targetVersion || ''),
      targetFileId: String(local.targetFileId || ''),
    } : null,
    verify: item?.verify ? {
      status: String(item.verify.status || ''),
      archive: String(item.verify.archive || ''),
      diskStatus: String(item.verify.diskStatus || ''),
    } : null,
  };
}

function buildFailureReport(state, meta = {}) {
  const items = state && typeof state.items === 'object' ? state.items : {};
  const values = Object.entries(items);
  const failures = values
    .filter(([, item]) => /FAILED|HOLD|BLOCKED/.test(String(item?.status || '')))
    .map(([key, item]) => failureEntry(key, item));
  const count = re => values.filter(([, item]) => re.test(String(item?.status || ''))).length;
  const verified = count(/^VERIFIED$/);
  const skipped = count(/^SKIP/);
  return {
    generatedAt: new Date().toISOString(),
    jobId: String(meta.jobId || ''),
    jobDir: String(meta.jobDir || ''),
    stateFile: String(meta.stateFile || ''),
    exitCode: meta.exitCode ?? null,
    summary: {
      total: values.length,
      verified,
      failedOrBlocked: failures.length,
      skipped,
      runningOrOther: Math.max(0, values.length - verified - failures.length - skipped),
    },
    failures,
  };
}

function renderFailureLog(report) {
  const lines = [
    'TES5 Review Center download failure log',
    `generatedAt=${report.generatedAt}`,
    `jobId=${report.jobId || ''}`,
    `jobDir=${report.jobDir || ''}`,
    `exitCode=${report.exitCode ?? ''}`,
    `summary total=${report.summary.total} verified=${report.summary.verified} failedOrBlocked=${report.summary.failedOrBlocked} skipped=${report.summary.skipped}`,
  ];
  if (!report.failures.length) {
    lines.push('failures=0');
    return `${lines.join('\n')}\n`;
  }
  for (const [i, f] of report.failures.entries()) {
    lines.push('');
    lines.push(`[${i + 1}] exact=${f.exact} status=${f.status} errorCode=${f.errorCode}`);
    if (f.name) lines.push(`name=${f.name}`);
    if (f.version) lines.push(`version=${f.version}`);
    if (f.tx) lines.push(`tx=${f.tx}`);
    if (f.localIdentity) {
      lines.push(`localIdentity reason=${f.localIdentity.reason} localVersions=${f.localIdentity.localVersions.join(',')} targetVersion=${f.localIdentity.targetVersion}`);
    }
    if (f.verify?.status) lines.push(`verify=${f.verify.status}`);
    if (f.attempts.length) {
      lines.push(`attempts=${f.attempts.map(x => `${x.attempt ?? '?'}:${x.ok ? 'OK' : (x.errorCode || x.status || 'FAILED')}`).join(',')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function historyFileForJob(jobDir) {
  const jobsDir = path.dirname(jobDir);
  if (path.basename(jobsDir).toLowerCase() !== 'review-jobs') return '';
  return path.join(path.dirname(jobsDir), 'review-failure-history.jsonl');
}

function writeFailureArtifacts({ stateFile, jobDir, exitCode = null } = {}) {
  if (!stateFile || !fs.existsSync(stateFile) || !jobDir) return null;
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return null; }
  const report = buildFailureReport(state, {
    jobId: path.basename(jobDir), jobDir, stateFile, exitCode,
  });
  fs.mkdirSync(jobDir, { recursive: true });
  const jsonFile = path.join(jobDir, 'review-failures.json');
  const logFile = path.join(jobDir, 'review-failures.log');
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(logFile, renderFailureLog(report), 'utf8');

  const historyFile = historyFileForJob(jobDir);
  if (report.failures.length && historyFile) {
    const history = {
      generatedAt: report.generatedAt,
      jobId: report.jobId,
      jobDir: report.jobDir,
      exitCode: report.exitCode,
      summary: report.summary,
      failures: report.failures.map(f => ({
        exact: f.exact,
        name: f.name,
        status: f.status,
        errorCode: f.errorCode,
      })),
    };
    fs.appendFileSync(historyFile, `${JSON.stringify(history)}\n`, 'utf8');
  }

  return { report, jsonFile, logFile, historyFile };
}

module.exports = {
  failedAttemptCode,
  failureCode,
  failureEntry,
  buildFailureReport,
  renderFailureLog,
  historyFileForJob,
  writeFailureArtifacts,
};
