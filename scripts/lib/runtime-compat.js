#!/usr/bin/env node
'use strict';

const fs = require('fs');
const cp = require('child_process');

// Runtime / SKSE / edition compatibility gate.
//
// Nexus file descriptions frequently state the exact runtime the build was
// compiled for, e.g. "SKSE 2.3.1 / SSE (SAE) 1.7.104" or "SKSE 2.2.6, Skyrim
// 1.6.1170". A candidate whose minimum stated requirement is NEWER than the
// local installation must never be auto-downloaded: it would crash or refuse
// to load. Only the MINIMUM mentioned version is checked, so files that
// explicitly support older runtimes ("1.6.1170 and 1.7.104") still pass.

// ---------------------------------------------------------------------------
// Local baseline detection
//
// The gate is only as good as the local baseline it compares against. A
// hardcoded literal cannot notice that the user's game was upgraded, so the
// baseline is probed on the real machine first. Detection is strictly
// evidence-based: when no evidence exists it reports NOT_FOUND and the caller
// falls back to the historical constants while saying so in `warnings`.
// `defaultLocalRuntime()` runs once per candidate during an audit, so every
// probe is memoized for the process lifetime.
// ---------------------------------------------------------------------------

// A SKSE log is hundreds of KB; only its head can hold the initialize line.
const SKSE_LOG_HEAD_BYTES = 8192;

// Local SKSE log locations, most specific first. MO2 virtualizes Data, so the
// first entry is the virtualized profile copy and the rest are real installs.
const DEFAULT_SKSE_LOG_PATHS = [
  'C:\\Users\\ZHAOLJ\\Documents\\My Games\\Skyrim Special Edition\\SKSE\\skse64.log',
  'E:\\SkyrimAE\\Data\\SKSE\\Skyrim Special Edition\\Logs\\skse64.log',
  'E:\\SkyrimAE\\Data\\SKSE\\skse64.log',
];

// Game binary locations, most specific first.
//
// The Special Edition executable is `SkyrimSE.exe`, NOT `Skyrim.exe` — Skyrim
// Anniversary Edition ships `Skyrim.exe` with a totally different build line,
// and Skyrim SE has no `Skyrim.exe` at all. Probing only for `Skyrim.exe`
// silently reports NOT_FOUND on a perfectly healthy SSE install and makes the
// gate fall back to the hardcoded constant. Both names are listed per root so
// the detector stays honest on either edition.
const DEFAULT_SKYRIM_EXE_PATHS = [
  'E:\\SkyrimAE\\SkyrimSE.exe',
  'E:\\SkyrimAE\\Skyrim.exe',
  'E:\\SkyrimAE\\Data\\Skyrim Special Edition\\SkyrimSE.exe',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Skyrim Special Edition\\SkyrimSE.exe',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Skyrim Special Edition\\Skyrim.exe',
  'D:\\SteamLibrary\\steamapps\\common\\Skyrim Special Edition\\SkyrimSE.exe',
  'D:\\SteamLibrary\\steamapps\\common\\Skyrim Special Edition\\Skyrim.exe',
];

// Historical constants. Kept ONLY as the last-resort baseline, never as a
// detector fallback: an unverifiable value must be labelled, not trusted.
const FALLBACK_SKSE_VERSION = '2.2.6';
const FALLBACK_RUNTIME_VERSION = '1.6.1170';

let skseDetectionMemo = null;
let runtimeDetectionMemo = null;

// Test seam: drops the process-wide detection memo so a test can point the
// detectors at fixture files via the LOCAL_* environment overrides.
function resetRuntimeCache() {
  skseDetectionMemo = null;
  runtimeDetectionMemo = null;
}

// ";"-separated path list override, PATH-style, so a machine with a layout
// this file does not know about can still declare its own candidates.
function envPathList(name) {
  return String(process.env[name] || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

function isReadableFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readFileHead(p, bytes) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const SKSE_INIT_RE = /SKSE64\s+runtime:\s*initialize/gi;

// Only the FIRST "SKSE64 runtime: initialize" line is trusted: the version
// there is the one the running session loaded. A log can hold several sessions
// (append mode), and the later lines describe sessions that may not be the
// current installation, so they are counted but never parsed for the value.
function parseSkseLogHead(head) {
  SKSE_INIT_RE.lastIndex = 0;
  const first = SKSE_INIT_RE.exec(head);
  if (!first) return { version: '', occurrences: 0 };
  let occurrences = 1;
  SKSE_INIT_RE.lastIndex = first.index + first[0].length;
  while (SKSE_INIT_RE.exec(head)) occurrences++;
  SKSE_INIT_RE.lastIndex = 0;
  const nl = head.indexOf('\n', first.index);
  const line = nl === -1 ? head.slice(first.index) : head.slice(first.index, nl);
  const m = line.match(/version\s*=\s*(\d+(?:\.\d+)*)/i);
  return { version: m ? m[1] : '', occurrences };
}

// Candidate list order: an explicit single-path override, then either the
// machine-declared list or the built-in defaults. A declared list REPLACES the
// built-ins on purpose: a user who states their own layout does not want the
// hardcoded guesses probed as well.
function skseLogCandidates() {
  const declared = envPathList('LOCAL_SKSE_LOG_PATHS');
  const out = [];
  const single = String(process.env.LOCAL_SKSE_LOG_PATH || '').trim();
  if (single) out.push(single);
  for (const p of (declared.length ? declared : DEFAULT_SKSE_LOG_PATHS)) out.push(p);
  return out;
}

function detectLocalSkseUncached() {
  for (const p of skseLogCandidates()) {
    if (!isReadableFile(p)) continue;
    let parsed;
    try {
      parsed = parseSkseLogHead(readFileHead(p, SKSE_LOG_HEAD_BYTES));
    } catch {
      continue;
    }
    // An unreadable or version-less log must not shadow a later candidate.
    if (!parsed.version) continue;
    return {
      version: parsed.version,
      source: parsed.occurrences > 1 ? 'DETECTED_FIRST_OF_MULTIPLE_INIT_LINES' : 'DETECTED',
      path: p,
    };
  }
  return { version: '', source: 'NOT_FOUND', path: '' };
}

// Local SKSE version straight from the game's own log.
// -> { version, source, path }; version '' + source 'NOT_FOUND' when there is
// no evidence at all (the caller decides what to do about that).
function detectLocalSkse() {
  if (!skseDetectionMemo) skseDetectionMemo = detectLocalSkseUncached();
  return Object.assign({}, skseDetectionMemo);
}

function skyrimExeCandidates() {
  const declared = envPathList('LOCAL_SKYRIM_EXE_PATHS');
  const out = [];
  const single = String(process.env.LOCAL_SKYRIM_EXE || '').trim();
  if (single) out.push(single);
  for (const p of (declared.length ? declared : DEFAULT_SKYRIM_EXE_PATHS)) out.push(p);
  return out;
}

// PowerShell single-quoted literal ('' escapes an embedded quote).
function psLiteral(p) {
  return "'" + String(p).replace(/'/g, "''") + "'";
}

// The runtime build lives in the PE version resource, not in a readable text
// file, so it needs the OS to read it for us. Bounded by a short timeout: a
// wedged shell must not stall an audit.
function readPeProductVersion(p) {
  if (process.platform !== 'win32') return '';
  try {
    const out = cp.execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath ${psLiteral(p)}).VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const m = String(out || '').match(/\d+(?:\.\d+)*/);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

function detectLocalRuntimeUncached() {
  for (const p of skyrimExeCandidates()) {
    if (!isReadableFile(p)) continue;
    const version = readPeProductVersion(p);
    // A file that exists but carries no version resource is not evidence.
    if (!version) continue;
    return { version, source: 'DETECTED', path: p };
  }
  return { version: '', source: 'NOT_FOUND', path: '' };
}

// Local game runtime version from Skyrim.exe's PE version resource.
// -> { version, source, path } or NOT_FOUND. This detector never substitutes a
// default: an unreadable version is reported honestly.
function detectLocalRuntime() {
  if (!runtimeDetectionMemo) runtimeDetectionMemo = detectLocalRuntimeUncached();
  return Object.assign({}, runtimeDetectionMemo);
}

function baselineWarning(label, value, evidence, fix, detail) {
  return `${label} baseline ${value} is an UNVERIFIED ASSUMPTION, not a measured value: no ${evidence} was found at any known location, `
    + `so detection reported NOT_FOUND and the gate fell back to the hardcoded default. `
    + `Fix: ${fix}. detection detail: ${JSON.stringify(detail)}`;
}

// Backward compatible baseline: `skse` and `runtime` stay plain non-empty
// strings for existing callers, now with provenance attached.
// Precedence: explicit env override > machine detection > hardcoded default.
function defaultLocalRuntime() {
  const detail = { skse: detectLocalSkse(), runtime: detectLocalRuntime() };
  const envSkse = String(process.env.LOCAL_SKSE_VERSION || '').trim();
  const envRuntime = String(process.env.LOCAL_RUNTIME_VERSION || '').trim();

  const pick = (envValue, detected, fallback) => {
    if (envValue) return { value: envValue, source: 'ENV' };
    if (detected.version) return { value: detected.version, source: 'DETECTED' };
    return { value: fallback, source: 'FALLBACK' };
  };

  const skse = pick(envSkse, detail.skse, FALLBACK_SKSE_VERSION);
  const runtime = pick(envRuntime, detail.runtime, FALLBACK_RUNTIME_VERSION);

  const warnings = [];
  if (skse.source === 'FALLBACK') {
    warnings.push(baselineWarning(
      'SKSE', skse.value, 'SKSE log (skse64.log)',
      'set LOCAL_SKSE_VERSION to the real SKSE version, or point LOCAL_SKSE_LOG_PATH at the real skse64.log',
      detail.skse
    ));
  }
  if (runtime.source === 'FALLBACK') {
    warnings.push(baselineWarning(
      'Skyrim runtime', runtime.value, 'Skyrim.exe',
      'set LOCAL_RUNTIME_VERSION to the real game build, or point LOCAL_SKYRIM_EXE at the real Skyrim.exe',
      detail.runtime
    ));
  }
  // A detected value that differs from the historical constant means the box
  // moved (game or SKSE upgrade). Say so — the gate now trusts the machine.
  if (skse.source === 'DETECTED' && compareNumericVersions(skse.value, FALLBACK_SKSE_VERSION) !== 0) {
    warnings.push(`Detected SKSE version ${skse.value} differs from the hardcoded default ${FALLBACK_SKSE_VERSION}; the gate is now comparing against the detected value (${detail.skse.path || 'unknown path'}).`);
  }
  if (runtime.source === 'DETECTED' && compareNumericVersions(runtime.value, FALLBACK_RUNTIME_VERSION) !== 0) {
    warnings.push(`Detected Skyrim runtime version ${runtime.value} differs from the hardcoded default ${FALLBACK_RUNTIME_VERSION}; the gate is now comparing against the detected value (${detail.runtime.path || 'unknown path'}).`);
  }

  return {
    skse: skse.value || FALLBACK_SKSE_VERSION,
    runtime: runtime.value || FALLBACK_RUNTIME_VERSION,
    sources: { skse: skse.source, runtime: runtime.source },
    detail,
    warnings,
  };
}

function compareNumericVersions(a, b) {
  const pa = String(a || '').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// First numeric run of a version-ish string: "2.2light" -> "2.2",
// "1.9.1.0-AE" -> "1.9.1.0", "v1.9.1-SE" -> "1.9.1".
function versionCore(v) {
  const m = String(v || '').match(/\d+(?:\.\d+)*/);
  return m ? m[0] : '';
}

function parseRequiredRuntimes(text) {
  const t = String(text || '');
  const skseVersions = [];
  const reSkse = /SKSE\s*(?:v|ver(?:sion)?)?\s*[:=]?\s*(\d+\.\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = reSkse.exec(t))) skseVersions.push(m[1]);
  const runtimeVersions = [];
  const reRt = /\b(1\.[5-9](?:\.\d{1,4})?)\b/g;
  while ((m = reRt.exec(t))) runtimeVersions.push(m[1]);
  // Edition-tagged mentions ("SE1.7", "AE1.6.640", "适配SE1.7"): \b never
  // fires between the tag's last letter and the digit (both are \w), so the
  // generic scan above misses them. Only branch abbreviations qualify —
  // "v1.9.1" is a MOD version, not a runtime, and must stay unrecognized.
  const reEd = /(?:(?<=SE)|(?<=AE)|(?<=SSE)|(?<=适配))\s*(1\.[5-9](?:\.\d{1,4})?)(?![\d.])/g;
  while ((m = reEd.exec(t))) {
    if (!runtimeVersions.includes(m[1])) runtimeVersions.push(m[1]);
  }
  // Hard requirement: phrases like "Updated for compatibility with Skyrim
  // v1.7.104" state the runtime THIS build targets. They override the
  // min-mentioned heuristic, because such texts often ALSO mention older
  // runtimes only as port suggestions ("Last Compatible 1.6 version: 2.0",
  // "for 1.5.97 use one of the ports").
  const hardRuntimeVersions = [];
  const reHard = /updated\s+for\s+(?:compatibility\s+with\s+)?(?:skyrim|sse|the\s+)?\s*(?:v|ver(?:sion)?)?\s*[:=]?\s*(\d\.\d+(?:\.\d+)*)/gi;
  while ((m = reHard.exec(t))) hardRuntimeVersions.push(m[1]);
  // Chinese equivalent: "适配SE1.7" states the runtime THIS build targets.
  // Unlike the English phrase, texts may list several targets ("适配1.6.1170、
  // 1.7"); for those the MINIMUM is the compatibility floor, so the caller
  // checks the min instead of rejecting per mention.
  const adaptedRuntimeVersions = [];
  const reAdapted = /适配\s*(?:SE|AE|SSE|skyrim|天际)?\s*[:：]?\s*(\d\.\d+(?:\.\d+)*)/gi;
  while ((m = reAdapted.exec(t))) adaptedRuntimeVersions.push(m[1]);
  // Bare "For vX" statements ("For v1.7.104", "Backwards compatible (CommonlibNG)
  // for 1.6.1130", "Requires 1.7.104"). The generic scan cannot see these — the
  // "v" prefix suppresses \b between the letter and the digit, and that
  // suppression is deliberate so MOD versions like "v1.9.1" stay unrecognized.
  // The verb phrase ("for"/"requires") is what disambiguates: here the v-number
  // is a RUNTIME requirement, not the mod's own version. To keep that
  // disambiguation sharp, only runtime-shaped versions qualify (1.[5-9] with a
  // 3-4 digit build tail: 1.5.97 / 1.6.1170 / 1.7.104). Min-mention semantics
  // apply: "for 1.7.104" alone rejects on 1.6.1170, "backwards compatible for
  // 1.6.1130" passes, and multi-target lists ("for 1.6.1170 and 1.7.104")
  // take the minimum.
  const forRuntimeVersions = [];
  const reFor = /\b(?:for|requires?)\b\s*:?\s*(?:skyrim\s*)?v?\s*(1\.[5-9]\.\d{3,4})\b/gi;
  while ((m = reFor.exec(t))) forRuntimeVersions.push(m[1]);
  // "Added support for Skyrim 1.7.99, previous versions are still compatible":
  // the new-version mention is additive, not exclusive — drop it so the
  // min-mention heuristic does not reject on it.
  if (/previous\s+versions\s+(?:are\s+)?still\s+compatible/i.test(t)) {
    const reAdditive = /added\s+support\s+for\s+(?:skyrim\s*)?(1\.\d+(?:\.\d+)*)/gi;
    const additive = [];
    while ((m = reAdditive.exec(t))) additive.push(m[1]);
    for (const list of [runtimeVersions, hardRuntimeVersions, adaptedRuntimeVersions, forRuntimeVersions]) {
      for (const v of additive) {
        const i = list.indexOf(v);
        if (i !== -1) list.splice(i, 1);
      }
    }
  }
  return { skseVersions, runtimeVersions, hardRuntimeVersions, adaptedRuntimeVersions, forRuntimeVersions };
}

function minVersion(list) {
  let min = null;
  for (const v of list) {
    if (min === null || compareNumericVersions(v, min) < 0) min = v;
  }
  return min;
}

// Human-checkable quote: the sentence-ish fragment around the FIRST occurrence
// of the version string in the source text, so every automatic reject carries
// the Nexus evidence a person can verify.
function quoteAround(text, ver) {
  const t = String(text || '');
  const i = t.indexOf(String(ver || ''));
  if (i === -1) return '';
  return t.slice(Math.max(0, i - 60), Math.min(t.length, i + String(ver).length + 60)).trim();
}

// Reject reasons when the candidate text states a minimum requirement newer
// than the local installation. Empty text -> no reject (no evidence).
function runtimeCompatRejects(candidateText, local = defaultLocalRuntime()) {
  const { skseVersions, runtimeVersions, hardRuntimeVersions, adaptedRuntimeVersions, forRuntimeVersions } = parseRequiredRuntimes(candidateText);
  const out = [];
  const minSkse = minVersion(skseVersions);
  if (minSkse && compareNumericVersions(minSkse, local.skse) > 0) {
    out.push({ reason: 'TARGET_REQUIRES_NEWER_SKSE', required: minSkse, local: local.skse, quote: quoteAround(candidateText, minSkse) });
  }
  for (const hard of hardRuntimeVersions) {
    if (compareNumericVersions(hard, local.runtime) > 0) {
      out.push({ reason: 'TARGET_REQUIRES_NEWER_RUNTIME', required: hard, local: local.runtime, evidence: 'UPDATED_FOR_PHRASE', quote: quoteAround(candidateText, hard) });
    }
  }
  if (out.some(x => x.reason === 'TARGET_REQUIRES_NEWER_RUNTIME')) return out;
  const minAdapted = minVersion(adaptedRuntimeVersions);
  if (minAdapted && compareNumericVersions(minAdapted, local.runtime) > 0) {
    out.push({ reason: 'TARGET_REQUIRES_NEWER_RUNTIME', required: minAdapted, local: local.runtime, evidence: 'ADAPTED_FOR_PHRASE', quote: quoteAround(candidateText, minAdapted) });
    return out;
  }
  const minFor = minVersion(forRuntimeVersions);
  if (minFor && compareNumericVersions(minFor, local.runtime) > 0) {
    out.push({ reason: 'TARGET_REQUIRES_NEWER_RUNTIME', required: minFor, local: local.runtime, evidence: 'FOR_VERSION_PHRASE', quote: quoteAround(candidateText, minFor) });
    return out;
  }
  const minRuntime = minVersion(runtimeVersions);
  if (minRuntime && compareNumericVersions(minRuntime, local.runtime) > 0) {
    out.push({ reason: 'TARGET_REQUIRES_NEWER_RUNTIME', required: minRuntime, local: local.runtime, quote: quoteAround(candidateText, minRuntime) });
  }
  return out;
}

// Edition tags: AE vs SE. Both-listed ("AE SE") counts as either, never a
// mismatch. Missing tags on either side -> no evidence -> no reject.
function editionTags(text) {
  const t = String(text || '');
  const tags = [];
  if (/(^|[^A-Za-z])AE([^A-Za-z]|$)/.test(t) || /\bSAE\b/.test(t) || /anniversary edition/i.test(t)) tags.push('AE');
  if (/(^|[^A-Za-z])SE([^A-Za-z]|$)/.test(t) || /\bSSE\b/.test(t) || /special edition/i.test(t)) tags.push('SE');
  return tags;
}

function branchCompatRejects(localText, candidateText) {
  const local = editionTags(localText);
  const cand = editionTags(candidateText);
  if (!local.length || !cand.length) return [];
  const localOnly = local.filter(x => !cand.includes(x));
  const candOnly = cand.filter(x => !local.includes(x));
  if (localOnly.length && candOnly.length) {
    return [{ reason: 'TARGET_EDITION_MISMATCH', localEditions: local, candidateEditions: cand }];
  }
  return [];
}

module.exports = {
  defaultLocalRuntime,
  detectLocalSkse,
  detectLocalRuntime,
  resetRuntimeCache,
  DEFAULT_SKSE_LOG_PATHS,
  DEFAULT_SKYRIM_EXE_PATHS,
  FALLBACK_SKSE_VERSION,
  FALLBACK_RUNTIME_VERSION,
  compareNumericVersions,
  versionCore,
  parseRequiredRuntimes,
  runtimeCompatRejects,
  editionTags,
  branchCompatRejects,
};
