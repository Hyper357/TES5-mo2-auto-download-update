// scripts/lib/mo2-reader.js
// MO2 meta.ini, modlist.txt 与 FOMOD Plus 解析模块

const fs = require('fs');
const path = require('path');

function parseMetaIni(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const meta = {
    modid: 0,
    version: '',
    installationFile: '',
    installedFiles: [],
    fomodPlugins: []
  };

  let inGeneral = false;
  let inInstalledFiles = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[')) {
      inGeneral = trimmed === '[General]';
      inInstalledFiles = trimmed === '[installedFiles]';
      continue;
    }

    if (inGeneral) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        const k = trimmed.substring(0, eq).trim();
        const v = trimmed.substring(eq + 1).trim();
        if (k === 'modid') meta.modid = Number(v) || 0;
        else if (k === 'version') meta.version = v;
        else if (k === 'installationFile') meta.installationFile = v;
      }
    } else if (inInstalledFiles) {
      const m = trimmed.match(/^\d+\\fileid=(\d+)/);
      if (m) {
        const fid = Number(m[1]);
        if (fid && !meta.installedFiles.includes(fid)) {
          meta.installedFiles.push(fid);
        }
      }
    } else if (trimmed.includes('FOMOD%20Plus') || trimmed.includes('fomod=')) {
      try {
        const rawJson = decodeURIComponent(trimmed.split('=')[1] || '');
        const parsed = JSON.parse(rawJson);
        if (parsed.steps) {
          for (const s of parsed.steps) {
            if (s.groups) {
              for (const g of s.groups) {
                if (g.plugins) meta.fomodPlugins.push(...g.plugins);
              }
            }
          }
        }
      } catch (_) {}
    }
  }

  return meta;
}

function scanModsDirectory(modsDir) {
  if (!fs.existsSync(modsDir)) return [];
  const entries = fs.readdirSync(modsDir, { withFileTypes: true });
  const rows = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const metaPath = path.join(modsDir, ent.name, 'meta.ini');
    const meta = parseMetaIni(metaPath);
    if (!meta || !meta.modid || meta.modid <= 0) continue;

    rows.push({
      folderName: ent.name,
      modId: meta.modid,
      version: meta.version,
      installationFile: meta.installationFile,
      installedFiles: meta.installedFiles,
      fomodPlugins: meta.fomodPlugins
    });
  }
  return rows;
}

module.exports = {
  parseMetaIni,
  scanModsDirectory
};
