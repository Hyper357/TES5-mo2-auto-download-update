#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseStrict } = require('./lib/cli');
const { saveJson, loadJson } = require('./lib/fs-json');
const { formatManifest, parseManifestText } = require('./lib/manifest');
const {
  findLatestRun,
  findLatestReviewRun,
  findNearbyReviewRuns,
  latestReviewJob,
  executorFailureSummary,
  formatExecutorFailure,
} = require('./lib/runtime');
const {
  DEFAULT_CAPTURE_MAX_BUFFER,
  REVIEW_EXACT_EXECUTOR,
  normalizeNodeRequirePath,
  nodeOptionsWithProjectPreload,
  projectNodeEnv,
  isExplicitReviewManifest,
  routedNodeArgs,
  runNode,
} = require('./lib/process-runner');
const { rewriteInstalledDir } = require('./review-exact-execute');

const cli = parseStrict(['mods', '--go', '--timeout-sec', '42', '--no-open-review'], {
  go: { type: 'boolean', flags: ['--go'], default: false },
  openReview: { type: 'boolean', flags: ['--no-open-review'], value: false, default: true },
  timeoutSec: { type: 'number', flags: ['--timeout-sec'], default: 1200, min: 1 },
});
assert.deepStrictEqual(cli.positional, ['mods']);
assert.strictEqual(cli.go, true);
assert.strictEqual(cli.openReview, false);
assert.strictEqual(cli.timeoutSec, 42);
assert.throws(() => parseStrict(['--wat'], {}), /未知参数/);

const rows = [{ modId: '1', name: 'A\tB', ver: '2', note: 'tx=1:3\nfoo', fileId: '3', action: 'DOWNLOAD' }];
const manifest = formatManifest(rows);
const parsed = parseManifestText(manifest);
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].name, 'A B');
assert.strictEqual(parsed[0].note, 'tx=1:3 foo');

// Regression from the real Windows v4.1.4 incident: NODE_OPTIONS parsed
// E:\SkyrimAE\work\... as E:SkyrimAEwork... before the child script started.
// Forward slashes are valid to Node on Windows and preserve spaces when quoted.
const winPreload = 'E:\\SkyrimAE\\work\\repo with space\\scripts\\lib\\cdp-compat-preload.js';
const safeWinPreload = 'E:/SkyrimAE/work/repo with space/scripts/lib/cdp-compat-preload.js';
assert.strictEqual(normalizeNodeRequirePath(winPreload), safeWinPreload);
const winNodeOptions = nodeOptionsWithProjectPreload('--trace-warnings', winPreload);
assert.strictEqual(winNodeOptions, `--trace-warnings --require "${safeWinPreload}"`);
assert.strictEqual(winNodeOptions.includes('\\'), false);
assert.strictEqual(nodeOptionsWithProjectPreload(winNodeOptions, winPreload), winNodeOptions);
assert.strictEqual(projectNodeEnv({ NODE_OPTIONS: '' }, winPreload).NODE_OPTIONS, `--require "${safeWinPreload}"`);

// Regression from the real v4.1.14 full-library closure run: captured child stdout
// exceeded Node's ~1 MiB spawnSync default. The shared runner now carries a 16 MiB
// default and exposes a per-call override for genuinely larger reports.
assert.strictEqual(DEFAULT_CAPTURE_MAX_BUFFER, 16 * 1024 * 1024);
const largeCapture = runNode(['-e', `process.stdout.write('x'.repeat(${2 * 1024 * 1024}))`], { capture: true });
assert.strictEqual(largeCapture.ok, true);
assert.strictEqual(largeCapture.errorCode, null);
assert.strictEqual(largeCapture.maxBuffer, DEFAULT_CAPTURE_MAX_BUFFER);
assert.ok(largeCapture.stdout.length >= 2 * 1024 * 1024);

// Review Center file-picker rows are explicit, exact, allow-listed download requests.
// They must not be rejected merely because MO2 contains several independent folders
// from the same Nexus mod page at different versions (real incident: mod 150386 file 643721).
// Route only all-explicit review-run manifests through the scoped wrapper; legacy or mixed
// executor manifests keep the normal local identity guard unchanged.
const exactReview = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-exact-'));
try {
  const jobDir = path.join(exactReview, 'review-jobs', '2026-09-13T060000');
  fs.mkdirSync(jobDir, { recursive: true });
  const reviewManifest = path.join(jobDir, 'review-run.tsv');
  fs.writeFileSync(reviewManifest,
    '150386\tVD - Dialogue Expansion - Windhelm Patch\t1.0\ttx=review:150386:selected-files; user-selected-nexus-file; category=OPTIONAL; closure=NOT_ASSERTED\t643721\tDOWNLOAD\n',
    'utf8');

  assert.strictEqual(isExplicitReviewManifest(reviewManifest), true);
  const directExecutor = path.join(__dirname, 'execute-plan.js');
  const routed = routedNodeArgs([
    directExecutor,
    reviewManifest,
    '--installed-dir', path.join(exactReview, 'real-mo2-mods'),
    '--run-dir', jobDir,
  ]);
  assert.strictEqual(path.resolve(routed[0]), path.resolve(REVIEW_EXACT_EXECUTOR));

  const rewritten = rewriteInstalledDir(routed.slice(1));
  assert.strictEqual(rewritten.changed, true);
  const installedIndex = rewritten.args.indexOf('--installed-dir');
  assert.ok(installedIndex >= 0);
  assert.strictEqual(path.resolve(rewritten.args[installedIndex + 1]), path.resolve(jobDir, 'explicit-review-download-context'));
  assert.strictEqual(fs.existsSync(rewritten.args[installedIndex + 1]), true);
  assert.deepStrictEqual(fs.readdirSync(rewritten.args[installedIndex + 1]), []);

  const mixedManifest = path.join(jobDir, 'other.tsv');
  fs.writeFileSync(mixedManifest,
    '150386\tLegacy Main\t1.0\ttx=150386:1; planner-main\t1\tDOWNLOAD\n',
    'utf8');
  assert.strictEqual(isExplicitReviewManifest(mixedManifest), false);
  const normal = routedNodeArgs([directExecutor, mixedManifest, '--installed-dir', 'mods']);
  assert.strictEqual(path.resolve(normal[0]), path.resolve(directExecutor));
} finally {
  fs.rmSync(exactReview, { recursive: true, force: true });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-shared-'));
try {
  const jsonFile = path.join(tmp, 'nested', 'x.json');
  saveJson(jsonFile, { ok: true });
  assert.deepStrictEqual(loadJson(jsonFile, null), { ok: true });

  const runs = path.join(tmp, '.runtime', 'runs');
  fs.mkdirSync(path.join(runs, '2026-01-01'), { recursive: true });
  fs.mkdirSync(path.join(runs, '2026-01-02'), { recursive: true });
  fs.writeFileSync(path.join(runs, '2026-01-01', 'review-center.html'), 'x');
  fs.writeFileSync(path.join(runs, '2026-01-01', 'review-center.json'), '{}');
  assert.ok(findLatestRun(tmp).endsWith('2026-01-02'));
  assert.ok(findLatestReviewRun(tmp).endsWith('2026-01-01'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A git clone does not carry .runtime because it is intentionally ignored. When a
// freshly updated repo copy has no local runs, Review Center should recover the newest
// sibling repo run instead of forcing a full rescan. review-center.json is sufficient
// because the current UI is rendered from JSON; an archived HTML snapshot is optional.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-nearby-review-'));
try {
  const currentRepo = path.join(workspace, 'repo-current');
  const oldRepo = path.join(workspace, 'repo-old');
  const olderRepo = path.join(workspace, 'repo-older');
  fs.mkdirSync(currentRepo, { recursive: true });

  const oldRun = path.join(oldRepo, '.runtime', 'runs', '2026-09-12T120000');
  const olderRun = path.join(olderRepo, '.runtime', 'runs', '2026-09-11T120000');
  fs.mkdirSync(oldRun, { recursive: true });
  fs.mkdirSync(olderRun, { recursive: true });
  fs.writeFileSync(path.join(oldRun, 'review-center.json'), '{"items":[]}');
  fs.writeFileSync(path.join(olderRun, 'review-center.json'), '{"items":[]}');
  const now = new Date();
  const before = new Date(now.getTime() - 60_000);
  fs.utimesSync(path.join(oldRun, 'review-center.json'), now, now);
  fs.utimesSync(path.join(olderRun, 'review-center.json'), before, before);

  const nearby = findNearbyReviewRuns(currentRepo);
  assert.strictEqual(nearby[0], oldRun);
  assert.strictEqual(findLatestReviewRun(currentRepo), oldRun);

  // A local run always wins; nearby recovery is fallback-only.
  const localRun = path.join(currentRepo, '.runtime', 'runs', '2026-09-13T000000');
  fs.mkdirSync(localRun, { recursive: true });
  fs.writeFileSync(path.join(localRun, 'review-center.json'), '{"items":[]}');
  assert.strictEqual(findLatestReviewRun(currentRepo), localRun);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

// FAILED Review Center jobs must expose the exact executor failure from execution-state
// instead of reducing it to only "N failed items". This also works for an already-failed
// historical job after the server is restarted; no download retry is required.
const failedRun = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-failure-'));
try {
  const jobDir = path.join(failedRun, 'review-jobs', '2026-09-13T030000');
  fs.mkdirSync(jobDir, { recursive: true });
  const stateFile = path.join(jobDir, 'execution-state.json');
  saveJson(stateFile, {
    items: {
      '129928:5001': {
        modId: '129928', fileId: '5001', name: 'Example Mod', status: 'DIRECT_DOWNLOAD_FAILED',
        attempts: [{ attempt: 1, ok: false, errorCode: 'NXM_DOWNLOAD_CONTROL_MISSING' }],
        error: { code: 'UNKNOWN_FAILURE' },
      },
      '129928:5002': {
        modId: '129928', fileId: '5002', name: 'Dependent file', status: 'BLOCKED_BY_TX_FAILURE',
      },
    },
  });
  saveJson(path.join(jobDir, 'job.json'), { status: 'FAILED', jobDir, state: stateFile });

  const rawSummary = executorFailureSummary({ status: 'FAILED', jobDir, state: stateFile });
  assert.strictEqual(rawSummary.count, 2);
  assert.strictEqual(rawSummary.primary.errorCode, 'NXM_DOWNLOAD_CONTROL_MISSING');
  assert.strictEqual(rawSummary.primary.modId, '129928');
  assert.match(formatExecutorFailure(rawSummary), /NXM_DOWNLOAD_CONTROL_MISSING/);
  assert.match(formatExecutorFailure(rawSummary), /129928:5001/);

  const latest = latestReviewJob(failedRun);
  assert.strictEqual(latest.executorFailure.primary.errorCode, 'NXM_DOWNLOAD_CONTROL_MISSING');
  assert.match(latest.stderr, /执行器错误 NXM_DOWNLOAD_CONTROL_MISSING/);
  assert.match(latest.stderr, /129928:5001/);
} finally {
  fs.rmSync(failedRun, { recursive: true, force: true });
}

console.log('shared-runtime tests: OK');
