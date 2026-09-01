#!/usr/bin/env node
// scripts/check-outdated.js
// 更新检测：扫描 MO2 已装 mod，对比 Nexus API 找出版本过时的项。

const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeVer, compareVersions } = require('./lib/semver');
const { scanModsDirectory } = require('./lib/mo2-reader');
const ModProfile = require('./lib/profile');

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const CACHE_DIR = path.join(__dirname, '.api_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const modsDir = process.argv[2];
const keyArg = process.argv[3];
const asJson = process.argv.includes('--json');
const forceRefresh = process.argv.includes('--force-refresh') || process.argv.includes('--no-cache');
const outFlag = process.argv.indexOf('--out');
const outFile = outFlag > 0 ? process.argv[outFlag + 1] : null;

function apiGet(modId, key) {
  const cacheFile = path.join(CACHE_DIR, `${modId}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const stats = fs.statSync(cacheFile);
      if (!forceRefresh && (Date.now() - stats.mtimeMs < 24 * 3600 * 1000)) {
        return Promise.resolve(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
      }
    } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.nexusmods.com',
      path: `/v1/games/skyrimspecialedition/mods/${modId}/files.json`,
      headers: { apikey: key, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 15000,
      agent
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            fs.writeFileSync(cacheFile, body, 'utf8');
            resolve(JSON.parse(body));
          } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

async function main() {
  if (!modsDir) {
    console.error('用法: node check-outdated.js <modsDir> [apiKeyFile] [--json] [--out manifest.tsv]');
    process.exit(1);
  }

  let apiKey = process.env.NEXUS_API_KEY;
  if (keyArg && fs.existsSync(keyArg)) {
    apiKey = fs.readFileSync(keyArg, 'utf8').trim();
  }
  if (!apiKey) {
    console.error('错误: 未找到 Nexus API key (请提供文件或设置 NEXUS_API_KEY 环境变量)');
    process.exit(1);
  }

  const rawMods = scanModsDirectory(modsDir);
  console.error(`rows=${rawMods.length}`);

  // 全局画像指纹分析
  const profile = ModProfile.analyzeFromMods(rawMods);
  console.error(`[Profile] 自动推导整合包画像: 平台=${profile.platform}, 身形=${profile.bodyType}`);

  const rows = rawMods.map(m => ({
    modId: String(m.modId),
    name: m.folderName,
    installedVersion: m.version,
    instFile: m.installationFile,
    fileId: m.installedFiles[0] ? String(m.installedFiles[0]) : null,
    installedFiles: m.installedFiles.map(String),
    fomodPlugins: m.fomodPlugins
  }));

  const results = [];
  let ok = 0, fail = 0, unresolved = 0, outdated = 0;
  const CONCURRENCY = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const r = rows[i];
      if (i > 0 && i % 400 === 0) console.error(`progress ${i}/${rows.length}`);

      try {
        const data = await apiGet(r.modId, apiKey);
        const files = data.files || [];
        if (files.length === 0) {
          results.push({ ...r, reason: 'NO_FILES' });
          unresolved++;
          continue;
        }

        // 解析本地已装 fileId
        let mine = null;
        if (r.fileId) {
          mine = files.find(f => String(f.file_id) === String(r.fileId));
        }
        if (!mine && r.instFile) {
          mine = files.find(f => f.file_name === r.instFile);
        }

        if (!mine) {
          results.push({ ...r, reason: 'UNRESOLVED_LOCAL_FILE' });
          unresolved++;
          continue;
        }

        // 挑选目标升级文件：同分类优先 + 兼容性画像过滤
        const sameCategoryFiles = files.filter(f => f.category_id === mine.category_id);
        const candidatePool = sameCategoryFiles.length > 0 ? sameCategoryFiles : (
          [1, 3, 4].includes(mine.category_id) ? files.filter(f => f.category_id === 1) : []
        );

        // 画像与变体过滤
        const validCandidates = candidatePool.filter(f => profile.isCompatible(f, r));
        validCandidates.sort((a, b) => new Date(b.uploaded_time || 0) - new Date(a.uploaded_time || 0));
        const latestTarget = validCandidates[0];

        if (!latestTarget) {
          ok++;
          continue;
        }

        if (latestTarget.file_id === mine.file_id) {
          ok++;
          continue;
        }

        const cmp = compareVersions(latestTarget.version, r.installedVersion || mine.version);
        let action = 'DOWNLOAD';
        let note = `${mine.category_name || 'OLD'}→v${latestTarget.version}`;

        if (cmp === 0) {
          action = 'SKIP_NOISE';
          note = `版本一致 (${r.installedVersion} == ${latestTarget.version})`;
        } else if (cmp < 0) {
          action = 'SKIP_DOWNGRADE';
          note = `本地版本更新 (${r.installedVersion} > ${latestTarget.version})`;
        } else {
          outdated++;
        }

        results.push({
          ...r,
          outdated: cmp > 0,
          reason: cmp > 0 ? 'OUTDATED' : action,
          action,
          note,
          latestFileId: latestTarget.file_id,
          latestVersion: latestTarget.version,
          latestName: latestTarget.name
        });
        ok++;
      } catch (err) {
        fail++;
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.error(`progress ${rows.length}/${rows.length}`);
  console.error(`done ok=${ok} fail=${fail} unresolved=${unresolved} outdated=${outdated}`);

  // 汉化依赖闭合检查
  const chsMap = new Map();
  for (const item of results) {
    const isChs = /chs|chinese|汉化|中文/i.test(item.name);
    if (isChs) chsMap.set(item.modId, item);
  }

  for (const item of results) {
    if (item.action === 'DOWNLOAD') {
      const isChs = /chs|chinese|汉化|中文/i.test(item.name);
      if (!isChs) {
        const pairedChs = Array.from(chsMap.values()).find(c => c.name.toLowerCase().includes(item.name.toLowerCase().slice(0, 10)));
        if (pairedChs && pairedChs.action !== 'DOWNLOAD' && compareVersions(item.latestVersion, pairedChs.installedVersion) > 0) {
          item.action = 'HOLD_NO_CHS';
          item.note = `[挂起: 汉化未跟进 ${pairedChs.installedVersion} < ${item.latestVersion}]`;
        }
      }
    }
  }

  if (outFile) {
    const tsvLines = results.map(o => `${o.modId}\t${o.name}\t${o.latestVersion || ''}\t${o.note || ''}\t${o.latestFileId || ''}\t${o.action || 'DOWNLOAD'}`);
    fs.writeFileSync(outFile, tsvLines.join('\n') + '\n', 'utf8');
  }

  if (asJson) {
    console.log(JSON.stringify({ total: rows.length, ok, fail, unresolved, outdated, items: results }, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
