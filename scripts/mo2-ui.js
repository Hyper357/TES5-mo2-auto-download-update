#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const path = require('path');
const {
  evaluateSnapshot,
  buttonRegexForRole,
} = require('./lib/mo2-ui-guard');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PS = path.join(__dirname, 'mo2-ui-state.ps1');

function runPowerShell(args) {
  if (process.platform !== 'win32') {
    return { ok: false, status: 2, stdout: '', stderr: 'MO2_UI_UNSUPPORTED: Windows only' };
  }
  const r = cp.spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS, ...args,
  ], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || '').replace(/^\uFEFF/, '').trim(),
    stderr: String(r.stderr || '').trim(),
  };
}

function parseJsonOutput(r) {
  if (!r.stdout) return { ok: false, error: r.stderr || 'EMPTY_UI_OUTPUT' };
  try { return JSON.parse(r.stdout); }
  catch (e) { return { ok: false, error: 'INVALID_UI_JSON', detail: e.message, sample: r.stdout.slice(0, 1200) }; }
}

function snapshot() {
  const r = runPowerShell(['-Action', 'snapshot']);
  const parsed = parseJsonOutput(r);
  if (!r.ok && parsed.ok !== true) parsed.processExit = r.status;
  return parsed;
}

function invokeSafe(action) {
  const regex = buttonRegexForRole(action.buttonRole);
  const r = runPowerShell([
    '-Action', 'invoke',
    '-WindowHandle', String(action.handle),
    '-ButtonPattern', regex,
  ]);
  const parsed = parseJsonOutput(r);
  return { ...parsed, processOk: r.ok, role: action.buttonRole, kind: action.kind, reason: action.reason };
}

async function inspectTarget(target, options = {}) {
  const dismissSafe = !!options.dismissSafe;
  const watchMs = Math.max(0, Number(options.watchMs || 0));
  const intervalMs = Math.max(150, Number(options.intervalMs || 300));
  const deadline = Date.now() + watchMs;
  const handled = [];
  const seenHandles = new Set();
  let latestSnapshot = null;
  let latestEval = null;
  let ambiguousSeen = [];

  do {
    latestSnapshot = snapshot();
    if (!latestSnapshot.ok) {
      return {
        ok: false,
        error: latestSnapshot.error || 'MO2_UI_SNAPSHOT_FAILED',
        snapshot: latestSnapshot,
        handled,
      };
    }

    latestEval = evaluateSnapshot(latestSnapshot, target);
    if (latestEval.ambiguousDialogs.length) {
      ambiguousSeen = latestEval.ambiguousDialogs;
    }

    if (dismissSafe) {
      for (const action of latestEval.safeActions) {
        const dedupeKey = `${action.handle}:${action.kind}:${action.buttonRole}`;
        if (seenHandles.has(dedupeKey)) continue;
        seenHandles.add(dedupeKey);
        const result = invokeSafe(action);
        handled.push({ ...action, result });
        if (result.ok) await sleep(180);
      }
    }

    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  } while (true);

  // Final snapshot after any safe dismissals, so callers see what remains on screen.
  if (dismissSafe && handled.some(h => h.result?.ok)) {
    await sleep(200);
    const finalSnap = snapshot();
    if (finalSnap.ok) {
      latestSnapshot = finalSnap;
      latestEval = evaluateSnapshot(finalSnap, target);
    }
  }

  const handledKinds = handled.filter(h => h.result?.ok).map(h => h.kind);
  return {
    ok: true,
    target,
    evaluation: latestEval,
    handled,
    handledKinds,
    ambiguousSeen,
    duplicateDialogHandled: handledKinds.includes('DUPLICATE_QUEUE_INFO'),
    redownloadPromptCancelled: handledKinds.includes('REDOWNLOAD_PROMPT'),
    safety: {
      clickedAffirmativeRedownload: false,
      policy: 'Only exact duplicate OK and strong-name re-download NO are invokable',
    },
  };
}

async function main() {
  const target = {
    modId: argValue('--mod-id'),
    fileId: argValue('--file-id'),
    name: argValue('--name'),
  };
  const dismissSafe = process.argv.includes('--dismiss-safe');
  const watchMs = Number(argValue('--watch-ms', '0')) || 0;
  const intervalMs = Number(argValue('--interval-ms', '300')) || 300;
  const result = await inspectTarget(target, { dismissSafe, watchMs, intervalMs });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  else if (result.evaluation?.safety?.hasAmbiguousDuplicateDialog) process.exitCode = 3;
}

if (require.main === module) {
  main().catch(err => {
    console.error(`mo2-ui failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runPowerShell, snapshot, invokeSafe, inspectTarget };
