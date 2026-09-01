#!/usr/bin/env node
// 更新检测：扫描 MO2 已装 mod，对比 Nexus API 找出版本过时的项。
// 与 MO2 自带的 Check for Updates 不同，这里直接用 Nexus API 权威判断：
// 已装 fileId 仍是活跃 MAIN(1)/OPTIONAL(3) → 已最新；否则列出最新 MAIN 作为更新目标。
//
// fileId 解析三通道（重要：顶层 version= 字段经常过时，不能用于判断）：
//   1. meta.ini 的 "1\fileid=" 配对（MO2 记录实际安装的 Nexus file ID）
//   2. installationFile 与 API file_name 精确匹配（旧式下载文件名）
//   3. 名称子串匹配（新式文件名如 "AI Overhaul AE 1.9.5 21654 1.9.5 2026-...-xxx.zip"）
//
// 用法:
//   node scripts/check-outdated.js <modsDir> [apiKeyFile] [--json] [--out manifest.tsv]
//     modsDir     MO2 的 mods 目录（含各 mod 的 meta.ini）
//     apiKeyFile  Nexus API key 文件（一行）；缺省时读 NEXUS_API_KEY 环境变量
//     --json      输出机器可读 JSON
//     --out FILE  把过时项写成 dl 可读的 manifest（modId<TAB>名称<TAB>版本<TAB>备注<TAB>fileID<TAB>DOWNLOAD）
//                 注意：--out 输出的是"候选"——仍需人工甄别变体/版本噪音后再 dl
const fs = require('fs');
const path = require('path');
const https = require('https');

function normalizeVer(v) {
  if (!v) return '';
  return String(v).trim().toLowerCase().replace(/^v/, '').replace(/\.0+$/g, '').replace(/\.0+(?=\.)/g, '.');
}

function compareVersions(v1, v2) {
  const n1 = normalizeVer(v1);
  const n2 = normalizeVer(v2);
  if (n1 === n2) return 0;
  const p1 = n1.split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const p2 = n2.split(/[.-]/).map(x => parseInt(x, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 20 });
const CACHE_DIR = path.join(__dirname, '.api_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const modsDir = process.argv[2];
const keyArg = process.argv[3];
const asJson = process.argv.includes('--json');
const outFlag = process.argv.indexOf('--out');
const outFile = outFlag > 0 ? process.argv[outFlag + 1] : null;

function apiGet(modId, key) {
  const cacheFile = path.join(CACHE_DIR, `${modId}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const stats = fs.statSync(cacheFile);
      if (Date.now() - stats.mtimeMs < 24 * 3600 * 1000) {
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
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try {
          const parsed = JSON.parse(data);
          try { fs.writeFileSync(cacheFile, data, 'utf8'); } catch (_) {}
          resolve(parsed);
        } catch { reject(new Error('bad json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

let key = '';
if (keyArg) {
  key = fs.readFileSync(keyArg, 'utf8').trim();
} else if (process.env.NEXUS_API_KEY) {
  key = process.env.NEXUS_API_KEY.trim();
} else {
  console.error('需要 API key：位置参数 apiKeyFile 或 NEXUS_API_KEY 环境变量');
  process.exit(1);
}
if (!modsDir || !fs.existsSync(modsDir)) {
  console.error('modsDir 不存在: ' + modsDir);
  process.exit(1);
}

const rows = [];
for (const dir of fs.readdirSync(modsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const metaPath = path.join(modsDir, dir.name, 'meta.ini');
  if (!fs.existsSync(metaPath)) continue;
  let text;
  try { text = fs.readFileSync(metaPath, 'utf8'); } catch { continue; }
  const getTop = k => { const m = text.match(new RegExp(`^${k}=(.*)$`, 'mi')); return m ? m[1].trim() : ''; };
  const topModId = getTop('modid');
  if (!topModId || topModId === '0') continue;
  let fileId = '';
  for (const m of text.matchAll(/^(\d+)\\modid=(\d+)\s*$/gm)) {
    if (m[2] === topModId) {
      const re = new RegExp('^' + m[1] + '\\\\fileid=(\\d+)\\s*$', 'm');
      const fid = text.match(re);
      if (fid) { fileId = fid[1]; break; }
    }
  }
  if (!fileId) fileId = getTop('fileid');
  rows.push({
    modId: topModId, fileId, name: dir.name,
    installedVersion: getTop('version'), instFile: getTop('installationFile'),
    // 名称子串：去掉 modid/版本/时间戳片段，取可读名（用于 API name 匹配）
    nameSub: getTop('installationFile')
      .replace(/^\d+_/, '').replace(/-?\d{6,}\d*$/g, '').replace(/\s*\d{4}-\d{2}-\d{2}T[\dZ:.-]+/g, '')
      .replace(/[-_]\d+([._-]\d+)*\s*$/, '').replace(/^.*[\\/]/, '').trim()
  });
}
process.stderr.write(`rows=${rows.length}\n`);

(async () => {
  const outdated = [];
  let ok = 0, fail = 0, unresolved = 0;
  let cursor = 0;
  const CONCURRENCY = 8;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) break;
      const r = rows[i];
      let files;
      try {
        files = await apiGet(r.modId, key);
        if (!files || !Array.isArray(files.files)) { fail++; continue; }
      } catch (e) { fail++; continue; }
      ok++;
      // 解析目标 fileId：三通道
      let targetFid = r.fileId;
      let how = '1\\fileid';
      if (!targetFid && r.instFile) {
        const byName = files.files.find(f => f.file_name === r.instFile);
        if (byName) { targetFid = String(byName.file_id); how = 'file_name'; }
      }
      if (!targetFid && r.nameSub) {
        const sub = r.nameSub.toLowerCase();
        const bySub = files.files.find(f => {
          const n = (f.name || '').toLowerCase();
          return n && sub && (n.includes(sub) || sub.includes(n));
        });
        if (bySub) { targetFid = String(bySub.file_id); how = 'name_sub'; }
      }
      if (!targetFid) { unresolved++; continue; }
      const mine = files.files.find(f => String(f.file_id) === String(targetFid));
      if (!mine) { outdated.push({ ...r, fileId: targetFid, how, reason: 'FILE_GONE' }); continue; }
      if (mine.category_id === 1 || mine.category_id === 3) continue; // 仍活跃 MAIN/OPTIONAL

      // 如果当前安装的只是补丁类（UPDATE/PATCH），且没有明确的同名升级包，不跨类别升级主文件
      if (mine.category_id !== 1 && mine.category_id !== 3 && mine.category_name && mine.category_name.toLowerCase().includes('patch')) {
        continue;
      }
      // 变体特征提取与平台/身形严格隔离（SE/AE vs VR, 3BA/CBBE vs BHUNP/UNP）
      const mineFullName = ((mine.name || '') + ' ' + (mine.file_name || '') + ' ' + (r.instFile || '')).toLowerCase();
      const isMineVR = /vr|(vr)/i.test(mineFullName);
      const isMine3BA = /3ba|3bbb|cbbe/i.test(mineFullName);
      const isMineBHUNP = /bhunp|unp/i.test(mineFullName);

      function isCompatibleVariant(targetFile) {
        const tName = ((targetFile.name || '') + ' ' + (targetFile.file_name || '')).toLowerCase();
        const isTargetVR = /vr|(vr)/i.test(tName);
        if (!isMineVR && isTargetVR) return false;
        if (isMineVR && !isTargetVR && /(ae|se)/i.test(tName)) return false;
        if (isMine3BA && /bhunp/i.test(tName) && !/3ba|cbbe/i.test(tName)) return false;
        if (isMineBHUNP && /3ba/i.test(tName) && !/bhunp/i.test(tName)) return false;
        return true;
      }

      // 过时：查找最新同分类/同变体目标
      let latestTarget = null;
      const sameCat = files.files.filter(f => f.category_id === mine.category_id && isCompatibleVariant(f)).sort((a, b) => a.file_id - b.file_id);
      if (sameCat.length && sameCat[sameCat.length - 1].file_id !== mine.file_id) {
        latestTarget = sameCat[sameCat.length - 1];
      } else if (mine.category_id === 1 || mine.category_id === 3 || mine.category_id === 4) {
        // 仅当原本是 MAIN/OPTIONAL/OLD_VERSION 时才允许回退寻找最新 MAIN
        const mains = files.files.filter(f => f.category_id === 1 && isCompatibleVariant(f)).sort((a, b) => a.file_id - b.file_id);
        if (mains.length) latestTarget = mains[mains.length - 1];
      }
      if (!latestTarget) continue;

      // 规则甄别：版本噪音与反向降级判断
      const cmp = compareVersions(r.installedVersion, latestTarget.version);
      let action = 'DOWNLOAD';
      let note = `${mine.category_name || 'OLD'}→v${latestTarget.version}`;

      if (cmp === 0) {
        action = 'SKIP_NOISE';
        note = `版本一致 (${r.installedVersion} == ${latestTarget.version})`;
      } else if (cmp > 0) {
        action = 'SKIP_DOWNGRADE';
        note = `本地版本较新 (${r.installedVersion} > ${latestTarget.version})`;
      }

      outdated.push({
        ...r, fileId: targetFid, how,
        oldCategory: mine.category_name || `id${mine.category_id}`,
        reason: action === 'DOWNLOAD' ? 'OUTDATED' : action,
        action, note,
        latestFileId: latestTarget.file_id,
        latestVersion: latestTarget.version,
      });
      if ((cursor) % 200 === 0 || cursor === rows.length) {
        process.stderr.write(`progress ${Math.min(cursor, rows.length)}/${rows.length}\n`);
      }
    }
  }

  const workers = [];
  for (let c = 0; c < CONCURRENCY; c++) workers.push(worker());
  await Promise.all(workers);
  process.stderr.write(`done ok=${ok} fail=${fail} unresolved=${unresolved} outdated=${outdated.length}\n`);
  if (outFile) {
    const lines = ['# check-outdated 候选清单：先人工甄别变体/版本噪音，再 node nexus-autodl.js dl <此文件> --go --sort small-first'];
    for (const o of outdated) {
      if (!o.latestFileId) continue;
      lines.push(`${o.modId}\t${o.name}\t${o.latestVersion}\t${o.note || o.oldCategory + '→v' + o.latestVersion} [${o.how}]\t${o.latestFileId}\t${o.action || 'DOWNLOAD'}`);
    }
    fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  }
  if (asJson) console.log(JSON.stringify({ checked: rows.length, ok, fail, unresolved, outdated: outdated.length, items: outdated }, null, 2));
  else {
    console.log(`检查 ${rows.length}，过时 ${outdated.length}（fail=${fail} unresolved=${unresolved}）`);
    for (const o of outdated) console.log(`OUTDATED\t${o.modId}\t${o.fileId}[${o.how}]\t${o.oldCategory}\tv${o.installedVersion}\ttarget=${o.latestFileId} v${o.latestVersion}\t${o.name}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
