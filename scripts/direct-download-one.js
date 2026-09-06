#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseManifestText } = require('./lib/manifest');
const { argValue } = require('./lib/cli');
const {
  expectedBytes,
  fileNameForExact,
  createDirectSession,
  closeDirectSession,
  runDirectTarget,
} = require('./lib/direct-session');

function safeMessage(value) {
  return String(value || '')
    .replace(/nxm:\/\/[^\s]+/gi, '[SIGNED_NXM_REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]');
}

function readOneRow(manifest) {
  const rows = parseManifestText(fs.readFileSync(manifest, 'utf8'))
    .filter(r => r.action === 'DOWNLOAD' && r.modId && r.fileId);
  if (rows.length !== 1) {
    const e = new Error(`DIRECT_ONE_REQUIRES_ONE_DOWNLOAD_ROW: got=${rows.length}`);
    e.code = 'DIRECT_ONE_REQUIRES_ONE_DOWNLOAD_ROW';
    throw e;
  }
  return rows[0];
}

async function runDirectOne({ manifest, row, downloads, apiKeyFile, sevenzip, timeoutSec = 600, session = null }) {
  const target = row || readOneRow(manifest);
  const owned = !session;
  const active = session || await createDirectSession({ apiKeyFile });
  try {
    return await runDirectTarget({ row: target, downloads, sevenzip, timeoutSec, session: active });
  } finally {
    if (owned) await closeDirectSession(active);
  }
}

async function main() {
  const manifest = process.argv[2];
  if (!manifest) throw new Error('用法: node direct-download-one.js <one.tsv> --downloads DIR --api-key-file FILE [--sevenzip PATH]');
  const downloads = argValue(process.argv, '--downloads', process.env.MO2_DOWNLOADS_DIR || 'E:\\SkyrimAE\\mo2\\downloads');
  const apiKeyFile = argValue(process.argv, '--api-key-file', process.env.NEXUS_API_KEY_FILE || 'E:\\SkyrimAE\\tools\\.nexus_api_key');
  const sevenzip = argValue(process.argv, '--sevenzip', process.env.MO2_7Z || process.env.SEVENZIP || '');
  const timeoutSec = Number(argValue(process.argv, '--timeout-sec', '600')) || 600;
  const result = await runDirectOne({
    manifest: path.resolve(manifest),
    downloads: path.resolve(downloads),
    apiKeyFile: path.resolve(apiKeyFile),
    sevenzip,
    timeoutSec,
  });
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch(err => {
    console.error(`DIRECT_DOWNLOAD_FAILED ${err.code || 'UNKNOWN'} ${safeMessage(err.message)}`);
    process.exit(1);
  });
}

module.exports = {
  readOneRow,
  expectedBytes,
  fileNameForExact,
  runDirectOne,
  safeMessage,
};
