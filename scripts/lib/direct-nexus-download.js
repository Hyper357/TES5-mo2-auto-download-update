'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function parseSignedNxm(value, { expectedModId = '', expectedFileId = '', expectedGame = '' } = {}) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('nxm://')) {
    const e = new Error('NXM_INVALID: expected nxm:// URL');
    e.code = 'NXM_INVALID';
    throw e;
  }
  let u;
  try { u = new URL(raw); } catch {
    const e = new Error('NXM_INVALID: malformed nxm URL');
    e.code = 'NXM_INVALID';
    throw e;
  }
  const m = String(u.pathname || '').match(/^\/mods\/(\d+)\/files\/(\d+)\/?$/i);
  if (!m) {
    const e = new Error('NXM_INVALID: expected /mods/<id>/files/<id>');
    e.code = 'NXM_INVALID';
    throw e;
  }
  const out = {
    game: String(u.hostname || '').toLowerCase(),
    modId: m[1],
    fileId: m[2],
    key: u.searchParams.get('key') || '',
    expires: u.searchParams.get('expires') || '',
  };
  if (expectedGame && out.game !== String(expectedGame).toLowerCase()) {
    const e = new Error(`NXM_IDENTITY_MISMATCH: game=${out.game}`);
    e.code = 'NXM_IDENTITY_MISMATCH';
    throw e;
  }
  if (expectedModId && out.modId !== String(expectedModId)) {
    const e = new Error(`NXM_IDENTITY_MISMATCH: modId=${out.modId}`);
    e.code = 'NXM_IDENTITY_MISMATCH';
    throw e;
  }
  if (expectedFileId && out.fileId !== String(expectedFileId)) {
    const e = new Error(`NXM_IDENTITY_MISMATCH: fileId=${out.fileId}`);
    e.code = 'NXM_IDENTITY_MISMATCH';
    throw e;
  }
  return out;
}

function nexusHeaders(apiKey, version = '4.1.9-beta.1') {
  return {
    apikey: String(apiKey || '').trim(),
    Accept: 'application/json',
    'User-Agent': `TES5-mo2-auto-download-update/${version}`,
    'Application-Name': 'TES5-mo2-auto-download-update',
    'Application-Version': version,
  };
}

function getJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(url, { headers, timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`HTTP ${res.statusCode}`);
          e.code = 'NEXUS_DOWNLOAD_LINK_HTTP';
          e.statusCode = res.statusCode;
          return reject(e);
        }
        try { resolve(JSON.parse(body)); }
        catch (err) {
          err.code = 'NEXUS_DOWNLOAD_LINK_JSON';
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })));
    req.on('error', reject);
  });
}

async function getDownloadLinks({ game, modId, fileId, apiKey, key = '', expires = '' } = {}) {
  if (!apiKey) throw Object.assign(new Error('NEXUS_API_KEY_MISSING'), { code: 'NEXUS_API_KEY_MISSING' });
  const u = new URL(`https://api.nexusmods.com/v1/games/${encodeURIComponent(game)}/mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}/download_link.json`);
  if (key) u.searchParams.set('key', key);
  if (expires) u.searchParams.set('expires', expires);
  const doc = await getJson(u, { headers: nexusHeaders(apiKey) });
  if (!Array.isArray(doc) || !doc.length) {
    const e = new Error('NEXUS_DOWNLOAD_LINK_EMPTY: API returned no CDN links');
    e.code = 'NEXUS_DOWNLOAD_LINK_EMPTY';
    throw e;
  }
  const links = doc.filter(x => x && typeof x.URI === 'string' && /^https?:\/\//i.test(x.URI));
  if (!links.length) {
    const e = new Error('NEXUS_DOWNLOAD_LINK_EMPTY: API returned no usable URI');
    e.code = 'NEXUS_DOWNLOAD_LINK_EMPTY';
    throw e;
  }
  return links;
}

function sanitizeArchiveName(name, fallback = 'download.7z') {
  let out = path.basename(String(name || fallback)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  out = out.replace(/[. ]+$/g, '');
  return out || fallback;
}

function choosePublishPath(downloadsDir, archiveName, fileId) {
  const safe = sanitizeArchiveName(archiveName, `nexus-${fileId}.7z`);
  let target = path.join(downloadsDir, safe);
  if (!fs.existsSync(target) && !fs.existsSync(`${target}.meta`)) return target;
  const ext = path.extname(safe);
  const base = ext ? safe.slice(0, -ext.length) : safe;
  target = path.join(downloadsDir, `${base}-${fileId}${ext}`);
  let n = 2;
  while (fs.existsSync(target) || fs.existsSync(`${target}.meta`)) {
    target = path.join(downloadsDir, `${base}-${fileId}-${n}${ext}`);
    n++;
  }
  return target;
}

function downloadFile(urlValue, targetPath, { timeoutMs = 120000, maxRedirects = 8 } = {}) {
  const visit = (url, redirectsLeft) => new Promise((resolve, reject) => {
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(url, { headers: { 'User-Agent': 'TES5-mo2-auto-download-update/4.1.9-beta.1' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(Object.assign(new Error('CDN_REDIRECT_LIMIT'), { code: 'CDN_REDIRECT_LIMIT' }));
        return resolve(visit(new URL(res.headers.location, url), redirectsLeft - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(Object.assign(new Error(`CDN_HTTP_${res.statusCode}`), { code: 'CDN_HTTP_ERROR', statusCode: res.statusCode }));
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const out = fs.createWriteStream(targetPath, { flags: 'wx' });
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      res.on('error', err => out.destroy(err));
      out.on('error', err => {
        try { fs.unlinkSync(targetPath); } catch (_) {}
        reject(err);
      });
      out.on('finish', () => resolve({ bytes, contentLength: Number(res.headers['content-length'] || 0) || 0 }));
      res.pipe(out);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('CDN_TIMEOUT'), { code: 'CDN_TIMEOUT' })));
    req.on('error', err => {
      try { fs.unlinkSync(targetPath); } catch (_) {}
      reject(err);
    });
  });
  return visit(new URL(String(urlValue)), maxRedirects);
}

function iniValue(value) {
  return String(value ?? '').replace(/\r?\n/g, '\\n').replace(/\0/g, '');
}

function buildMo2Meta({
  gameName = 'SkyrimSE', modId, fileId, name = '', modName = '', description = '', version = '',
  fileCategory = 0, category = 0,
} = {}) {
  return [
    '[General]',
    `gameName=${iniValue(gameName)}`,
    `modID=${iniValue(modId)}`,
    `fileID=${iniValue(fileId)}`,
    'url=',
    `name=${iniValue(name)}`,
    `description=${iniValue(description)}`,
    `modName=${iniValue(modName || name)}`,
    `version=${iniValue(version || '0.0.0.0')}`,
    'newestVersion=0.0.0.0',
    `fileCategory=${Number(fileCategory) || 0}`,
    `category=${Number(category) || 0}`,
    'repository=Nexus',
    'installed=false',
    'uninstalled=false',
    'paused=false',
    'removed=false',
    '',
  ].join('\r\n');
}

function publishToMo2Downloads({ sourcePath, downloadsDir, archiveName, fileId, metaText } = {}) {
  fs.mkdirSync(downloadsDir, { recursive: true });
  const finalPath = choosePublishPath(downloadsDir, archiveName, fileId);
  const staging = `${finalPath}.publish-${process.pid}-${Date.now()}`;
  const metaTmp = `${finalPath}.meta.tmp-${process.pid}-${Date.now()}`;
  let archivePublished = false;
  try {
    fs.copyFileSync(sourcePath, staging, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(metaTmp, metaText, 'utf8');
    fs.renameSync(staging, finalPath);
    archivePublished = true;
    fs.renameSync(metaTmp, `${finalPath}.meta`);
    return { finalPath, metaPath: `${finalPath}.meta` };
  } catch (err) {
    try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch (_) {}
    try { if (fs.existsSync(metaTmp)) fs.unlinkSync(metaTmp); } catch (_) {}
    if (archivePublished) {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }
    throw err;
  }
}

module.exports = {
  parseSignedNxm,
  nexusHeaders,
  getDownloadLinks,
  sanitizeArchiveName,
  choosePublishPath,
  downloadFile,
  buildMo2Meta,
  publishToMo2Downloads,
};
