#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function run(command, args = [], { capture = false, allowFailure = false, cwd = ROOT, env = process.env } = {}) {
  const r = cp.spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const ok = !r.error && r.status === 0;
  const out = {
    ok,
    status: r.status,
    error: r.error || null,
    stdout: capture ? String(r.stdout || '').trim() : '',
    stderr: capture ? String(r.stderr || '').trim() : '',
  };
  if (!ok && !allowFailure) {
    const detail = out.stderr || out.stdout || r.error?.message || `${command} exited ${r.status}`;
    throw new Error(detail);
  }
  return out;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function git(commandArgs, options = {}) {
  return run('git', commandArgs, options);
}

function porcelainIsClean(text) {
  return !String(text || '').trim();
}

function dependencyHealth() {
  const marker = path.join(ROOT, 'node_modules', 'puppeteer-core', 'package.json');
  if (!fs.existsSync(marker)) return { ok: false, reason: 'node_modules missing' };
  const r = run(npmCommand(), ['ls', '--depth=0', '--silent'], { capture: true, allowFailure: true });
  return r.ok ? { ok: true, reason: 'npm dependency tree healthy' } : { ok: false, reason: 'npm dependency tree stale/incomplete' };
}

function currentIdentity() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).stdout;
  const head = git(['rev-parse', 'HEAD'], { capture: true }).stdout;
  const status = git(['status', '--porcelain'], { capture: true }).stdout;
  return { branch, head, clean: porcelainIsClean(status), status };
}

function syncLatestMain() {
  const before = currentIdentity();
  if (before.branch !== 'main') {
    return {
      ok: false,
      code: 'AGENT_BOOTSTRAP_NOT_MAIN',
      detail: `当前分支是 ${before.branch || '(detached)'}；bootstrap 不会自动切分支或覆盖工作。请确认任务分支后手动同步 main。`,
      before,
      identity: before,
    };
  }
  if (!before.clean) {
    return {
      ok: false,
      code: 'AGENT_BOOTSTRAP_DIRTY_WORKTREE',
      detail: '工作区存在未提交修改；为避免覆盖本地工作，bootstrap 拒绝自动 pull。',
      before,
      identity: before,
    };
  }

  const pull = git(['pull', '--ff-only', 'origin', 'main'], { capture: true, allowFailure: true });
  if (!pull.ok) {
    return {
      ok: false,
      code: 'AGENT_BOOTSTRAP_PULL_FAILED',
      detail: pull.stderr || pull.stdout || 'git pull --ff-only failed',
      before,
      identity: before,
    };
  }
  return { ok: true, pull: pull.stdout || 'Already up to date.', before, identity: currentIdentity() };
}

function reexecIfUpdated(synced) {
  const changed = synced?.before?.head && synced?.identity?.head && synced.before.head !== synced.identity.head;
  if (!changed || process.env.AGENT_BOOTSTRAP_REEXEC === '1') return false;
  console.log(`Updated ${synced.before.head.slice(0, 12)} -> ${synced.identity.head.slice(0, 12)}; restarting bootstrap from the new checkout...`);
  const r = run(process.execPath, [__filename], {
    allowFailure: true,
    env: { ...process.env, AGENT_BOOTSTRAP_REEXEC: '1' },
  });
  process.exit(Number.isInteger(r.status) ? r.status : 1);
}

function main() {
  console.log('TES5 MO2 agent bootstrap');
  console.log('1/4 Syncing repository to origin/main (fast-forward only)...');
  const synced = syncLatestMain();
  if (!synced.ok) {
    console.error(`${synced.code}: ${synced.detail}`);
    process.exit(2);
  }
  console.log(synced.pull);
  reexecIfUpdated(synced);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  console.log(`Using package ${pkg.version} at ${synced.identity.head}`);

  console.log('2/4 Checking dependencies...');
  const deps = dependencyHealth();
  if (!deps.ok) {
    console.log(`${deps.reason}; running npm ci...`);
    run(npmCommand(), ['ci', '--prefer-offline', '--no-audit', '--no-fund']);
  } else {
    console.log(deps.reason);
  }

  console.log('3/4 Running syntax checks...');
  run(npmCommand(), ['run', 'check']);

  console.log('4/4 Reading compact live agent state...');
  run(npmCommand(), ['run', 'agent:brief']);

  const latest = currentIdentity();
  console.log(`AGENT_BOOTSTRAP_READY branch=${latest.branch} head=${latest.head} package=${pkg.version}`);
  console.log('Next: follow docs/TASK_ENTRY.md task routing. Do not trust docs/CURRENT_STATE.md as live runtime state.');
}

if (require.main === module) {
  try { main(); }
  catch (err) {
    console.error(`AGENT_BOOTSTRAP_FAILED ${String(err.message || err)}`);
    process.exit(1);
  }
}

module.exports = {
  porcelainIsClean,
  dependencyHealth,
  currentIdentity,
  syncLatestMain,
  reexecIfUpdated,
};
