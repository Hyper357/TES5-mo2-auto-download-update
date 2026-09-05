#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { argValue, hasFlag } = require('./lib/cli');
const { buildEnvironmentGraph, compactEnvironmentSummary } = require('./lib/mo2-environment');

function main() {
  const modsDir = process.argv[2] || process.env.MO2_MODS_DIR || 'E:\\SkyrimAE\\mo2\\mods';
  const profileDir = argValue(process.argv, '--profile-dir', process.env.MO2_PROFILE_DIR || '');
  const profileName = argValue(process.argv, '--profile-name', process.env.MO2_PROFILE_NAME || '');
  const outFile = argValue(process.argv, '--out', '');
  const compact = hasFlag(process.argv, '--compact');
  const graph = buildEnvironmentGraph({ modsDir, profileDir, profileName });
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), JSON.stringify(graph, null, 2), 'utf8');
  }
  const payload = compact ? compactEnvironmentSummary(graph) : graph;
  console.log(JSON.stringify(payload, null, compact ? 0 : 2));
  if (!graph.profile?.resolved) process.exitCode = 2;
}

try { main(); }
catch (err) { console.error(`environment-status failed: ${err.message}`); process.exit(1); }
