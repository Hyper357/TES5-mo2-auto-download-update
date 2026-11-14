#!/usr/bin/env node
'use strict';

// Static guard: index.js is never unit-tested (requiring it starts the whole
// pipeline), so a missing destructured import only shows up at runtime, in the
// middle of an audit. That happened on 2026-11-14: ISS-010 added loadJson(...)
// usage but not the import, and the pipeline aborted right after the planning
// scan with "loadJson is not defined" -- after a two-minute real API scan.
//
// This test reads the source and asserts every fs-json helper it calls is
// actually imported from ./scripts/lib/fs-json.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const imported = (src.match(/const \{([^}]+)\} = require\('\.\/scripts\/lib\/fs-json'\)/) || [])[1] || '';
const names = new Set(imported.split(',').map((s) => s.trim()).filter(Boolean));

const helpers = ['loadJson', 'saveJson', 'safeJson', 'writeText', 'ensureDir'];
const used = helpers.filter((h) => new RegExp(`\\b${h}\\s*\\(`).test(src));

assert.ok(used.length > 0, 'expected index.js to use at least one fs-json helper');
for (const h of used) {
  assert.ok(names.has(h), `index.js calls ${h}() but does not import it from ./scripts/lib/fs-json`);
}

console.log('index imports tests: OK');
