'use strict';

// Transitional compatibility layer for legacy browser consumers.
// The managed browser may live on any persisted localhost CDP port. Older scripts
// still pass http://127.0.0.1:9222 to puppeteer-core.connect(); intercept those
// loopback connections and route them to the shared browser-session endpoint.
// This lets the pipeline coexist with a user's normal Edge/Chrome owning 9222.

const Module = require('module');
const { getCdpUrl } = require('./browser-session');

const PATCH_MARK = Symbol.for('tes5.mo2.sharedCdpPreloadInstalled');

function isLoopbackBrowserUrl(value) {
  const s = String(value || '').trim();
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/i.test(s);
}

function rewriteConnectOptions(options = {}) {
  if (!options || typeof options !== 'object') return options;
  if (options.browserWSEndpoint) return options;
  if (!options.browserURL || isLoopbackBrowserUrl(options.browserURL)) {
    return { ...options, browserURL: getCdpUrl() };
  }
  return options;
}

function wrapPuppeteerExports(exportsObject) {
  if (!exportsObject || typeof exportsObject.connect !== 'function') return exportsObject;
  return new Proxy(exportsObject, {
    get(target, prop, receiver) {
      if (prop !== 'connect') return Reflect.get(target, prop, receiver);
      return function sharedCdpConnect(options) {
        return Reflect.apply(target.connect, target, [rewriteConnectOptions(options || {})]);
      };
    },
  });
}

function disableLegacyReconnectArg(argv = process.argv) {
  const entry = String(argv?.[1] || '').split(/[\\/]/).pop().toLowerCase();
  if (!['execute-plan.js', 'nexus-autodl.js'].includes(entry)) return false;
  let removed = false;
  for (let i = argv.length - 1; i >= 2; i--) {
    if (argv[i] === '--reconnect') {
      argv.splice(i, 1);
      removed = true;
    }
  }
  if (removed) process.env.MO2_MANAGED_BROWSER_ONLY = '1';
  return removed;
}

function install() {
  if (globalThis[PATCH_MARK]) return;
  globalThis[PATCH_MARK] = true;
  disableLegacyReconnectArg(process.argv);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const result = Reflect.apply(originalLoad, this, [request, parent, isMain]);
    return request === 'puppeteer-core' ? wrapPuppeteerExports(result) : result;
  };
}

install();

module.exports = {
  isLoopbackBrowserUrl,
  rewriteConnectOptions,
  wrapPuppeteerExports,
  disableLegacyReconnectArg,
  install,
};
