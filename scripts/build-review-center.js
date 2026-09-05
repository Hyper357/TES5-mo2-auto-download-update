#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue } = require('./lib/cli');
const { loadJson, saveJson, writeText } = require('./lib/fs-json');
const { buildReviewPayload } = require('./lib/review-center-model');

const assetDir = path.resolve(__dirname, '..', 'web', 'review');

function renderHtml(payload) {
  const template = fs.readFileSync(path.join(assetDir, 'template.html'), 'utf8');
  const style = fs.readFileSync(path.join(assetDir, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(assetDir, 'app.js'), 'utf8');
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return template
    .replace('/*__STYLE__*/', style)
    .replace('__REVIEW_DATA__', data)
    .replace('/*__APP__*/', app);
}

function main() {
  const planFile = process.argv[2];
  const patchFile = process.argv[3];
  const closureFile = process.argv[4];
  const outJson = argValue(process.argv, '--out');
  const outHtml = argValue(process.argv, '--html');
  const autoReport = argValue(process.argv, '--auto-report', '');
  if (!planFile || !outJson || !outHtml) {
    console.error('Usage: node build-review-center.js <plan.json> [patch-discovery.json] [closure.json] --out review-center.json --html review-center.html');
    process.exit(2);
  }

  const payload = buildReviewPayload(
    loadJson(planFile, { items: [] }),
    loadJson(patchFile, { items: [] }),
    loadJson(closureFile, { items: [] }),
    {
      plan: planFile,
      patchDiscovery: patchFile || null,
      closure: closureFile || null,
      autoReport: autoReport || null,
    });

  saveJson(outJson, payload, { atomic: false });
  writeText(outHtml, renderHtml(payload));
  console.log(JSON.stringify({ items: payload.items.length, counts: payload.counts, outJson, outHtml }, null, 2));
}

if (require.main === module) main();

module.exports = { renderHtml };
