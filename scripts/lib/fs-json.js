'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  fs.renameSync(tmp, file);
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

module.exports = { ensureDir, loadJson, saveJson, safeJson, readText, writeText };
