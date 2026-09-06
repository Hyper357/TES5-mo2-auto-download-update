'use strict';

const assert = require('assert');
const { getCdpUrl } = require('./lib/browser-session');
const {
  isLoopbackBrowserUrl,
  rewriteConnectOptions,
  disableLegacyReconnectArg,
} = require('./lib/cdp-compat-preload');

assert.strictEqual(isLoopbackBrowserUrl('http://127.0.0.1:9222'), true);
assert.strictEqual(isLoopbackBrowserUrl('http://localhost:9333/'), true);
assert.strictEqual(isLoopbackBrowserUrl('https://example.com:9222'), false);

const legacy = rewriteConnectOptions({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
assert.strictEqual(legacy.browserURL, getCdpUrl());
assert.strictEqual(legacy.defaultViewport, null);

const dynamicOld = rewriteConnectOptions({ browserURL: 'http://localhost:9999' });
assert.strictEqual(dynamicOld.browserURL, getCdpUrl());

const remote = rewriteConnectOptions({ browserURL: 'https://remote.example:9222' });
assert.strictEqual(remote.browserURL, 'https://remote.example:9222');

const ws = { browserWSEndpoint: 'ws://remote/devtools/browser/abc' };
assert.strictEqual(rewriteConnectOptions(ws), ws);

const fakeExecutorArgv = ['node', 'C:\\repo\\scripts\\execute-plan.js', 'run.tsv', '--reconnect', '--debug'];
assert.strictEqual(disableLegacyReconnectArg(fakeExecutorArgv), true);
assert.strictEqual(fakeExecutorArgv.includes('--reconnect'), false);

const unrelated = ['node', 'C:\\repo\\scripts\\something-else.js', '--reconnect'];
assert.strictEqual(disableLegacyReconnectArg(unrelated), false);
assert.strictEqual(unrelated.includes('--reconnect'), true);

const puppeteer = require('puppeteer-core');
assert.strictEqual(typeof puppeteer.connect, 'function');

console.log('shared CDP preload tests: OK');
