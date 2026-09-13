'use strict';

const fs = require('fs');
const path = require('path');
const { loadJson } = require('./fs-json');

function listRunDirs(rootDir) {
  const runsDir = path.join(rootDir, '.runtime', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => path.join(runsDir, x.name))
    .sort()
    .reverse();
}

function findLatestRun(rootDir, predicate = null) {
  for (const dir of listRunDirs(rootDir)) {
    if (!predicate || predicate(dir)) return dir;
  }
  return '';
}

function isReviewRun(dir) {
  return fs.existsSync(path.join(dir, 'review-center.json'));
}

function reviewRunMtime(dir) {
  try {
    return fs.statSync(path.join(dir, 'review-center.json')).mtimeMs || 0;
  } catch (_) {
    return 0;
  }
}

function findNearbyReviewRuns(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const parentDir = path.dirname(resolvedRoot);
  if (!parentDir || parentDir === resolvedRoot || !fs.existsSync(parentDir)) return [];

  const candidates = [];
  let siblings = [];
  try {
    siblings = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    const siblingRoot = path.join(parentDir, entry.name);
    if (path.resolve(siblingRoot) === resolvedRoot) continue;
    for (const runDir of listRunDirs(siblingRoot)) {
      if (isReviewRun(runDir)) candidates.push(runDir);
    }
  }

  return candidates.sort((a, b) => reviewRunMtime(b) - reviewRunMtime(a) || b.localeCompare(a));
}

function findLatestReviewRun(rootDir) {
  const local = findLatestRun(rootDir, isReviewRun);
  if (local) return local;
  return findNearbyReviewRuns(rootDir)[0] || '';
}

function executorFailureSummary(job) {
  if (!job || String(job.status || '').toUpperCase() !== 'FAILED') return null;
  const stateFile = job.state || (job.jobDir ? path.join(job.jobDir, 'execution-state.json') : '');
  if (!stateFile || !fs.existsSync(stateFile)) return null;
  const state = loadJson(stateFile, null);
  if (!state || typeof state.items !== 'object') return null;

  const failed = Object.entries(state.items)
    .filter(([, item]) => /FAILED|HOLD|BLOCKED/.test(String(item?.status || '')))
    .map(([key, item]) => {
      const attempts = Array.isArray(item?.attempts) ? item.attempts : [];
      const lastFailedAttempt = [...attempts].reverse().find(x => x && x.ok === false && x.errorCode);
      const errorCode = String(
        lastFailedAttempt?.errorCode ||
        item?.localExecutionGuard?.reason ||
        item?.verify?.status ||
        item?.error?.code ||
        item?.status ||
        'UNKNOWN_FAILURE'
      );
      return {
        key,
        modId: String(item?.modId || ''),
        fileId: String(item?.fileId || ''),
        name: String(item?.name || ''),
        status: String(item?.status || ''),
        errorCode,
      };
    });

  if (!failed.length) return null;
  const primary = failed.find(x => x.status !== 'BLOCKED_BY_TX_FAILURE') || failed[0];
  return { count: failed.length, primary };
}

function formatExecutorFailure(summary) {
  if (!summary?.primary) return '';
  const x = summary.primary;
  const exact = x.modId && x.fileId ? `${x.modId}:${x.fileId}` : (x.key || 'unknown exact target');
  const code = x.errorCode || x.status || 'UNKNOWN_FAILURE';
  const name = x.name ? ` · ${x.name}` : '';
  const more = summary.count > 1 ? ` · 共 ${summary.count} 个失败/阻断项` : '';
  return `执行器错误 ${code} · ${exact}${name}${more}`;
}

function latestReviewJob(runDir) {
  const dir = path.join(runDir, 'review-jobs');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, name, 'job.json');
    if (!fs.existsSync(file)) continue;
    const doc = loadJson(file, null);
    if (!doc) continue;
    const executorFailure = executorFailureSummary(doc);
    if (executorFailure) {
      doc.executorFailure = executorFailure;
      if (!doc.stderr) doc.stderr = formatExecutorFailure(executorFailure);
    }
    return doc;
  }
  return null;
}

module.exports = {
  listRunDirs,
  findLatestRun,
  findLatestReviewRun,
  findNearbyReviewRuns,
  latestReviewJob,
  executorFailureSummary,
  formatExecutorFailure,
};
