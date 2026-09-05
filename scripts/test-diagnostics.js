'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeString, sanitize, classifyFailure, createLogger } = require('./lib/diagnostics');

{
  const raw = 'https://www.nexusmods.com/x?user_id=123&key=SECRET&expires=999';
  const s = sanitizeString(raw);
  assert.ok(!s.includes('SECRET'));
  assert.ok(!s.includes('user_id=123'));
  assert.ok(s.includes('[REDACTED]'));
}

{
  const raw = 'nxm://skyrimspecialedition/mods/1/files/2?key=SECRET&expires=999&user_id=123';
  const s = sanitizeString(raw);
  assert.ok(s.startsWith('nxm://skyrimspecialedition/mods/1/files/2?'));
  assert.ok(!s.includes('SECRET'));
  assert.ok(!s.includes('123'));
}

{
  const obj = sanitize({ apiKey: 'secret', cookie: 'session', nested: { token: 'x', safe: 'ok' } });
  assert.strictEqual(obj.apiKey, '[REDACTED]');
  assert.strictEqual(obj.cookie, '[REDACTED]');
  assert.strictEqual(obj.nested.token, '[REDACTED]');
  assert.strictEqual(obj.nested.safe, 'ok');
}

{
  assert.strictEqual(classifyFailure('HTTP 429 rate limit').code, 'NEXUS_API_429');
  assert.strictEqual(classifyFailure('NO-NXM-EXTRACTED').code, 'NXM_EXTRACT_FAILED');
  assert.strictEqual(classifyFailure('VARIANT-MISMATCH').code, 'VARIANT_CONFLICT');
  assert.strictEqual(classifyFailure('FILEID_MISMATCH').retry, false);
  assert.strictEqual(classifyFailure('VERIFY_TIMEOUT').retry, true);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-diag-test-'));
  const logger = createLogger(dir, { debug: true, runId: 'test' });
  logger.info('TEST', 'hello', { modId: 1, fileId: 2 });
  logger.error('TEST', 'failed https://x.test/?key=SECRET', { errorCode: 'NXM_EXTRACT_FAILED' });
  logger.debug('TEST', 'debug event');
  assert.ok(fs.existsSync(logger.files.pipeline));
  assert.ok(fs.existsSync(logger.files.events));
  assert.ok(fs.existsSync(logger.files.errors));
  const all = fs.readFileSync(logger.files.events, 'utf8');
  assert.ok(!all.includes('SECRET'));
  assert.ok(all.includes('NXM_EXTRACT_FAILED'));
  const diagnostic = logger.writeDiagnostic('sample', { cookie: 'SECRET', value: 7 });
  assert.ok(fs.existsSync(diagnostic));
  assert.ok(!fs.readFileSync(diagnostic, 'utf8').includes('SECRET'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('diagnostics tests: OK');
