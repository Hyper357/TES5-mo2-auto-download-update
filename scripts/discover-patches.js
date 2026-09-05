#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scanModsDirectory } = require('./lib/mo2-reader');
const { tokenSimilarity } = require('./lib/file-selector');
const { parseRegistry, findRules, isFresh } = require('./lib/aux-registry');
const {
  inferFamily, isPatchLike, isTranslationLike, mergeCandidates,
  installedContext, assessDiscovery,
} = require('./lib/patch-discovery');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function loadJson(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function safeCell(v) { return String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim(); }

function loadRelations(file) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const [mainModId, auxModId, family, source, note] = raw.split('\t').map(x => String(x || '').trim());
    if (!mainModId || !auxModId) continue;
    if (!map.has(mainModId)) map.set(mainModId, []);
    map.get(mainModId).push({ mainModId, auxModId, family, source: source || 'RELATION_REGISTRY', note });
  }
  return map;
}

function installedPatchCandidates(mainName, localMods) {
  const out = [];
  for (const m of localMods) {
    const text = `${m.folderName || ''} ${m.installationFile || ''}`;
    if (!isPatchLike(text) || isTranslationLike(text)) continue;
    const sim = tokenSimilarity(mainName, text);
    if (sim < 0.18 && !String(text).toLowerCase().includes(String(mainName || '').toLowerCase())) continue;
    out.push({
      source: 'INSTALLED_PATCH',
      auxModId: m.modId ? String(m.modId) : '',
      fileId: m.installedFiles?.[0] ? String(m.installedFiles[0]) : '',
      version: m.version || '', name: m.folderName || text,
      installed: true, mainName,
      evidence: `installed MO2 entry; similarity=${sim.toFixed(2)}`,
    });
  }
  return out;
}

function localFomodCandidates(item) {
  const out = [];
  for (const p of item.fomodPlugins || []) {
    const text = typeof p === 'string' ? p : (p?.name || JSON.stringify(p));
    if (!isPatchLike(text) || isTranslationLike(text)) continue;
    out.push({ source: 'LOCAL_FOMOD', name: text, mainName: item.latestName || item.name, installed: true, evidence: 'installed/local FOMOD compatibility option' });
  }
  return out;
}

async function browserDiscover(browser, modId, mainName) {
  const page = await browser.newPage();
  const url = `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}`;
  const result = {
    pageLoaded: false,
    requirements: { required: true, complete: false, status: 'NOT_SCANNED', detail: '' },
    description: { required: true, complete: false, status: 'NOT_SCANNED', detail: '' },
    candidates: [],
  };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 900));
    result.pageLoaded = true;

    // Expand the Requirements panel if Nexus renders it collapsed. No coordinate clicks.
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('button,a,summary,[role="button"]')];
      const hit = els.find(el => /^requirements$/i.test((el.textContent || '').trim()));
      if (hit && typeof hit.click === 'function') hit.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 700));

    const scraped = await page.evaluate(() => {
      const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
      const hrefModId = href => {
        const m = String(href || '').match(/\/skyrimspecialedition\/mods\/(\d+)/i);
        return m ? m[1] : '';
      };
      const bodyText = clean(document.body?.innerText || '');
      const all = [...document.querySelectorAll('a[href]')];
      const links = all.map(a => {
        const id = hrefModId(a.href);
        if (!id) return null;
        let node = a;
        let context = '';
        for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
          const t = clean(node.innerText || '');
          if (t.length > context.length && t.length < 9000) context = t;
        }
        return { modId: id, name: clean(a.innerText || a.getAttribute('title') || ''), href: a.href, context: context.slice(0, 5000) };
      }).filter(Boolean);

      const reqHeading = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,button,summary,div,span')]
        .find(el => /mods requiring this file/i.test(clean(el.textContent || '')) && clean(el.textContent || '').length < 140);
      let reverse = [];
      if (reqHeading) {
        let container = reqHeading;
        for (let i = 0; i < 5 && container; i++, container = container.parentElement) {
          const scoped = [...container.querySelectorAll('a[href]')].map(a => ({
            modId: hrefModId(a.href), name: clean(a.innerText || a.getAttribute('title') || ''), href: a.href,
            context: clean(a.parentElement?.innerText || '').slice(0, 3000),
          })).filter(x => x.modId);
          if (scoped.length) { reverse = scoped; break; }
        }
      }
      // Fallback: links whose local context explicitly says they are under reverse requirements.
      if (!reverse.length) reverse = links.filter(x => /mods requiring this file/i.test(x.context));

      const descriptionLinks = links.filter(x => /(patch|compat|compatibility|hotfix|fix|integration|补丁|兼容|修复)/i.test(`${x.name} ${x.context}`));
      const explicitNoReq = /(does not have any known dependencies|no known dependencies|no requirements)/i.test(bodyText);
      const hasReqPhrase = /mods requiring this file/i.test(bodyText);
      return { bodyText: bodyText.slice(0, 120000), reverse, descriptionLinks, explicitNoReq, hasReqPhrase };
    });

    if (scraped.reverse.length || scraped.hasReqPhrase || scraped.explicitNoReq) {
      result.requirements = { required: true, complete: true, status: scraped.reverse.length ? 'COMPLETE' : 'COMPLETE_EMPTY', detail: `reverseLinks=${scraped.reverse.length}` };
    } else {
      result.requirements = { required: true, complete: false, status: 'SECTION_NOT_PROVEN', detail: 'Could not prove Mods requiring this file section was inspected.' };
    }
    result.description = { required: true, complete: true, status: 'COMPLETE', detail: `patchLikeLinks=${scraped.descriptionLinks.length}` };

    const seen = new Set();
    for (const x of [...scraped.reverse.map(v => ({ ...v, source: 'REQUIREMENTS_REVERSE' })), ...scraped.descriptionLinks.map(v => ({ ...v, source: 'DESCRIPTION_LINK' }))]) {
      if (String(x.modId) === String(modId)) continue;
      const text = `${x.name} ${x.context}`;
      if (!isPatchLike(text) || isTranslationLike(text)) continue;
      const key = `${x.source}:${x.modId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.candidates.push({ source: x.source, auxModId: x.modId, name: x.name || `Nexus mod ${x.modId}`, url: x.href, mainName, evidence: x.context.slice(0, 1200) });
    }

    // Text-only compatibility statements are evidence too; they create unresolved GENERAL/custom families.
    const lines = scraped.bodyText.split(/\n|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length < 20 || line.length > 420) continue;
      if (!isPatchLike(line) || isTranslationLike(line)) continue;
      if (!/(require|need|available|use|install|compat|patch|补丁|兼容|修复)/i.test(line)) continue;
      result.candidates.push({ source: 'DESCRIPTION_TEXT', name: line.slice(0, 220), mainName, evidence: line });
      if (result.candidates.length > 160) break;
    }
  } catch (err) {
    result.requirements = { required: true, complete: false, status: 'BROWSER_ERROR', detail: err.message };
    result.description = { required: true, complete: false, status: 'BROWSER_ERROR', detail: err.message };
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

async function main() {
  const planFile = process.argv[2];
  const modsDir = process.argv[3];
  const registryFile = argValue('--registry', path.resolve(__dirname, '..', 'config', 'aux-registry.tsv'));
  const relationsFile = argValue('--relations', path.resolve(__dirname, '..', 'config', 'patch-relations.tsv'));
  const outFile = argValue('--out');
  const tasksFile = argValue('--tasks');
  const maxAgeDays = Number(argValue('--max-age-days', '14')) || 14;
  const noBrowser = process.argv.includes('--no-browser');
  if (!planFile || !modsDir || !outFile) {
    console.error('Usage: node discover-patches.js <plan.json> <modsDir> --registry aux-registry.tsv --out patch-discovery.json [--tasks patch-tasks.tsv]');
    process.exit(2);
  }

  const plan = loadJson(planFile, { items: [] });
  const localMods = scanModsDirectory(modsDir);
  const localNames = localMods.map(m => `${m.folderName || ''} ${m.installationFile || ''}`);
  const rules = parseRegistry(registryFile);
  const relations = loadRelations(relationsFile);
  const targets = (plan.items || []).filter(x => x.action === 'DOWNLOAD' && (x.latestFileId || x.fileId));
  let browser = null;
  if (!noBrowser && targets.length) {
    try {
      const puppeteer = require('puppeteer-core');
      browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
    } catch (_) { browser = null; }
  }

  const items = [];
  for (const item of targets) {
    const mainName = item.latestName || item.name || '';
    const mainFileId = String(item.latestFileId || item.fileId || '');
    const mainVersion = item.latestVersion || item.installedVersion || '';
    const raw = [];

    for (const p of item.aux?.patches || []) raw.push({ source: 'SAME_PAGE_FILE', fileId: p.fileId, version: p.version, name: p.name, mainName, evidence: `same Nexus page category=${p.category || ''}` });
    raw.push(...installedPatchCandidates(mainName, localMods));
    raw.push(...localFomodCandidates(item));
    for (const rel of relations.get(String(item.modId)) || []) raw.push({ source: 'RELATION_REGISTRY', auxModId: rel.auxModId, family: rel.family, name: rel.note || `Independent patch page ${rel.auxModId}`, mainName, evidence: `${rel.source}; ${rel.note || ''}` });

    let browserResult = { requirements: { required: true, complete: false, status: noBrowser ? 'DISABLED' : 'BROWSER_UNAVAILABLE' }, description: { required: true, complete: false, status: noBrowser ? 'DISABLED' : 'BROWSER_UNAVAILABLE' }, candidates: [] };
    if (browser) browserResult = await browserDiscover(browser, item.modId, mainName);
    raw.push(...browserResult.candidates);

    let candidates = mergeCandidates(raw).map(c => ({ ...c, ...installedContext(c, localNames) }));
    // Text-only generic candidates are noisy. Keep them as evidence only when they infer a meaningful family or match installed context.
    candidates = candidates.filter(c => c.source !== 'DESCRIPTION_TEXT' || c.family !== 'GENERAL' || c.installedContextMatch);

    const relevantRules = findRules(rules, { mainModId: item.modId, mainFileId, mainVersion });
    const freshPatchRules = relevantRules.filter(r => r.kind === 'PATCH' && isFresh(r, maxAgeDays).fresh);
    const stalePatchRules = relevantRules.filter(r => r.kind === 'PATCH' && !isFresh(r, maxAgeDays).fresh).map(r => r.id);
    const coverage = {
      samePageFiles: { required: true, complete: true, status: 'COMPLETE', detail: `scannerCandidates=${item.aux?.patches?.length || 0}` },
      installedContext: { required: true, complete: true, status: 'COMPLETE', detail: `localMods=${localMods.length}` },
      relationRegistry: { required: true, complete: true, status: 'COMPLETE', detail: `relations=${relations.get(String(item.modId))?.length || 0}` },
      requirementsReverse: browserResult.requirements,
      description: browserResult.description,
    };
    const assessed = assessDiscovery({ candidates, patchRules: freshPatchRules, coverage });
    if (stalePatchRules.length) {
      assessed.coverageProblems.push({ source: 'registryFreshness', status: 'STALE_RULES', detail: stalePatchRules.join(',') });
      assessed.coverageComplete = false;
      assessed.complete = false;
    }

    items.push({
      modId: String(item.modId), mainFileId, mainVersion, mainName,
      coverage, coverageComplete: assessed.coverageComplete,
      complete: assessed.complete,
      candidateCount: assessed.candidates.length,
      unresolvedCount: assessed.unresolved.length,
      candidates: assessed.candidates,
      unresolved: assessed.unresolved,
      coverageProblems: assessed.coverageProblems,
      stalePatchRules,
    });
  }
  if (browser) await browser.disconnect().catch(() => {});

  const payload = {
    generatedAt: new Date().toISOString(), plan: planFile, modsDir, registry: registryFile, relations: relationsFile,
    strict: true, targets: items.length,
    complete: items.filter(x => x.complete).length,
    held: items.filter(x => !x.complete).length,
    unresolvedCandidates: items.reduce((n, x) => n + x.unresolvedCount, 0),
    items,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  if (tasksFile) {
    const header = ['modId','mainFileId','mainVersion','mainName','problem','candidateKey','family','source','auxModId','fileId','candidateName','installedContext','localMatches','recommendedAction'];
    const lines = [header.join('\t')];
    for (const x of items) {
      for (const p of x.coverageProblems) lines.push([x.modId,x.mainFileId,x.mainVersion,x.mainName,`COVERAGE:${p.source}:${p.status}`,'','','','','','', '', '', `Inspect Nexus ${p.source}; do not release MAIN until coverage is proven`].map(safeCell).join('\t'));
      for (const c of x.unresolved) lines.push([x.modId,x.mainFileId,x.mainVersion,x.mainName,'UNRESOLVED_PATCH',c.key,c.family,c.source,c.auxModId,c.fileId,c.name,c.installedContextMatch ? 'YES':'NO',(c.localMatches||[]).join(' | '),'Resolve as REQUIRED / NOT_APPLICABLE / ALREADY_INCLUDED / OBSOLETE in aux-registry v3'].map(safeCell).join('\t'));
    }
    fs.writeFileSync(tasksFile, lines.join('\n') + '\n', 'utf8');
  }
  console.log(JSON.stringify({ targets: payload.targets, complete: payload.complete, held: payload.held, unresolvedCandidates: payload.unresolvedCandidates, outFile, tasksFile }, null, 2));
}

main().catch(err => { console.error(`discover-patches failed: ${err.message}`); process.exit(1); });
