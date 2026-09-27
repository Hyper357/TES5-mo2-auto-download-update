#!/usr/bin/env node
'use strict';

// Runtime / SKSE / edition compatibility gate.
//
// Nexus file descriptions frequently state the exact runtime the build was
// compiled for, e.g. "SKSE 2.3.1 / SSE (SAE) 1.7.104" or "SKSE 2.2.6, Skyrim
// 1.6.1170". A candidate whose minimum stated requirement is NEWER than the
// local installation must never be auto-downloaded: it would crash or refuse
// to load. Only the MINIMUM mentioned version is checked, so files that
// explicitly support older runtimes ("1.6.1170 and 1.7.104") still pass.

function defaultLocalRuntime() {
  return {
    skse: process.env.LOCAL_SKSE_VERSION || '2.2.6',
    runtime: process.env.LOCAL_RUNTIME_VERSION || '1.6.1170',
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
  // "Added support for Skyrim 1.7.99, previous versions are still compatible":
  // the new-version mention is additive, not exclusive — drop it so the
  // min-mention heuristic does not reject on it.
  if (/previous\s+versions\s+(?:are\s+)?still\s+compatible/i.test(t)) {
    const reAdditive = /added\s+support\s+for\s+(?:skyrim\s*)?(1\.\d+(?:\.\d+)*)/gi;
    const additive = [];
    while ((m = reAdditive.exec(t))) additive.push(m[1]);
    for (const list of [runtimeVersions, hardRuntimeVersions, adaptedRuntimeVersions]) {
      for (const v of additive) {
        const i = list.indexOf(v);
        if (i !== -1) list.splice(i, 1);
      }
    }
  }
  return { skseVersions, runtimeVersions, hardRuntimeVersions, adaptedRuntimeVersions };
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
  const { skseVersions, runtimeVersions, hardRuntimeVersions, adaptedRuntimeVersions } = parseRequiredRuntimes(candidateText);
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
  compareNumericVersions,
  versionCore,
  parseRequiredRuntimes,
  runtimeCompatRejects,
  editionTags,
  branchCompatRejects,
};
