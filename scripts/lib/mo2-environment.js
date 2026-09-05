'use strict';

const fs = require('fs');
const path = require('path');
const { parseMetaIni } = require('./mo2-reader');
const { KNOWN_FAMILIES, tokens } = require('./patch-discovery');

const PLUGIN_EXT = /\.(?:esp|esm|esl)$/i;

function normalizeName(value) {
  return String(value || '').replace(/\\/g, '/').trim().toLowerCase();
}

function readText(file) {
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function decodeIniValue(value) {
  let v = String(value || '').trim().replace(/^"|"$/g, '');
  const m = v.match(/^@ByteArray\((.*)\)$/i);
  if (m) v = m[1];
  try { return decodeURIComponent(v); } catch { return v; }
}

function parseSelectedProfileText(text) {
  let inGeneral = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inGeneral = /^\[General\]$/i.test(line);
      continue;
    }
    if (!inGeneral && /^\w+\s*=/.test(line) === false) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!['selected_profile', 'selectedprofile', 'selected_profile_name', 'profile'].includes(key)) continue;
    const value = decodeIniValue(line.slice(eq + 1));
    if (value) return value;
  }
  return '';
}

function parseModlistText(text) {
  const entries = [];
  let order = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const marker = line[0];
    const name = ['+', '-', '*'].includes(marker) ? line.slice(1).trim() : line.trim();
    if (!name) continue;
    const separator = marker === '*' || /_separator$/i.test(name);
    const state = separator ? 'SEPARATOR' : marker === '+' ? 'ENABLED' : marker === '-' ? 'DISABLED' : 'UNKNOWN';
    entries.push({ name, marker, state, separator, profileOrder: order++ });
  }
  return entries;
}

function parsePluginsText(text) {
  const entries = [];
  let order = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const enabled = line.startsWith('*');
    const name = enabled ? line.slice(1).trim() : line;
    if (!name || !PLUGIN_EXT.test(name)) continue;
    entries.push({ name, enabled, profileOrder: order++ });
  }
  return entries;
}

function parseLoadOrderText(text) {
  return String(text || '').split(/\r?\n/)
    .map(x => x.replace(/^\uFEFF/, '').trim())
    .filter(x => x && !x.startsWith('#') && PLUGIN_EXT.test(x))
    .map((name, loadOrderIndex) => ({ name, loadOrderIndex }));
}

function listProfileDirs(profilesRoot) {
  if (!profilesRoot || !fs.existsSync(profilesRoot)) return [];
  return fs.readdirSync(profilesRoot, { withFileTypes: true })
    .filter(x => x.isDirectory())
    .map(x => path.join(profilesRoot, x.name))
    .filter(dir => fs.existsSync(path.join(dir, 'modlist.txt')))
    .sort((a, b) => a.localeCompare(b));
}

function resolveProfile({ modsDir, profileDir = '', profileName = '', mo2Root = '' } = {}) {
  const root = mo2Root ? path.resolve(mo2Root) : path.resolve(modsDir || '.', '..');
  const profilesRoot = path.join(root, 'profiles');

  if (profileDir) {
    const dir = path.resolve(profileDir);
    return fs.existsSync(path.join(dir, 'modlist.txt'))
      ? { resolved: true, source: 'EXPLICIT_DIR', name: path.basename(dir), dir, mo2Root: root, profilesRoot, candidates: [dir] }
      : { resolved: false, source: 'EXPLICIT_DIR_MISSING', name: path.basename(dir), dir, mo2Root: root, profilesRoot, candidates: [] };
  }

  const explicitName = profileName || process.env.MO2_PROFILE_NAME || '';
  if (explicitName) {
    const dir = path.join(profilesRoot, explicitName);
    return fs.existsSync(path.join(dir, 'modlist.txt'))
      ? { resolved: true, source: 'EXPLICIT_NAME', name: explicitName, dir, mo2Root: root, profilesRoot, candidates: [dir] }
      : { resolved: false, source: 'EXPLICIT_NAME_MISSING', name: explicitName, dir, mo2Root: root, profilesRoot, candidates: [] };
  }

  const iniCandidates = [path.join(root, 'ModOrganizer.ini'), path.join(root, 'modorganizer.ini')];
  for (const ini of iniCandidates) {
    if (!fs.existsSync(ini)) continue;
    const selected = parseSelectedProfileText(readText(ini));
    if (!selected) continue;
    const dir = path.join(profilesRoot, selected);
    if (fs.existsSync(path.join(dir, 'modlist.txt'))) {
      return { resolved: true, source: 'MODORGANIZER_INI', name: selected, dir, mo2Root: root, profilesRoot, ini, candidates: [dir] };
    }
  }

  const dirs = listProfileDirs(profilesRoot);
  if (dirs.length === 1) {
    return { resolved: true, source: 'UNIQUE_PROFILE', name: path.basename(dirs[0]), dir: dirs[0], mo2Root: root, profilesRoot, candidates: dirs };
  }
  return { resolved: false, source: dirs.length ? 'AMBIGUOUS_PROFILES' : 'NO_PROFILE', name: '', dir: '', mo2Root: root, profilesRoot, candidates: dirs };
}

function scanTopLevelPlugins(modDir) {
  try {
    return fs.readdirSync(modDir, { withFileTypes: true })
      .filter(x => x.isFile() && PLUGIN_EXT.test(x.name))
      .map(x => x.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

function buildEnvironmentGraph({ modsDir, profileDir = process.env.MO2_PROFILE_DIR || '', profileName = process.env.MO2_PROFILE_NAME || '', mo2Root = process.env.MO2_ROOT || '' } = {}) {
  const resolvedModsDir = path.resolve(modsDir || process.env.MO2_MODS_DIR || '.');
  const profile = resolveProfile({ modsDir: resolvedModsDir, profileDir, profileName, mo2Root });
  const modlistFile = profile.resolved ? path.join(profile.dir, 'modlist.txt') : '';
  const pluginsFile = profile.resolved ? path.join(profile.dir, 'plugins.txt') : '';
  const loadorderFile = profile.resolved ? path.join(profile.dir, 'loadorder.txt') : '';
  const modlist = profile.resolved ? parseModlistText(readText(modlistFile)) : [];
  const pluginList = profile.resolved ? parsePluginsText(readText(pluginsFile)) : [];
  const loadOrder = profile.resolved ? parseLoadOrderText(readText(loadorderFile)) : [];

  const modlistByName = new Map(modlist.map(x => [normalizeName(x.name), x]));
  const actual = [];
  if (fs.existsSync(resolvedModsDir)) {
    for (const ent of fs.readdirSync(resolvedModsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      const listEntry = modlistByName.get(normalizeName(name));
      const separator = !!listEntry?.separator || /_separator$/i.test(name);
      const meta = parseMetaIni(path.join(resolvedModsDir, name, 'meta.ini'));
      const state = separator ? 'SEPARATOR' : (listEntry?.state || 'UNLISTED');
      actual.push({
        name,
        state,
        enabled: state === 'ENABLED',
        disabled: state === 'DISABLED',
        separator,
        profileOrder: listEntry?.profileOrder ?? null,
        modId: meta?.modid ? String(meta.modid) : '',
        version: meta?.version || '',
        installationFile: meta?.installationFile || '',
        installedFiles: (meta?.installedFiles || []).map(String),
        plugins: separator ? [] : scanTopLevelPlugins(path.join(resolvedModsDir, name)),
      });
    }
  }
  actual.sort((a, b) => (a.profileOrder ?? Number.MAX_SAFE_INTEGER) - (b.profileOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));

  const actualNames = new Set(actual.map(x => normalizeName(x.name)));
  const missingEntries = modlist.filter(x => !x.separator && !actualNames.has(normalizeName(x.name))).map(x => ({ ...x }));
  const unlistedMods = actual.filter(x => x.state === 'UNLISTED').map(x => x.name);

  const owners = new Map();
  for (const mod of actual) {
    for (const plugin of mod.plugins || []) {
      const k = normalizeName(plugin);
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push({ mod: mod.name, state: mod.state, modId: mod.modId });
    }
  }
  const loadIndex = new Map(loadOrder.map(x => [normalizeName(x.name), x.loadOrderIndex]));
  const profilePlugins = new Map(pluginList.map(x => [normalizeName(x.name), x]));
  const pluginNames = new Set([...owners.keys(), ...profilePlugins.keys(), ...loadIndex.keys()]);
  const plugins = [...pluginNames].map(k => {
    const p = profilePlugins.get(k);
    const ownerList = owners.get(k) || [];
    const displayName = p?.name || loadOrder.find(x => normalizeName(x.name) === k)?.name || ownerList[0]?.plugin || k;
    return {
      name: displayName,
      enabled: p ? !!p.enabled : false,
      inPluginsTxt: !!p,
      loadOrderIndex: loadIndex.has(k) ? loadIndex.get(k) : null,
      owners: ownerList,
      ownerState: ownerList.length === 1 ? ownerList[0].state : ownerList.length > 1 ? 'AMBIGUOUS' : 'UNOWNED',
    };
  }).sort((a, b) => (a.loadOrderIndex ?? Number.MAX_SAFE_INTEGER) - (b.loadOrderIndex ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));

  const summary = {
    profileResolved: profile.resolved,
    profileName: profile.name || '',
    profileSource: profile.source,
    modsTotal: actual.filter(x => !x.separator).length,
    enabledMods: actual.filter(x => x.enabled).length,
    disabledMods: actual.filter(x => x.disabled).length,
    unlistedMods: unlistedMods.length,
    separators: actual.filter(x => x.separator).length,
    pluginsKnown: plugins.length,
    pluginsEnabled: plugins.filter(x => x.enabled).length,
    missingModlistEntries: missingEntries.length,
    ambiguousPluginOwners: plugins.filter(x => x.ownerState === 'AMBIGUOUS').length,
    unownedPlugins: plugins.filter(x => x.ownerState === 'UNOWNED' && x.inPluginsTxt).length,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceOfTruth: ['modlist.txt', 'plugins.txt', 'loadorder.txt', 'mods/*/meta.ini', 'top-level plugin files'],
    uiWarningPolicy: {
      trustedForUpdateDecision: false,
      note: 'MO2 red warning icons and Nexus author metadata warnings are observational only; exact local/Nexus identity is authoritative.',
    },
    modsDir: resolvedModsDir,
    profile: {
      ...profile,
      modlistFile,
      pluginsFile,
      loadorderFile,
      usableForApplicability: profile.resolved && fs.existsSync(modlistFile),
    },
    summary,
    mods: actual,
    missingModlistEntries: missingEntries,
    unlistedMods,
    plugins,
  };
}

function enabledContextNames(graph) {
  if (!graph?.profile?.usableForApplicability) return [];
  const out = [];
  for (const mod of graph.mods || []) {
    if (!mod.enabled || mod.separator) continue;
    out.push(mod.name);
    if (mod.installationFile) out.push(mod.installationFile);
    for (const plugin of mod.plugins || []) out.push(plugin);
  }
  for (const plugin of graph.plugins || []) if (plugin.enabled) out.push(plugin.name);
  return [...new Set(out.filter(Boolean))];
}

function familyRegex(family) {
  const key = String(family || '').toUpperCase();
  const found = KNOWN_FAMILIES.find(([name]) => name === key);
  return found ? found[1] : null;
}

function matchFamilyInEnvironment(graph, family) {
  if (!graph?.profile?.usableForApplicability) return { status: 'UNKNOWN', reason: 'PROFILE_UNRESOLVED', enabledHits: [], disabledHits: [], unknownHits: [] };
  const re = familyRegex(family);
  if (!re) return { status: 'UNKNOWN', reason: 'FAMILY_NOT_CANONICAL', enabledHits: [], disabledHits: [], unknownHits: [] };
  const enabledHits = [];
  const disabledHits = [];
  const unknownHits = [];
  for (const mod of graph.mods || []) {
    if (mod.separator) continue;
    const text = `${mod.name || ''} ${mod.installationFile || ''} ${(mod.plugins || []).join(' ')}`;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    if (mod.state === 'ENABLED') enabledHits.push(mod.name);
    else if (mod.state === 'DISABLED') disabledHits.push(mod.name);
    else unknownHits.push(mod.name);
  }
  for (const miss of graph.missingModlistEntries || []) {
    re.lastIndex = 0;
    if (re.test(miss.name || '')) unknownHits.push(`missing:${miss.name}`);
  }
  for (const plugin of graph.plugins || []) {
    if (!plugin.enabled) continue;
    re.lastIndex = 0;
    if (re.test(plugin.name || '')) enabledHits.push(`plugin:${plugin.name}`);
  }
  if (enabledHits.length) return { status: 'ENABLED', reason: 'ENABLED_COUNTERPART', enabledHits, disabledHits, unknownHits };
  if (unknownHits.length) return { status: 'UNKNOWN', reason: 'COUNTERPART_STATE_UNKNOWN', enabledHits, disabledHits, unknownHits };
  if (disabledHits.length) return { status: 'DISABLED_ONLY', reason: 'COUNTERPART_DISABLED_IN_PROFILE', enabledHits, disabledHits, unknownHits };
  return { status: 'ABSENT', reason: 'COUNTERPART_ABSENT_FROM_PROFILE', enabledHits, disabledHits, unknownHits };
}

function modIdState(graph, modId) {
  const id = String(modId || '');
  if (!id || !graph?.profile?.usableForApplicability) return { status: 'UNKNOWN', hits: [] };
  const hits = (graph.mods || []).filter(x => String(x.modId || '') === id && !x.separator);
  if (hits.some(x => x.enabled)) return { status: 'ENABLED', hits: hits.map(x => x.name) };
  if (hits.some(x => x.state === 'UNLISTED')) return { status: 'UNKNOWN', hits: hits.map(x => x.name) };
  if (hits.some(x => x.disabled)) return { status: 'DISABLED_ONLY', hits: hits.map(x => x.name) };
  return { status: 'ABSENT', hits: [] };
}

function assessCandidateEnvironment(candidate, graph) {
  const base = {
    source: 'ENVIRONMENT_GRAPH',
    resolved: false,
    status: 'UNRESOLVED',
    confidence: 'none',
    reason: graph?.profile?.usableForApplicability ? 'NO_SAFE_INFERENCE' : 'PROFILE_UNRESOLVED',
    evidence: [],
  };
  if (!candidate || !graph?.profile?.usableForApplicability) return base;

  const kind = String(candidate.kind || '').toUpperCase();
  const auxState = candidate.auxModId ? modIdState(graph, candidate.auxModId) : null;
  if (candidate.source === 'REQUIREMENTS_FORWARD' || candidate.requiredHint) {
    if (auxState?.status === 'ENABLED') return { ...base, reason: 'REQUIRED_DEPENDENCY_ENABLED', confidence: 'high', evidence: auxState.hits };
    if (auxState?.status === 'DISABLED_ONLY') return { ...base, reason: 'REQUIRED_DEPENDENCY_DISABLED', confidence: 'high', evidence: auxState.hits };
    if (auxState?.status === 'ABSENT') return { ...base, reason: 'REQUIRED_DEPENDENCY_ABSENT', confidence: 'high', evidence: [] };
    return base;
  }

  if (!['PATCH', 'HOTFIX'].includes(kind)) return base;
  const familyState = matchFamilyInEnvironment(graph, candidate.family);
  if (familyState.status === 'ENABLED') {
    return { ...base, reason: 'COMPAT_COUNTERPART_ENABLED', confidence: 'high', evidence: familyState.enabledHits };
  }
  if (familyState.status === 'DISABLED_ONLY' || familyState.status === 'ABSENT') {
    return {
      source: 'ENVIRONMENT_GRAPH',
      resolved: true,
      status: 'NOT_APPLICABLE',
      confidence: 'high',
      reason: familyState.reason,
      evidence: [...familyState.disabledHits, ...familyState.unknownHits],
    };
  }
  return { ...base, reason: familyState.reason, evidence: familyState.unknownHits || [] };
}

function compactEnvironmentSummary(graph) {
  if (!graph) return null;
  return {
    version: graph.version,
    profileResolved: !!graph.profile?.resolved,
    profileUsableForApplicability: !!graph.profile?.usableForApplicability,
    profileName: graph.profile?.name || '',
    profileSource: graph.profile?.source || 'UNKNOWN',
    summary: graph.summary || {},
    uiWarningTrustedForUpdateDecision: false,
  };
}

module.exports = {
  normalizeName,
  parseSelectedProfileText,
  parseModlistText,
  parsePluginsText,
  parseLoadOrderText,
  resolveProfile,
  buildEnvironmentGraph,
  enabledContextNames,
  matchFamilyInEnvironment,
  modIdState,
  assessCandidateEnvironment,
  compactEnvironmentSummary,
};
