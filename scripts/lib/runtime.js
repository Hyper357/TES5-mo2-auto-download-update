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

function findLatestReviewRun(rootDir) {
  return findLatestRun(rootDir, dir =>
    fs.existsSync(path.join(dir, 'review-center.html')) &&
    fs.existsSync(path.join(dir, 'review-center.json')));
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

module.exports = { listRunDirs, findLatestRun, findLatestReviewRun, latestReviewJob };
