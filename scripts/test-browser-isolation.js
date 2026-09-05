'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  SENTINEL_PREFIX,
  sentinelUrl,
  targetHasSentinel,
  getCdpPort,
  managedSessionStatus,
} = require('./lib/browser-session');
const {
  CANONICAL_CDP_PORT,
  browserCandidates,
  systemBrowserCandidates,
} = require('./browser-manager');
const { classifyFailure } = require('./lib/diagnostics');

async function main() {
  {
    const token = '11111111-2222-3333-4444-555555555555';
    const url = sentinelUrl(token);
    assert.ok(url.startsWith('data:text/html'));
    assert.ok(url.includes(`${SENTINEL_PREFIX}${encodeURIComponent(token)}`));
    assert.strictEqual(targetHasSentinel([{ url }], token), true);
    assert.strictEqual(targetHasSentinel([{ url: 'https://github.com/' }], token), false);
    assert.strictEqual(targetHasSentinel([], token), false);
  }

  {
    const e = classifyFailure('BROWSER_PROFILE_MISMATCH: port 9222 is occupied by an unmanaged browser/profile');
    assert.strictEqual(e.code, 'BROWSER_PROFILE_MISMATCH');
    assert.strictEqual(e.retry, false);
    assert.strictEqual(e.layer, 'BROWSER');
  }

  {
    assert.ok(Number.isInteger(getCdpPort()));
    assert.ok(getCdpPort() > 0);
    // v4.1.2 persisted fallback ports while two legacy consumers still used 9222.
    // Until those consumers are migrated, startup must preserve one canonical endpoint.
    assert.strictEqual(CANONICAL_CDP_PORT, 9222);
  }

  {
    // System Chrome is deliberately excluded from the default automation candidate set.
    // It is only an explicit escape hatch; Chrome for Testing is the normal managed browser.
    const normal = browserCandidates();
    const withSystem = browserCandidates({ includeSystem: true });
    for (const candidate of systemBrowserCandidates()) {
      assert.strictEqual(normal.includes(candidate), false);
      assert.strictEqual(withSystem.includes(candidate), true);
    }
  }

  {
    // Regression from the real Windows incident: PowerShell -Command with $args[0]
    // arrived as null on the user's host, so Chrome for Testing could never install.
    const managerSource = fs.readFileSync(path.join(__dirname, 'browser-manager.js'), 'utf8');
    assert.strictEqual(managerSource.includes('Expand-Archive -LiteralPath $args[0]'), false);
    assert.ok(managerSource.includes('Expand-Archive -LiteralPath'));
    assert.ok(managerSource.includes('browser-startup.log'));
    assert.ok(managerSource.includes('nexus-autodl-edge'));
  }

  {
    // Regression: an HTTP service on the CDP port that returns 404/non-JSON is not
    // "browser stopped". It is an occupied/mismatched port and manager must not wait.
    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('not chrome devtools');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-browser-test-'));
    try {
      const status = await managedSessionStatus({
        cdpUrl: `http://127.0.0.1:${port}`,
        profileDir,
        timeout: 800,
      });
      assert.strictEqual(status.state, 'MISMATCH');
      assert.strictEqual(status.cdp, false);
      assert.strictEqual(status.portOccupied, true);
      assert.strictEqual(status.error, 'INVALID_JSON');
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }

  console.log('browser isolation tests: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
