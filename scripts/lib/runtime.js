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

function latestReviewJob(runDir) {
  const dir = path.join(runDir, 'review-jobs');
  if (!fs.existsSync(dir)) return null;
  for (const name of fs.readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, name, 'job.json');
    if (!fs.existsSync(file)) continue;
    const doc = loadJson(file, null);
    if (doc) return doc;
  }
  return null;
}

module.exports = { listRunDirs, findLatestRun, findLatestReviewRun, findNearbyReviewRuns, latestReviewJob };
