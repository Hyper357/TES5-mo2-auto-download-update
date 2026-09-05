#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scanModsDirectory } = require('./lib/mo2-reader');
const { tokenSimilarity } = require('./lib/file-selector');
const { parseRegistry, findRules, isFresh } = require('./lib/aux-registry');
const {
  COMPONENT_KINDS,
  classifyComponent,
  componentFamily,
  mergeComponentCandidates,
  withInstalledContext,
  assessComponentDiscovery,
  countsByKind,
} = require('./lib/component-discovery');

function argValue(name, fallback = '') { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
function loadJson(file, fallback) { if (!file || !fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
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

function installedComponentCandidates(mainName, localMods) {
  const out = [];
  for (const m of localMods) {
    const text = `${m.folderName || ''} ${m.installationFile || ''}`;
    const kind = classifyComponent(text, { source: 'INSTALLED_COMPONENT' });
    if (!kind) continue;
    const sim = tokenSimilarity(mainName, text);
    if (sim < 0.18 && !String(text).toLowerCase().includes(String(mainName || '').toLowerCase())) continue;
    out.push({
      kind,
      source: 'INSTALLED_COMPONENT',
      auxModId: m.modId ? String(m.modId) : '',
      fileId: m.installedFiles?.[0] ? String(m.installedFiles[0]) : '',
      version: m.version || '',
      name: m.folderName || text,
      installed: true,
      mainName,
      evidence: `installed MO2 entry; similarity=${sim.toFixed(2)}`,
    });
  }
  return out;
}

function localFomodCandidates(item) {
  const out = [];
  for (const p of item.fomodPlugins || []) {
    const text = typeof p === 'string' ? p : (p?.name || JSON.stringify(p));
    const kind = classifyComponent(text, { source: 'LOCAL_FOMOD' });
    if (!kind) continue;
    out.push({
      kind,
      source: 'LOCAL_FOMOD',
      name: text,
      mainName: item.latestName || item.name,
      installed: true,
      evidence: 'installed/local FOMOD component option',
    });
  }
  return out;
}

async function browserDiscover(browser, modId, mainName) {
  const page = await browser.newPage();
  const url = `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}`;
  const result = {
    pageLoaded: false,
    requirementsForward: { required: true, complete: false, status: 'NOT_SCANNED', detail: '' },
    requirementsReverse: { required: true, complete: false, status: 'NOT_SCANNED', detail: '' },
    description: { required: true, complete: false, status: 'NOT_SCANNED', detail: '' },
    candidates: [],
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 900));
    result.pageLoaded = true;
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
      const bodyRaw = document.body?.innerText || '';
      const bodyText = clean(bodyRaw);
      const all = [...document.querySelectorAll('a[href]')];
      const links = all.map(a => {
        const id = hrefModId(a.href);
        if (!id) return null;
        const name = clean(a.innerText || a.getAttribute('title') || '');
        let context = clean(a.parentElement?.innerText || name);
        let node = a.parentElement;
        for (let i = 0; i < 3 && node && context.length < 70; i++, node = node.parentElement) {
          const t = clean(node.parentElement?.innerText || '');
          if (t.length >= context.length && t.length <= 1600) context = t;
        }
        return { modId: id, name, href: a.href, context: context.slice(0, 1600) };
      }).filter(Boolean);

      const reverse = links.filter(x => /mods requiring this file/i.test(x.context));
      const forward = links.filter(x => {
        if (/mods requiring this file/i.test(x.context)) return false;
        return /(nexus requirements|this mod requires|required by this mod|required mod|required dependency|requirements)/i.test(x.context);
      });
      const descriptionLinks = links.filter(x => /(patch|compat|compatibility|hotfix|fix|integration|required|requirement|dependency|resource|framework|library|bodyslide|mesh|texture|physics|hdt|smp|config|preset|optional|addon|translation|汉化|补丁|兼容|修复)/i.test(`${x.name} ${x.context}`));

      const explicitNoReq = /(does not have any known dependencies|no known dependencies|no requirements)/i.test(bodyText);
      const hasReversePhrase = /mods requiring this file/i.test(bodyText);
      const hasForwardPhrase = /(nexus requirements|this mod requires|required dependencies|required mods)/i.test(bodyText);
      return {
        bodyRaw: bodyRaw.slice(0, 120000),
        reverse,
        forward,
        descriptionLinks,
        explicitNoReq,
        hasReversePhrase,
        hasForwardPhrase,
      };
    });

    result.requirementsForward = (scraped.forward.length || scraped.hasForwardPhrase || scraped.explicitNoReq)
      ? { required: true, complete: true, status: scraped.forward.length ? 'COMPLETE' : 'COMPLETE_EMPTY', detail: `forwardLinks=${scraped.forward.length}` }
      : { required: true, complete: false, status: 'SECTION_NOT_PROVEN', detail: 'Could not prove forward Nexus requirements were inspected.' };
    result.requirementsReverse = (scraped.reverse.length || scraped.hasReversePhrase || scraped.explicitNoReq)
      ? { required: true, complete: true, status: scraped.reverse.length ? 'COMPLETE' : 'COMPLETE_EMPTY', detail: `reverseLinks=${scraped.reverse.length}` }
      : { required: true, complete: false, status: 'SECTION_NOT_PROVEN', detail: 'Could not prove Mods requiring this file section was inspected.' };
    result.description = { required: true, complete: true, status: 'COMPLETE', detail: `componentLikeLinks=${scraped.descriptionLinks.length}` };

    const seen = new Set();
    const linkSets = [
      ...scraped.forward.map(v => ({ ...v, source: 'REQUIREMENTS_FORWARD', requiredHint: true, kind: 'RESOURCE' })),
      ...scraped.reverse.map(v => ({ ...v, source: 'REQUIREMENTS_REVERSE' })),
      ...scraped.descriptionLinks.map(v => ({ ...v, source: 'DESCRIPTION_LINK' })),
    ];
    for (const x of linkSets) {
      if (String(x.modId) === String(modId)) continue;
      const text = `${x.name} ${x.context}`;
      const kind = x.kind || classifyComponent(text, { source: x.source });
      if (!kind) continue;
      const k = `${x.source}:${kind}:${x.modId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      result.candidates.push({
        kind,
        source: x.source,
        auxModId: x.modId,
        name: x.name || `Nexus mod ${x.modId}`,
        url: x.href,
        mainName,
        requiredHint: !!x.requiredHint,
        evidence: x.context.slice(0, 1200),
      });
    }

    const lines = scraped.bodyRaw.split(/\r?\n|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length < 20 || line.length > 420) continue;
      const kind = classifyComponent(line, { source: 'DESCRIPTION_TEXT' });
      if (!kind) continue;
      if (/(no patch (?:is )?(?:required|needed)|does not require.{0,40}patch|patch.{0,40}not (?:required|needed)|无需补丁|不需要.{0,20}补丁)/i.test(line)) continue;
      if (!/(require|need|available|use|install|optional|compat|patch|hotfix|resource|dependency|mesh|texture|physics|bodyslide|config|translation|补丁|兼容|修复|汉化)/i.test(line)) continue;
      result.candidates.push({
        kind,
        source: 'DESCRIPTION_TEXT',
        name: line.slice(0, 220),
        mainName,
        requiredHint: /\b(require|required|must|need|dependency)\b/i.test(line),
        optionalHint: /\b(optional|alternative|choose one|not required)\b/i.test(line),
        evidence: line,
      });
      if (result.candidates.length > 180) break;
    }
  } catch (err) {
    const failed = { required: true, complete: false, status: 'BROWSER_ERROR', detail: err.message };
    result.requirementsForward = failed;
    result.requirementsReverse = failed;
    result.description = failed;
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
    console.error('Usage: node discover-patches.js <plan.json> <modsDir> --registry aux-registry.tsv --out component-discovery.json [--tasks component-tasks.tsv]');
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
    } catch { browser = null; }
  }

  const items = [];
  for (const item of targets) {
    const mainName = item.latestName || item.name || '';
    const mainFileId = String(item.latestFileId || item.fileId || '');
    const mainVersion = item.latestVersion || item.installedVersion || '';
    const raw = [];

    for (const c of item.aux?.components || []) {
      raw.push({
        kind: c.kind,
        family: c.family,
        source: 'SAME_PAGE_FILE',
        fileId: c.fileId,
        version: c.version,
        name: c.name,
        mainName,
        evidence: `same Nexus page category=${c.category || ''}; ${c.description || ''}`.slice(0, 1800),
      });
    }
    // Backward compatibility for plans generated before generalized component candidates.
    for (const p of item.aux?.patches || []) raw.push({ kind: 'PATCH', source: 'SAME_PAGE_FILE', fileId: p.fileId, version: p.version, name: p.name, mainName, evidence: `same Nexus page category=${p.category || ''}` });
    for (const t of item.aux?.translations || []) raw.push({ kind: 'TRANSLATION', source: 'SAME_PAGE_FILE', fileId: t.fileId, version: t.version, name: t.name, mainName, evidence: `same Nexus page category=${t.category || ''}` });

    raw.push(...installedComponentCandidates(mainName, localMods), ...localFomodCandidates(item));
    for (const rel of relations.get(String(item.modId)) || []) {
      raw.push({ kind: 'PATCH', source: 'RELATION_REGISTRY', auxModId: rel.auxModId, family: rel.family, name: rel.note || `Independent patch page ${rel.auxModId}`, mainName, evidence: `${rel.source}; ${rel.note || ''}` });
    }

    let browserResult = {
      requirementsForward: { required: true, complete: false, status: noBrowser ? 'DISABLED' : 'BROWSER_UNAVAILABLE' },
      requirementsReverse: { required: true, complete: false, status: noBrowser ? 'DISABLED' : 'BROWSER_UNAVAILABLE' },
      description: { required: true, complete: false, status: noBrowser ? 'DISABLED' : 'BROWSER_UNAVAILABLE' },
      candidates: [],
    };
    if (browser) browserResult = await browserDiscover(browser, item.modId, mainName);
    raw.push(...browserResult.candidates);

    let candidates = mergeComponentCandidates(raw).map(c => withInstalledContext(c, localNames));
    candidates = candidates.filter(c => {
      if (c.source !== 'DESCRIPTION_TEXT') return true;
      if (c.requiredHint || c.installedContextMatch) return true;
      return ['PATCH', 'HOTFIX', 'TRANSLATION'].includes(c.kind) && c.family !== 'GENERAL';
    });

    const relevantRules = findRules(rules, { mainModId: item.modId, mainFileId, mainVersion });
    const componentRules = relevantRules.filter(r => COMPONENT_KINDS.includes(r.kind));
    const freshRules = componentRules.filter(r => isFresh(r, maxAgeDays).fresh);
    const staleRules = componentRules.filter(r => !isFresh(r, maxAgeDays).fresh).map(r => r.id);

    const coverage = {
      samePageComponents: { required: true, complete: true, status: 'COMPLETE', detail: `scannerCandidates=${item.aux?.components?.length || 0}` },
      installedContext: { required: true, complete: true, status: 'COMPLETE', detail: `localMods=${localMods.length}` },
      relationRegistry: { required: true, complete: true, status: 'COMPLETE', detail: `patchRelations=${relations.get(String(item.modId))?.length || 0}` },
      requirementsForward: browserResult.requirementsForward,
      requirementsReverse: browserResult.requirementsReverse,
      description: browserResult.description,
    };

    const assessed = assessComponentDiscovery({ candidates, rules: freshRules, coverage });
    if (staleRules.length) {
      assessed.coverageProblems.push({ source: 'registryFreshness', status: 'STALE_RULES', detail: staleRules.join(',') });
      assessed.coverageComplete = false;
      assessed.complete = false;
    }
    const byKind = countsByKind(assessed.candidates);
    const unresolvedByKind = countsByKind(assessed.unresolved);
    items.push({
      modId: String(item.modId),
      mainFileId,
      mainVersion,
      mainName,
      coverage,
      coverageComplete: assessed.coverageComplete,
      complete: assessed.complete,
      candidateCount: assessed.candidates.length,
      unresolvedCount: assessed.unresolved.length,
      candidateCountsByKind: byKind,
      unresolvedCountsByKind: unresolvedByKind,
      candidates: assessed.candidates,
      unresolved: assessed.unresolved,
      coverageProblems: assessed.coverageProblems,
      staleComponentRules: staleRules,
      // Backward-compatible field name used by older diagnostics.
      stalePatchRules: staleRules.filter(id => id.includes(':PATCH:')),
    });
  }

  if (browser) await browser.disconnect().catch(() => {});
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: 'COMPONENT_CLOSURE',
    componentKinds: COMPONENT_KINDS,
    plan: planFile,
    modsDir,
    registry: registryFile,
    relations: relationsFile,
    strict: true,
    targets: items.length,
    complete: items.filter(x => x.complete).length,
    held: items.filter(x => !x.complete).length,
    unresolvedCandidates: items.reduce((n, x) => n + x.unresolvedCount, 0),
    candidateCountsByKind: countsByKind(items.flatMap(x => x.candidates || [])),
    unresolvedCountsByKind: countsByKind(items.flatMap(x => x.unresolved || [])),
    items,
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

  if (tasksFile) {
    const header = ['modId','mainFileId','mainVersion','mainName','problem','kind','candidateKey','family','source','auxModId','fileId','candidateName','requiredHint','optionalHint','installedContext','localMatches','recommendedAction'];
    const lines = [header.join('\t')];
    for (const x of items) {
      for (const p of x.coverageProblems) {
        lines.push([x.modId,x.mainFileId,x.mainVersion,x.mainName,`COVERAGE:${p.source}:${p.status}`,'','','','','','','','','','','','Inspect Nexus source; do not release MAIN until coverage is proven'].map(safeCell).join('\t'));
      }
      for (const c of x.unresolved) {
        lines.push([
          x.modId,x.mainFileId,x.mainVersion,x.mainName,'UNRESOLVED_COMPONENT',c.kind,c.key,c.family,c.source,c.auxModId,c.fileId,c.name,
          c.requiredHint?'YES':'NO',c.optionalHint?'YES':'NO',c.installedContextMatch?'YES':'NO',(c.localMatches||[]).join(' | '),
          'Resolve as REQUIRED / NOT_APPLICABLE / ALREADY_INCLUDED / OBSOLETE in aux-registry v3',
        ].map(safeCell).join('\t'));
      }
    }
    fs.writeFileSync(tasksFile, lines.join('\n') + '\n', 'utf8');
  }

  console.log(JSON.stringify({
    targets: payload.targets,
    complete: payload.complete,
    held: payload.held,
    unresolvedCandidates: payload.unresolvedCandidates,
    candidateCountsByKind: payload.candidateCountsByKind,
    unresolvedCountsByKind: payload.unresolvedCountsByKind,
    outFile,
    tasksFile,
  }, null, 2));
}

main().catch(err => { console.error(`discover-components failed: ${err.message}`); process.exit(1); });
