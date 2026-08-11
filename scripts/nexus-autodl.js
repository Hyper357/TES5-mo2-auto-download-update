#!/usr/bin/env node
// Nexus 免费账户自动下载驱动 —— 连接已在 127.0.0.1:9222 监听 CDP 的 Edge/Chrome。
// 子命令:
//   login                     打开 Nexus 登录页（新标签页）
//   whoami                    报告登录态
//   inspect <modId> [substr]  转储某模组 Files 页的文件卡 + 下载控件（学 DOM 用）
//   dl <manifest.tsv>         按清单逐条触发下载（默认 preview，--go 才真点）
//   verify <manifest.tsv>     核对 Downloads 中的 meta、归档和 7-Zip 完整性
// 清单格式（每行）:
//   modId<TAB>名称子串<TAB>期望版本<TAB>备注<TAB>期望fileId<TAB>动作
// 动作可选：DOWNLOAD / MANUAL / HOLD_*；非 DOWNLOAD 行不会被误触发。
// 选项: --start N --limit N --wait SEC --go --gate --json --redownload
//       --downloads DIR --sevenzip PATH
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CDP = 'http://127.0.0.1:9222';
const DOMAIN = 'skyrimspecialedition';
// 可移植调用：项目内运行时使用相对路径；从 GitHub 克隆后使用环境变量指向实际 MO2。
const NXM_HANDLER = process.env.MO2_NXM_HANDLER
  || path.resolve(__dirname, '..', '..', 'mo2', 'nxmhandler.exe');
const WAKE_SCRIPT = process.env.MO2_WAKE_SCRIPT
  || path.resolve(__dirname, 'wake-mo2-download.ps1');
const REFRESH_SCRIPT = process.env.MO2_REFRESH_SCRIPT
  || path.resolve(__dirname, 'refresh-mo2-downloads.ps1');
const DOWNLOADS_DIR = process.env.MO2_DOWNLOADS_DIR
  || path.resolve(__dirname, '..', '..', 'mo2', 'downloads');
const SEVENZIP = process.env.MO2_7Z
  || process.env.SEVENZIP
  || (process.platform === 'win32' ? 'C:\\Program Files\\7-Zip\\7z.exe' : '7z');
// Nexus API key：优先 --api-key-file / NEXUS_API_KEY，其次仓库相邻 tools/.nexus_api_key。
// 绝不打印。
let API_KEY = (() => {
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
  for (const cand of [path.resolve(__dirname, '..', 'tools', '.nexus_api_key'),
    path.resolve(__dirname, '..', '..', 'tools', '.nexus_api_key')]) {
    try { return fs.readFileSync(cand, 'utf8').trim(); } catch { /* 继续 */ }
  }
  return '';
})();

function nexusApi(pathName, apiKeyOverride) {
  return new Promise((resolve, reject) => {
    const key = (apiKeyOverride || API_KEY || '').trim();
    if (!key) return reject(new Error('Nexus API key 缺失：--api-key-file / tools/.nexus_api_key / NEXUS_API_KEY'));
    execFile('curl', ['-s', '-H', `apikey: ${key}`, '-H', 'Accept: application/json',
      `https://api.nexusmods.com/v1/games/${DOMAIN}/mods/${pathName}`],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`API 非 JSON 响应: ${String(stdout).slice(0, 120)}`)); }
      });
  });
}

// 判定文件名是否为补丁/汉化候选。返回分类或 null。
function classifyAuxFile(name, version) {
  const n = (name || '').toLowerCase();
  if (/(chinese|中文|汉化|chs|^cn[\s_-]|cn$)/.test(n)) return 'TRANSLATION';
  if (/(patch|fix|compat|修复|兼容|补丁)/.test(n)) return 'PATCH';
  if (/translation|translate/.test(n)) return 'TRANSLATION';
  return null;
}

// 主 MOD 的补丁/汉化扫描：拉 files.json，按名称关键词分类，输出候选表。
// 局限（如实标注）：Nexus 开放 API 无 search/requirements/translations 端点，
// 只能扫描同一 modId 下的文件卡；跨 mod 的独立翻译页/补丁中心需页面核验。
async function scanAuxFiles(modId, installedFileIds, apiKeyOverride) {
  const files = await nexusApi(`${modId}/files.json`, apiKeyOverride);
  if (!files || !Array.isArray(files.files)) return [];
  const rows = [];
  const seen = new Set();
  for (const f of files.files) {
    if (f.category_id === 7) continue; // ARCHIVED 跳过
    const kind = classifyAuxFile(f.name, f.version);
    if (!kind) continue;
    const key = `${f.file_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const installed = installedFileIds && installedFileIds.has(String(f.file_id));
    rows.push({
      kind, fileId: f.file_id, version: f.version || '',
      category: f.category_name || '', name: f.name || '',
      installed,
    });
  }
  // 同类只取非 ARCHIVED 的最新一个，按 fileId 升序（fileId 大 ≈ 新）
  const byKind = {};
  for (const r of rows) {
    if (!byKind[r.kind]) byKind[r.kind] = [];
    byKind[r.kind].push(r);
  }
  const out = [];
  for (const kind of Object.keys(byKind)) {
    const list = byKind[kind].sort((a, b) => a.fileId - b.fileId);
    const latest = list[list.length - 1];
    out.push({ ...latest, olderCount: list.length - 1 });
  }
  return out.sort((a, b) => (a.kind === 'TRANSLATION' ? -1 : 0) - (b.kind === 'TRANSLATION' ? -1 : 0) || b.fileId - a.fileId);
}

// 从已下载的 Patch Hub 归档中提取 fomod/ModuleConfig.xml，解析出真实 FOMOD 选项
// （插件名 + 条件）。返回 [{ name, group, condition }]，或空数组。
function parseFomodOptions(archivePath, sevenzip, workDir) {
  return new Promise(resolve => {
    if (!archivePath || !fs.existsSync(archivePath)) return resolve([]);
    const tmp = workDir || path.join(os.tmpdir(), 'patchpicker-' + process.pid);
    fs.mkdirSync(tmp, { recursive: true });
    execFile(sevenzip, ['x', '-y', '-o' + tmp, archivePath, 'fomod/*'], { windowsHide: true, timeout: 60000 }, (err) => {
      if (err) return resolve([]);
      const candidates = [];
      const walk = d => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, f.name);
          if (f.isDirectory()) walk(p);
          else if (/ModuleConfig\.xml$/i.test(f.name)) candidates.push(p);
        }
      };
      try { walk(tmp); } catch { return resolve([]); }
      if (!candidates.length) return resolve([]);
      const out = [];
      for (const mc of candidates) {
        let xml;
        try { xml = fs.readFileSync(mc, 'utf8'); } catch { continue; }
        // 提取 <plugin name="..."> 及其条件关键字
        for (const m of xml.matchAll(/<plugin\s+name="([^"]+)"[^>]*>/g)) out.push({ name: m[1], group: path.basename(path.dirname(mc)), condition: '' });
        for (const m of xml.matchAll(/<dependency\s+file="([^"]+)"/g)) {
          const dep = m[1];
          const hit = out.find(o => o.condition === '' && o.name.toLowerCase().includes(dep.toLowerCase().split('.')[0]));
          if (hit) hit.condition = dep;
        }
      }
      // 清理临时目录
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 保留 */ }
      resolve([...new Map(out.map(o => [o.name, o])).values()]);
    });
  });
}
// 用本地维护的表扩展 patchscan 的扫描范围。格式（TSV，每行）：
//   主modId<TAB>附属modId<TAB>PATCH|TRANSLATION<TAB>备注
// 返回: Map<主modId, Array<{modId, kind, note}>>
function loadSeriesMap(seriesFile) {
  const map = new Map();
  if (!seriesFile || !fs.existsSync(seriesFile)) return map;
  for (const line of fs.readFileSync(seriesFile, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [mainId, auxId, kind, note] = line.split('\t').map(s => (s || '').trim());
    if (!mainId || !auxId) continue;
    if (!map.has(mainId)) map.set(mainId, []);
    map.get(mainId).push({ modId: auxId, kind: kind === 'TRANSLATION' ? 'TRANSLATION' : 'PATCH', note: note || '' });
  }
  return map;
}

// 扫描系列关系表中的附属 mod（独立汉化/补丁页），复用 scanAuxFiles 的文件卡分类。
async function scanSeriesMods(seriesMap, mainModId, installedFileIds, apiKeyOverride) {
  const aux = seriesMap.get(String(mainModId)) || [];
  const out = [];
  for (const a of aux) {
    try {
      const files = await nexusApi(`${a.modId}/files.json`, apiKeyOverride);
      if (!files || !Array.isArray(files.files)) continue;
      const latest = files.files
        .filter(f => f.category_id !== 7 && (a.kind === 'TRANSLATION' ? classifyAuxFile(f.name, f.version) === 'TRANSLATION' : true))
        .sort((x, y) => x.file_id - y.file_id);
      if (!latest.length) continue;
      const f = latest[latest.length - 1];
      const installed = installedFileIds && installedFileIds.has(String(f.file_id));
      out.push({
        kind: a.kind, modId: a.modId, fileId: f.file_id, version: f.version || '',
        category: f.category_name || '', name: f.name || '', note: a.note, installed,
      });
    } catch { /* API 失败跳过该附属 */ }
  }
  return out;
}

function parseArgs(rest) {
  const out = {
    start: 0, limit: Infinity, wait: 6, go: false, gate: false,
    json: false, redownload: false, downloads: DOWNLOADS_DIR, sevenzip: SEVENZIP,
    installedDir: null, apiKeyFile: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--start') out.start = parseInt(rest[++i], 10);
    else if (a === '--limit') out.limit = parseInt(rest[++i], 10);
    else if (a === '--wait') out.wait = parseFloat(rest[++i]);
    else if (a === '--go') out.go = true;
    else if (a === '--gate') out.gate = true;
    else if (a === '--json') out.json = true;
    else if (a === '--redownload') out.redownload = true;
    else if (a === '--downloads') out.downloads = path.resolve(rest[++i]);
    else if (a === '--sevenzip') out.sevenzip = rest[++i];
    else if (a === '--installed-dir') out.installedDir = path.resolve(rest[++i]);
    else if (a === '--api-key-file') out.apiKeyFile = path.resolve(rest[++i]);
    else if (a === '--modlist') out.modlist = path.resolve(rest[++i]);
    else if (a === '--only-enabled') out.onlyEnabled = true;
    else if (a === '--out') out.out = path.resolve(rest[++i]);
    else if (a === '--interval') out.interval = parseInt(rest[++i], 10);
    else if (a === '--stall-after') out.stallAfter = parseInt(rest[++i], 10);
    else if (a === '--timeout') out.timeout = parseInt(rest[++i], 10);
    else if (a === '--sort') out.sort = rest[++i];
    else if (a === '--series-file') out.seriesFile = path.resolve(rest[++i]);
    else if (a === '--work-dir') out.workDir = path.resolve(rest[++i]);
    else if (a === '--reconnect') out.reconnect = true;
    else { out._pos = out._pos || []; out._pos.push(a); }
  }
  return out;
}

// 扫描 MO2 已安装模组目录，建立 modId -> 已安装 fileId 的映射。
// 权威字段是 meta.ini 的 "1\fileid="（MO2 记录实际安装的 Nexus file ID）；
// 顶层的 "version=" 字段经常是旧值，不能用于判断“是否已是最新”。
// 注意：部分条目没有 "1\fileid="（MO2 未刷新），此时回退查 downloads 目录中
// 同 modId 的 .meta 文件（MO2 安装后归档通常保留在 downloads，fileID 精确）。
function loadInstalledFileIds(installedDir, downloadsDir) {
  const map = new Map(); // modId -> Set<fileId>
  const add = (modId, fileId) => {
    if (!map.has(modId)) map.set(modId, new Set());
    map.get(modId).add(fileId);
  };
  if (!installedDir || !fs.existsSync(installedDir)) return map;
  for (const dir of fs.readdirSync(installedDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const metaPath = path.join(installedDir, dir.name, 'meta.ini');
    if (!fs.existsSync(metaPath)) continue;
    let text;
    try { text = fs.readFileSync(metaPath, 'utf8'); } catch { continue; }
    // 形如: 1\modid=12345  与  1\fileid=67890（同一编号前缀成对出现）
    let any = false;
    for (const m of text.matchAll(/^(\d+)\\modid=(\d+)\s*$/gm)) {
      const key = m[1];
      const modId = m[2];
      const fid = text.match(new RegExp(`^${key}\\\\fileid=(\\d+)\\s*$`, 'm'));
      if (!fid) continue;
      add(modId, fid[1]);
      any = true;
    }
    // 回退1：顶层 modid= + 顶层 fileid=（部分 meta 有）
    if (!any) {
      const topModId = text.match(/^modid=(\d+)\s*$/m);
      const topFid = text.match(/^fileid=(\d+)\s*$/mi);
      if (topModId && topFid) { add(topModId[1], topFid[1]); any = true; }
    }
    // 回退2：顶层 modid= + downloads 目录中该 modId 的 .meta fileID
    // （MO2 的 "1\fileid" 偶发缺失，但安装来源归档仍在 downloads，fileID 可信）
    if (!any && downloadsDir && fs.existsSync(downloadsDir)) {
      const topModId = text.match(/^modid=(\d+)\s*$/m);
      if (topModId) {
        for (const f of fs.readdirSync(downloadsDir)) {
          if (!f.endsWith('.meta') || f.endsWith('.unfinished.meta')) continue;
          let mt;
          try { mt = readMeta(path.join(downloadsDir, f)); } catch { continue; }
          if (String(mt.modId) === topModId[1] && mt.fileId) add(topModId[1], mt.fileId);
        }
        if (map.has(topModId[1])) any = true;
      }
    }
  }
  return map;
}

// 扫描 MO2 已安装模组目录，返回每项的详情：
// { modId, fileId, name(目录名), installedVersion, enabled(经 modlist.txt 判断), archiveMissing }
// 用途：rebuild 子命令 —— 生成"已装但 downloads 缺归档"的候选清单，由用户筛选后下载。
function scanInstalledMods(installedDir, downloadsDir, modlistPath) {
  const rows = [];
  const dlFileIds = new Set();
  if (downloadsDir && fs.existsSync(downloadsDir)) {
    for (const f of fs.readdirSync(downloadsDir)) {
      if (!f.endsWith('.meta') || f.endsWith('.unfinished.meta')) continue;
      let mt;
      try { mt = readMeta(path.join(downloadsDir, f)); } catch { continue; }
      if (mt.fileId) dlFileIds.add(String(mt.fileId));
    }
  }
  // 启用状态：modlist.txt 第一行 = 左侧底部 = 高优先级；+ 开头 = 启用
  const enabled = new Set();
  if (modlistPath && fs.existsSync(modlistPath)) {
    for (const line of fs.readFileSync(modlistPath, 'utf8').split('\n')) {
      if (line.startsWith('+')) enabled.add(line.slice(1).trim());
    }
  }
  if (!installedDir || !fs.existsSync(installedDir)) return rows;
  for (const dir of fs.readdirSync(installedDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const metaPath = path.join(installedDir, dir.name, 'meta.ini');
    if (!fs.existsSync(metaPath)) continue;
    let text;
    try { text = fs.readFileSync(metaPath, 'utf8'); } catch { continue; }
    const getTop = key => {
      const m = text.match(new RegExp(`^${key}=(.*)$`, 'mi'));
      return m ? m[1].trim() : '';
    };
    const topModId = getTop('modid');
    if (!topModId || topModId === '0') continue; // 无 Nexus 链接的本地 mod
    let fileId = '';
    for (const m of text.matchAll(/^(\d+)\\modid=(\d+)\s*$/gm)) {
      if (m[2] === topModId) {
        const fid = text.match(new RegExp(`^${m[1]}\\\\fileid=(\\d+)\\s*$`, 'm'));
        if (fid) { fileId = fid[1]; break; }
      }
    }
    if (!fileId) fileId = getTop('fileid');
    rows.push({
      modId: topModId,
      fileId,
      name: dir.name,
      installedVersion: getTop('version'),
      enabled: enabled.has(dir.name),
      archiveMissing: !fileId || !dlFileIds.has(String(fileId)),
    });
  }
  return rows;
}

function parseManifest(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => {
      const [modId, name, ver, note, fileId, action] = l.split('\t').map(s => (s || '').trim());
      return { modId, name, ver, note, fileId, action: action || 'DOWNLOAD' };
    });
}

function normVer(v) {
  if (!v) return '';
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/);
  if (!m) return String(v).trim().toLowerCase();
  const parts = m[1].split('.').map(x => parseInt(x, 10) || 0);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

function readMeta(file) {
  const text = fs.readFileSync(file, 'utf8');
  const get = key => {
    const m = text.match(new RegExp(`^${key}=(.*)$`, 'mi'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  };
  return {
    modId: get('modID'),
    fileId: get('fileID'),
    name: get('name'),
    version: get('version'),
    text,
  };
}

function listMetaFiles(downloadsDir) {
  if (!fs.existsSync(downloadsDir)) return [];
  return fs.readdirSync(downloadsDir)
    .filter(name => name.endsWith('.meta') && !name.endsWith('.unfinished.meta'))
    .map(name => path.join(downloadsDir, name));
}

function findExistingArchive(entry, downloadsDir) {
  for (const metaPath of listMetaFiles(downloadsDir)) {
    let meta;
    try { meta = readMeta(metaPath); } catch { continue; }
    if (String(meta.modId) !== String(entry.modId) || String(meta.fileId) !== String(entry.fileId)) continue;
    const archivePath = metaPath.slice(0, -'.meta'.length);
    const unfinishedPath = `${archivePath}.unfinished`;
    const stat = fs.existsSync(archivePath) ? fs.statSync(archivePath) : null;
    return {
      metaPath,
      archivePath,
      unfinishedPath,
      meta,
      exists: !!stat && stat.isFile() && stat.size > 0,
      size: stat ? stat.size : 0,
      hasUnfinished: fs.existsSync(unfinishedPath),
    };
  }
  return null;
}

function testArchive(archivePath, sevenzip) {
  return new Promise(resolve => {
    if (!fs.existsSync(archivePath)) return resolve({ ok: false, code: null, reason: 'MISSING_ARCHIVE' });
    execFile(sevenzip, ['t', '-y', archivePath], {
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    }, (err) => {
      if (err && err.code === 'ENOENT') return resolve({ ok: false, code: null, reason: 'SEVENZIP_NOT_FOUND' });
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        reason: err ? 'ARCHIVE_TEST_FAILED' : 'OK' });
    });
  });
}

async function verifyEntry(entry, args) {
  if (!entry.fileId) return { status: 'HOLD_NO_FILE_ID', modId: entry.modId, fileId: '', note: 'manifest lacks exact file ID' };
  const found = findExistingArchive(entry, args.downloads);
  if (!found) return { status: 'MISSING_META', modId: entry.modId, fileId: entry.fileId, note: 'no matching .meta' };
  if (!found.exists) {
    return {
      status: 'INCOMPLETE', modId: entry.modId, fileId: entry.fileId,
      archive: found.archivePath, size: found.size, unfinished: found.hasUnfinished,
    };
  }
  const expectedVersion = normVer(entry.ver);
  const actualVersion = normVer(found.meta.version);
  if (String(found.meta.modId) !== String(entry.modId) || String(found.meta.fileId) !== String(entry.fileId)) {
    return { status: 'META_MISMATCH', modId: entry.modId, fileId: entry.fileId, archive: found.archivePath };
  }
  if (expectedVersion && actualVersion && expectedVersion !== actualVersion) {
    return { status: 'VERSION_MISMATCH', modId: entry.modId, fileId: entry.fileId, expected: entry.ver, actual: found.meta.version, archive: found.archivePath };
  }
  const zip = await testArchive(found.archivePath, args.sevenzip);
  return {
    status: zip.ok ? (found.hasUnfinished ? 'VERIFIED_WITH_RESIDUAL' : 'VERIFIED') : `VERIFY_${zip.reason}`,
    modId: entry.modId, fileId: entry.fileId, version: found.meta.version,
    archive: found.archivePath, size: found.size, unfinished: found.hasUnfinished, sevenZip: zip.code,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 点掉 Nexus 的 cookie 同意横幅（Allow all / Accept all / 允许）
async function dismissConsent(page) {
  try {
    const hit = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(b => {
          const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
          return /^(allow all|accept all|allow|accept|deny|agree|允许所有|同意)$/i.test(t);
        });
      if (btn) { btn.click(); return (btn.innerText || '').trim(); }
      return null;
    });
    if (hit) await sleep(1200);
    return hit;
  } catch (e) { return null; }
}

// 收集当前页所有文件卡：{name, version, category, fileId, hasNxm, nxmHref, downloadBtn}
async function dumpCards(page, substr) {
  return await page.evaluate((sub) => {
    const out = [];
    const norm = t => (t || '').replace(/\s+/g, ' ').trim();
    // 候选：新版 file-card / 任意带 data-file-id 的元素
    let nodes = Array.from(document.querySelectorAll('[data-file-id]'));
    // Nexus 2026 页面使用 <dt class="file-expander-header" data-id="..."></dt>
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('dt.file-expander-header[data-id]'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('.file-card'));
    if (!nodes.length) nodes = Array.from(document.querySelectorAll('tr.file, .file-row'));
    for (const el of nodes) {
      const txt = norm(el.innerText);
      const fileId = el.getAttribute('data-file-id') || el.getAttribute('data-id') || '';
      const name = norm(el.getAttribute('data-name') || el.querySelector('.file-card-name, [class*="file-card-name"], h4, .file-name, p')?.innerText || '');
      const ver = norm(el.getAttribute('data-version') || el.querySelector('.file-card-version, [class*="file-card-version"], .version')?.innerText || '');
      const cat = norm(el.querySelector('.file-category, [class*="file-category"]')?.innerText || '');
      // nxm 链接
      const nxm = el.querySelector('a[href^="nxm:"]');
      const dlBtn = Array.from(el.querySelectorAll('a,button')).find(b =>
        /download/i.test(norm(b.innerText)) || /下载/i.test(norm(b.innerText)) || b.hasAttribute('data-href'));
      const row = {
        name: name || txt.slice(0, 80),
        version: ver,
        category: cat,
        fileId,
        hasNxm: !!nxm,
        nxmHref: nxm ? nxm.getAttribute('href') : '',
        downloadText: dlBtn ? norm(dlBtn.innerText).slice(0, 60) : '',
        downloadHref: dlBtn ? (dlBtn.getAttribute('href') || dlBtn.getAttribute('data-href') || '') : '',
        sample: txt.slice(0, 200),
      };
      if (!sub || row.name.toLowerCase().includes(sub.toLowerCase())) out.push(row);
    }
    return out;
  }, substr || '');
}

async function findCard(page, modId, nameSub, expectedFileId) {
  await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await sleep(2500);
  await dismissConsent(page);
  // 等待文件卡渲染
  for (let i = 0; i < 15; i++) {
    const cards = await dumpCards(page, expectedFileId ? '' : nameSub);
    const exact = expectedFileId
      ? cards.filter(c => String(c.fileId) === String(expectedFileId))
      : cards;
    if (exact.length) return { cards: exact, atTab: true };
    await sleep(1500);
  }
  const cards = await dumpCards(page, expectedFileId ? '' : nameSub);
  const exact = expectedFileId
    ? cards.filter(c => String(c.fileId) === String(expectedFileId))
    : cards;
  return { cards: exact, atTab: true };
}

// 打开选中文件的下载模态框并提取 nxm:// 链接（免费用户专用路径）
async function extractNxm(page, fileId) {
  const got = await page.evaluate((fid) => {
    const norm = t => (t || '').replace(/\s+/g, ' ').trim();
    // 页面里可能已存在 nxm 链接
    const existing = document.querySelector('a[href^="nxm:"]');
    if (existing) return { href: existing.getAttribute('href') };
    // 否则点开下载模态框：按钮文案含 Download/下载 且属于该文件卡
    const card = document.querySelector(`[data-file-id="${fid}"]`) || document.querySelector('.file-card');
    if (!card) return { error: 'no-card' };
    const btn = Array.from(card.querySelectorAll('a,button')).find(b => {
      const t = norm(b.innerText);
      return /download|下载|slow/i.test(t) && !/nxm/i.test(b.getAttribute('href') || '');
    });
    if (!btn) return { error: 'no-dl-btn' };
    btn.click();
    return { clicked: true };
  }, fileId);
  if (got.href) return got.href;
  if (got.error) return null;
  // 模态框弹出后取 nxm 链接
  await sleep(2500);
  const modal = await page.evaluate(() => {
    const a = document.querySelector('a[href^="nxm:"]');
    return a ? a.getAttribute('href') : null;
  });
  return modal;
}

// 新版 Nexus 的 nmm=1 页面把短时 nxm:// 放在 nexus-download-page[download-url] 属性中。
// 只在内存中读取并立即交给 MO2，不打印、不保存签名链接。
async function extractNxmFromNmmPage(page, modId, fileId) {
  await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files&file_id=${fileId}&nmm=1`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  for (let i = 0; i < 12; i++) {
    const nxm = await page.evaluate(() => {
      const el = document.querySelector('mod-file-download[download-url]')
        || document.querySelector('nexus-download-page[download-url]')
        || document.querySelector('[download-url][is-nmm-download]');
      const href = el?.getAttribute('download-url') || '';
      return href.startsWith('nxm://') ? href : '';
    });
    if (nxm) return nxm;
    await sleep(500);
  }
  return null;
}

async function downloadOne(page, e, args, installedMap) {
  if (e.action && e.action !== 'DOWNLOAD') {
    return `SKIP_ACTION ${e.action} (${e.note || 'manual review'})`;
  }
  // 变体防护：若本地已安装同一 modId 的不同 fileId（=不同变体），拒绝下载。
  // 典型事故：mod 有两个 MAIN（如 3BA 与 BHUNP），按上传时间排序取“最新”会拿错变体。
  if (installedMap && e.modId && e.fileId) {
    const installed = installedMap.get(String(e.modId));
    if (installed && installed.size && !installed.has(String(e.fileId))) {
      return `VARIANT-MISMATCH targetFileId=${e.fileId} installedFileIds=[${[...installed].join(',')}] — 目标与本地已装变体不一致，禁止下载（如需更换变体请先处理本地安装）`;
    }
  }
  const existing = findExistingArchive(e, args.downloads);
  if (existing && existing.exists && !args.redownload) {
    return `SKIP_DUPLICATE fileId=${e.fileId} size=${existing.size} residualUnfinished=${existing.hasUnfinished} archive=${path.basename(existing.archivePath)}`;
  }
  const { cards } = await findCard(page, e.modId, e.name, e.fileId);
  if (!cards.length) return `NOT-FOUND (${e.name})`;
  const card = cards[0];
  if (e.fileId && String(card.fileId) !== String(e.fileId)) {
    return `VERIFY-FAIL expectFileId=${e.fileId} cardFileId=${card.fileId} (${card.name})`;
  }
  const cardVer = normVer(card.version);
  const expectVer = normVer(e.ver);
  if (expectVer && cardVer && cardVer !== expectVer) {
    return `VERIFY-FAIL expect=${e.ver} card=${card.version} (${card.name})`;
  }
  if (card.category && !/main|optional|misc/i.test(card.category) && !args.gate) {
    return `CATEGORY-WARN (${card.category}) — pass --gate to override`;
  }
  if (!args.go) {
    return `PREVIEW would-click fileId=${card.fileId} ver=${card.version} cat=${card.category} nxm=${card.hasNxm}`;
  }
  // 真实触发：新版 Nexus 通过精确 nmm=1 文件页生成短时 nxm://。
  // 旧版页面仍保留直接/模态框提取作为回退。
  let nxm = await extractNxmFromNmmPage(page, e.modId, card.fileId);
  if (!nxm) nxm = card.nxmHref;
  if (!nxm) nxm = await extractNxm(page, card.fileId);
  if (!nxm) return 'NO-NXM-EXTRACTED (open page — may need manual click)';
  // 交给 OS 的 nxm 协议处理器（MO2 nxmhandler）——绕过浏览器外部协议弹窗
  await launchNxm(nxm);
  const wake = await wakeDownload(e.name);
  return `SUBMITTED fileId=${card.fileId} ver=${card.version} mo2=${wake.wake || 'unknown'} refresh=${wake.refresh || 'unknown'}`;
}

function launchNxm(nxm) {  return new Promise((res, rej) => {
    // 整个 NXM 作为一个参数传给 handler，并把 handler 的退出码传出来。
    // 不使用 cmd /c start，避免签名中的 & 被命令解释器拆开。
    const py = 'import subprocess,sys; r=subprocess.run([sys.argv[1],sys.argv[2]], capture_output=True, timeout=20); print(r.returncode); sys.exit(r.returncode or 0)';
    execFile('py', ['-c', py, NXM_HANDLER, nxm], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return rej(err);
      res({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function wakeDownload(pattern) {
  return new Promise((res, rej) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', REFRESH_SCRIPT,
    ], { windowsHide: true, timeout: 20000 }, (refreshErr, refreshOut) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', WAKE_SCRIPT, '-Pattern', pattern,
      ], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        // “ROW_NOT_FOUND” 只表示暂时没有可唤醒的 UI 行；NXM 已交给 handler，不能把它伪装成提交失败。
        if (err && err.code === 'ENOENT') return rej(err);
        res({
          refresh: String(refreshOut || '').trim() || (refreshErr ? 'REFRESH_ERROR' : 'UNKNOWN'),
          wake: String(stdout || '').trim() || (err ? 'WAKE_ERROR' : 'UNKNOWN'),
        });
      });
    });
  });
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const needsBrowser = new Set(['login', 'whoami', 'inspect', 'consent', 'html', 'files', 'raw', 'dl']).has(cmd);
  let browser = null;
  let page = null;
  if (needsBrowser) {
    const puppeteer = require('puppeteer-core');
    try {
      browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
    } catch (connectErr) {
      // --reconnect：CDP 断连时自动用独立 Edge 配置重启浏览器会话（登录态持久化在 user-data-dir）。
      if (!args.reconnect) throw connectErr;
      console.log('CDP 不可达，--reconnect 尝试重启浏览器会话…');
      const edge = process.env.MO2_EDGE
        || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      const userData = process.env.MO2_EDGE_USERDATA
        || path.join(os.homedir(), '.claude', 'nexus-autodl-edge');
      // 用 cmd /c start 启动独立 Edge 实例（与 nexus-edge.cmd 相同语义）。
      // 直接 spawn Edge 会被已运行的实例复用进程，--remote-debugging-port 被忽略。
      const args2 = [
        `--user-data-dir=${userData}`, '--remote-debugging-port=9222',
        '--disable-extensions', '--no-first-run', '--no-default-browser-check',
        '--new-window', `https://www.nexusmods.com/${DOMAIN}`,
      ];
      const { spawn } = require('child_process');
      await new Promise((res, rej) => {
        spawn('cmd', ['/c', 'start', '""', edge, ...args2], { windowsHide: true, stdio: 'ignore' }).on('error', rej);
        // 最多等 25 秒让 CDP 端口就绪
        const deadline = Date.now() + 25000;
        const poll = async () => {
          try {
            browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
            console.log('浏览器会话已重启（CDP 9222）');
          } catch {
            if (Date.now() > deadline) return rej(new Error('浏览器会话重启超时'));
            await sleep(1000);
            return poll();
          }
        };
        poll();
      });
    }
    page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 950 });
  }

  try {
    switch (cmd) {
      case 'login': {
        await page.goto('https://www.nexusmods.com/users/sign-in', { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('LOGIN-OPEN — 在浏览器窗口里登录 Nexus，然后运行 whoami');
        break;
      }
      case 'whoami': {
        await page.goto(`https://www.nexusmods.com/${DOMAIN}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const st = await page.evaluate(() => {
          const html = document.body ? document.body.innerText : '';
          // 2026 版 Nexus 把用户菜单折叠成图标按钮，"Sign out" 不在 innerText 中；
          // 因此除了文本正则，还要检查 authenticated 标记 / 用户菜单按钮 / sid cookie。
          const hasSignOut = /sign out|log ?out|登出|注销/i.test(html);
          const authMark = /authenticated/i.test(document.documentElement.outerHTML);
          const hasUserMenu = !!document.querySelector(
            '[aria-label*="profile" i], [aria-label*="menu" i], [class*="user-menu" i], [class*="userMenu" i]'
          );
          const hasSidCookie = document.cookie.split(';').some(c => c.trim().startsWith('sid'));
          const signedIn = hasSignOut || authMark || (hasUserMenu && hasSidCookie);
          return { signedIn, hasSignOut, authMark, hasUserMenu, hasSid: hasSidCookie };
        });
        console.log(JSON.stringify(st));
        break;
      }
      case 'inspect': {
        const modId = rest[0], sub = rest[1];
        await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
          waitUntil: 'networkidle0', timeout: 90000,
        });
        await sleep(2500);
        await dismissConsent(page);
        await sleep(1200);
        const cards = await dumpCards(page, sub);
        console.log(JSON.stringify(cards, null, 2));
        break;
      }
      case 'consent': {
        const modId = rest[0] || '142266';
        await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
          waitUntil: 'domcontentloaded', timeout: 90000,
        });
        await sleep(3000);
        const d = await page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a.btn'))
            .map(b => ({ tag: b.tagName, txt: (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 50), vis: !!(b.offsetWidth || b.offsetHeight) }))
            .filter(x => x.txt && x.vis)
            .slice(0, 60);
          const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: (f.src || '').slice(0, 120), id: f.id }));
          const shadowHosts = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot).length;
          const cookieVals = document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
          return { allButtons, iframes, shadowHosts, cookieVals };
        });
        console.log(JSON.stringify(d, null, 2));
        break;
      }
      case 'html': {
        const modId = rest[0], sub = rest[1] || 'Version history';
        await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
          waitUntil: 'domcontentloaded', timeout: 90000,
        });
        await sleep(2000);
        await dismissConsent(page);
        await sleep(3500);
        const d = await page.evaluate((sub) => {
          const walker = (el, depth) => {
            if (depth <= 0) return;
            if (el.innerText && el.innerText.includes(sub)) return el;
            for (const c of el.children) {
              const r = walker(c, depth - 1);
              if (r) return r;
            }
            return null;
          };
          const target = walker(document.body, 30);
          if (!target) return { found: false };
          let html = target.outerHTML;
          return { found: true, tag: target.tagName, cls: (target.className || '').toString().slice(0, 80), html: html.slice(0, 4500) };
        }, sub);
        console.log(JSON.stringify(d, null, 2));
        break;
      }
      case 'files': {
        const modId = rest[0];
        await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
          waitUntil: 'domcontentloaded', timeout: 90000,
        });
        await sleep(2000);
        await dismissConsent(page);
        await sleep(4000);
        const d = await page.evaluate(() => {
          const norm = t => (t || '').replace(/\s+/g, ' ').trim();
          const filey = Array.from(document.querySelectorAll('[data-file-id], [data-fileid], [id*="file" i], [class*="file" i]'))
            .slice(0, 40)
            .map(el => ({ tag: el.tagName, id: (el.id || '').slice(0, 40), cls: norm(el.className).slice(0, 60), txt: norm(el.innerText).slice(0, 90) }));
          const nxm = Array.from(document.querySelectorAll('a[href^="nxm:"]')).slice(0, 10)
            .map(a => ({ href: a.getAttribute('href').slice(0, 110), txt: norm(a.innerText).slice(0, 50) }));
          const dlLinks = Array.from(document.querySelectorAll('a[href*="file_id"], a[href*="/download"], a[href*="dl="]')).slice(0, 10)
            .map(a => ({ href: (a.getAttribute('href') || '').slice(0, 110), txt: norm(a.innerText).slice(0, 50) }));
          const body = document.body ? document.body.innerText : '';
          const sections = ['MAIN FILES', 'OPTIONAL FILES', 'MISCELLANEOUS', 'OLD FILES', 'ARCHIVED FILES'].map(s => ({ s, at: body.indexOf(s) }));
          return { url: location.href, bodyLen: body.length, filey, nxm, dlLinks, sections, bodyTail: body.slice(-1500) };
        });
        console.log(JSON.stringify(d, null, 2));
        break;
      }
      case 'raw': {
        const modId = rest[0];
        await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
          waitUntil: 'networkidle0', timeout: 90000,
        });
        await sleep(2500);
        // 点掉 cookie 同意横幅
        const dismissed = await dismissConsent(page);
        await sleep(1500);
        const d = await page.evaluate(() => {
          const body = document.body ? document.body.innerText : '';
          const fileLinks = Array.from(document.querySelectorAll('a[href*="file_id"], a[href*="mods/"], a[href*="/files/"]'))
            .slice(0, 30).map(a => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 80) }));
          const cardNodes = Array.from(document.querySelectorAll('[data-file-id], .file-card, [class*="file-card"], [class*="FileRow"], [class*="file-row"]')).slice(0, 15)
            .map(el => ({ cls: (el.className || '').toString().slice(0, 100), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 150) }));
          return {
            url: location.href,
            title: document.title,
            bodyLen: body.length,
            bodyHead: body.slice(0, 900),
            fileLinks,
            cardNodes,
            hasConsentWall: /responsible use of your data/i.test(body),
          };
        });
        d.consentDismissed = dismissed;
        console.log(JSON.stringify(d, null, 2));
        break;
      }
      case 'dl': {
        const manifestPath = rest[0];
        let entries = parseManifest(manifestPath);
        // --sort small-first：先用 API 批量预取各目标的文件大小（KB），小文件先提交。
        // SKSE/框架类多为几百 KB，大型材质包可达 GB 级；小文件先下可避免队列被大文件堵住。
        if (args.sort === 'small-first') {
          if (!args.apiKeyFile && !API_KEY) {
            console.log('--sort small-first 需要 Nexus API key（--api-key-file 或 tools/.nexus_api_key），跳过排序');
          } else {
            const key = args.apiKeyFile ? fs.readFileSync(args.apiKeyFile, 'utf8').trim() : API_KEY;
            const withSize = [];
            for (const e of entries) {
              if (!e.modId || !e.fileId || (e.action && e.action !== 'DOWNLOAD')) { withSize.push({ e, sizeKb: Infinity }); continue; }
              try {
                const files = await nexusApi(`${e.modId}/files.json`, key);
                const f = (files.files || []).find(x => String(x.file_id) === String(e.fileId));
                withSize.push({ e, sizeKb: f ? f.size_kb : Infinity });
              } catch { withSize.push({ e, sizeKb: Infinity }); }
            }
            entries = withSize.sort((a, b) => a.sizeKb - b.sizeKb).map(x => x.e);
            if (!args.json) console.log(`--sort small-first: ${entries.length} 项已按大小排序（API 预取）`);
          }
        }
        const installedMap = loadInstalledFileIds(args.installedDir, args.downloads);
        const results = [];
        let i = args.start;
        let done = 0;
        while (i < entries.length && done < (args.limit === Infinity ? entries.length : args.limit)) {
          const e = entries[i];
          try {
            const r = await downloadOne(page, e, args, installedMap);
            const result = { index: i, modId: e.modId, fileId: e.fileId, name: e.name, action: e.action, result: r };
            results.push(result);
            if (!args.json) console.log(`[${i}] ${r} | ${e.modId} ${e.name} (${e.note || ''})`);
          } catch (err) {
            const result = { index: i, modId: e.modId, fileId: e.fileId, name: e.name, action: e.action, result: `ERROR ${err.message}` };
            results.push(result);
            if (!args.json) console.log(`[${i}] ${result.result} | ${e.modId} ${e.name}`);
          }
          i++; done++;
          if (i < entries.length && done < (args.limit === Infinity ? entries.length : args.limit)) {
            await sleep((args.wait || 6) * 1000);
          }
        }
        if (args.json) console.log(JSON.stringify(results, null, 2));
        break;
      }
      case 'verify': {
        const manifestPath = rest[0];
        if (!manifestPath) throw new Error('verify requires a manifest.tsv');
        const entries = parseManifest(manifestPath);
        const results = [];
        for (const entry of entries) {
          if (entry.action && entry.action !== 'DOWNLOAD') {
            results.push({ status: `SKIP_ACTION_${entry.action}`, modId: entry.modId, fileId: entry.fileId, name: entry.name, note: entry.note });
            continue;
          }
          results.push({ ...(await verifyEntry(entry, args)), name: entry.name });
        }
        if (args.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach(r => console.log(`${r.status}\t${r.modId}\t${r.fileId || ''}\t${r.archive || ''}\t${r.size || 0}`));
        break;
      }
      case 'installed': {
        // 审计：对照本地已装 fileId 与 manifest 目标 fileId，区分真缺口与已装最新。
        // 用法: nexus-autodl.js installed <manifest.tsv> --installed-dir <MO2 mods> [--downloads DIR]
        const manifestPath = rest[0];
        if (!manifestPath) throw new Error('installed requires a manifest.tsv');
        const entries = parseManifest(manifestPath);
        const installedMap = loadInstalledFileIds(args.installedDir, args.downloads);
        const results = [];
        for (const e of entries) {
          if (e.action && e.action !== 'DOWNLOAD') {
            results.push({ status: `SKIP_ACTION_${e.action}`, modId: e.modId, fileId: e.fileId, name: e.name });
            continue;
          }
          const installed = e.modId ? installedMap.get(String(e.modId)) : undefined;
          if (!installed || !installed.size) {
            results.push({ status: 'NOT_INSTALLED', modId: e.modId, fileId: e.fileId, name: e.name });
            continue;
          }
          if (installed.has(String(e.fileId))) {
            results.push({ status: 'ALREADY_INSTALLED', modId: e.modId, fileId: e.fileId, name: e.name, installedFileIds: [...installed] });
          } else {
            results.push({ status: 'VARIANT_MISMATCH', modId: e.modId, fileId: e.fileId, name: e.name, installedFileIds: [...installed], note: '目标 fileID 与本地已装变体不一致' });
          }
        }
        if (args.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach(r => console.log(`${r.status}\t${r.modId}\t${r.fileId || ''}\t${r.name}\t${r.installedFileIds ? r.installedFileIds.join(',') : ''}`));
        break;
      }
      case 'monitor': {
        // 监控 downloads 中的 .unfinished：观察是否增长，卡死判定。
        // 用法: nexus-autodl.js monitor [--downloads DIR] [--interval SEC] [--stall-after MIN] [--timeout MIN] [--json]
        const interval = args.interval || 15;      // 采样间隔（秒）
        const stallAfter = args.stallAfter || 3;    // 无增长超过 N 分钟判卡死
        const timeoutMin = args.timeout || 60;      // 总监控时长（分钟）
        const started = Date.now();
        const last = new Map(); // 文件名 -> { size, ts }
        const stalled = new Set();
        const done = new Set();
        let poll = true;
        const sample = () => {
          const files = fs.existsSync(args.downloads) ? fs.readdirSync(args.downloads) : [];
          const report = [];
          for (const f of files) {
            if (!f.endsWith('.unfinished')) continue;
            const stat = fs.statSync(path.join(args.downloads, f));
            const prev = last.get(f);
            if (prev && prev.size === stat.size) {
              const mins = (Date.now() - prev.ts) / 60000;
              if (mins >= stallAfter) {
                stalled.add(f);
                report.push({ file: f, size: stat.size, status: 'STALLED', minsSinceGrowth: Math.round(mins * 10) / 10 });
              }
            } else {
              last.set(f, { size: stat.size, ts: Date.now() });
              stalled.delete(f);
              report.push({ file: f, size: stat.size, status: 'GROWING' });
            }
          }
          // 已完成的（.unfinished 消失但之前存在）
          for (const f of last.keys()) {
            if (!files.includes(f) && !done.has(f)) {
              done.add(f);
              report.push({ file: f, size: last.get(f).size, status: 'COMPLETED' });
            }
          }
          return report;
        };
        if (!args.json) console.log(`monitor: 每 ${interval}s 采样，${stallAfter} 分钟无增长判卡死，总时长 ${timeoutMin} 分钟`);
        while (poll) {
          const report = sample();
          if (report.length) {
            if (args.json) console.log(JSON.stringify({ t: Math.round((Date.now() - started) / 1000), report }, null, 0));
            else report.forEach(r => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${r.status}\t${r.size}\t${r.file}`));
          }
          if ((Date.now() - started) > timeoutMin * 60000) poll = false;
          else await sleep(interval * 1000);
        }
        const stalledList = [...stalled];
        if (args.json) console.log(JSON.stringify({ done: 'monitor-timeout', stalled: stalledList }, null, 2));
        else console.log(`监控结束：卡死 ${stalledList.length} 个${stalledList.length ? '（' + stalledList.join('; ') + '）' : ''}`);
        break;
      }
      case 'rebuild': {
        // 重建归档库：扫描已装 mod，输出 downloads 缺归档的清单（不自动下载）。
        // 用法: nexus-autodl.js rebuild [--installed-dir MO2 mods] [--downloads DIR]
        //       [--modlist PATH] [--only-enabled] [--out manifest.tsv] [--json]
        if (!args.installedDir) throw new Error('rebuild requires --installed-dir <MO2 mods>');
        const modlistPath = args.modlist || (args.installedDir ? path.resolve(args.installedDir, '..', 'profiles', 'Default', 'modlist.txt') : '');
        const rows = scanInstalledMods(args.installedDir, args.downloads, modlistPath);
        const missing = rows.filter(r => r.archiveMissing && (!args.onlyEnabled || r.enabled));
        const present = rows.filter(r => !r.archiveMissing);
        const out = [];
        for (const r of missing) {
          const enabledFlag = r.enabled ? 'E' : 'D';
          if (r.fileId) {
            out.push(`${r.modId}\t${r.name}\t${r.installedVersion}\t归档缺失[${enabledFlag}]\t${r.fileId}\tDOWNLOAD`);
          } else {
            out.push(`${r.modId}\t${r.name}\t${r.installedVersion}\t归档缺失[${enabledFlag}]且meta无fileID，需人工从Nexus页面补fileID\t\tMANUAL`);
          }
        }
        if (args.out) {
          const header = '# modId<TAB>名称<TAB>已装版本<TAB>备注<TAB>期望fileID<TAB>动作 (rebuild 生成，人工筛选后喂给 dl)\n';
          fs.writeFileSync(args.out, header + out.join('\n') + '\n', 'utf8');
        }
        if (args.json) {
          console.log(JSON.stringify({ total: rows.length, present: present.length, missing: missing.length, out: args.out, rows: missing }, null, 2));
        } else {
          console.log(`已装 mod: ${rows.length} | 归档已有: ${present.length} | 归档缺失: ${missing.length}${args.out ? ` → 已写 ${args.out}` : ''}`);
          if (args.out) console.log('（先人工筛选，再 node nexus-autodl.js dl <文件> --go）');
          else missing.slice(0, 50).forEach(r => console.log(`${r.enabled ? '+' : '-'} ${r.modId}#${r.fileId} v${r.installedVersion}  ${r.name}`));
        }
        break;
      }
      case 'patchscan': {
        // 补丁/汉化候选扫描：对 manifest 中每个主 MOD，列出其文件卡里的
        // PATCH / TRANSLATION 候选（按名称关键词分类），供人工勾选后并入下载清单。
        // 用法: nexus-autodl.js patchscan <manifest.tsv> [--installed-dir MO2 mods]
        const manifestPath = rest[0];
        if (!manifestPath) throw new Error('patchscan requires a manifest.tsv');
        const entries = parseManifest(manifestPath);
        const installedMap = loadInstalledFileIds(args.installedDir, args.downloads);
        const seriesMap = loadSeriesMap(args.seriesFile);
        const results = [];
        for (const e of entries) {
          if (e.action && e.action !== 'DOWNLOAD') {
            results.push({ status: 'SKIP_ACTION', modId: e.modId, name: e.name, action: e.action });
            continue;
          }
          let aux;
          try {
            const installed = e.modId ? installedMap.get(String(e.modId)) : undefined;
            const keyFile = args.apiKeyFile ? fs.readFileSync(args.apiKeyFile, 'utf8').trim() : '';
            aux = await scanAuxFiles(e.modId, installed, keyFile);
            const seriesAux = await scanSeriesMods(seriesMap, e.modId, installed, keyFile);
            aux = aux.concat(seriesAux);
          } catch (err) {
            results.push({ status: 'API_ERROR', modId: e.modId, name: e.name, error: err.message });
            continue;
          }
          if (!aux.length) {
            results.push({ status: 'NO_AUX', modId: e.modId, name: e.name, note: '文件卡中无补丁/汉化候选（跨 mod 翻译页需页面核验）' });
            continue;
          }
          for (const a of aux) {
            results.push({
              status: a.installed ? 'ALREADY_INSTALLED' : 'CANDIDATE',
              kind: a.kind, modId: e.modId, fileId: a.fileId, version: a.version,
              category: a.category, name: a.name, olderCount: a.olderCount,
            });
          }
        }
        if (args.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach(r => {
          const line = [r.status, r.kind || '', r.modId || '', r.fileId || '', r.version || '', r.name || '', r.note || ''].join('\t');
          console.log(line);
        });
        break;
      }
      case 'patchpicker': {
        // Patch Hub 选项匹配：拉取 Patch Hub 文件描述中的补丁选项列表，与本地 modlist
        // 已装模组名匹配，输出“建议勾选/无需勾选”清单。匹配基于名称关键词，仅供人工确认。
        // 用法: nexus-autodl.js patchpicker <manifest.tsv> [--modlist PATH] [--api-key-file PATH]
        const manifestPath = rest[0];
        if (!manifestPath) throw new Error('patchpicker requires a manifest.tsv');
        const entries = parseManifest(manifestPath);
        const modlistPath = args.modlist || (args.installedDir ? path.resolve(args.installedDir, '..', 'profiles', 'Default', 'modlist.txt') : '');
        let installedNames = [];
        if (fs.existsSync(modlistPath)) {
          installedNames = fs.readFileSync(modlistPath, 'utf8').split('\n')
            .filter(l => l.startsWith('+'))
            .map(l => l.slice(1).trim())
            .filter(Boolean);
        }
        const keyFile = args.apiKeyFile ? fs.readFileSync(args.apiKeyFile, 'utf8').trim() : '';
        const normName = s => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '').trim();
        const installedNorm = installedNames.map(n => normName(n));
        const results = [];
        for (const e of entries) {
          if (e.action && e.action !== 'DOWNLOAD') { results.push({ status: 'SKIP_ACTION', modId: e.modId, name: e.name }); continue; }
          try {
            // 优先：本地已有该 fileID 归档 → 解析 FOMOD 真实选项
            let options = [];
            if (e.fileId) {
              const found = findExistingArchive(e, args.downloads);
              if (found && found.exists) options = await parseFomodOptions(found.archivePath, args.sevenzip, args.workDir);
            }
            let desc = '';
            let fname = '';
            if (!options.length) {
              const files = await nexusApi(`${e.modId}/files.json`, keyFile);
              const f = (files.files || []).find(x => String(x.file_id) === String(e.fileId))
                || (files.files || []).filter(x => x.category_id !== 7).sort((a, b) => a.file_id - b.file_id).pop();
              desc = f ? (f.description || '') : '';
              fname = f ? f.name : '';
              // 从描述提取候选选项：列表项 [*]、- 、数字. 、或独立成行的文字
              const lines = desc.replace(/<[^>]+>/g, '\n').split(/\r?\n/)
                .map(l => l.replace(/^[\s*•\-–\d.)]+/, '').trim())
                .filter(l => l.length >= 3 && l.length <= 80 && !/^(http|www|patreon|discord|youtube)/i.test(l));
              options = lines.map(l => ({ name: l, group: 'desc', condition: '' }));
            }
            if (!options.length) { results.push({ status: 'NO_OPTIONS', modId: e.modId, fileId: e.fileId, name: e.name }); continue; }
            const suggestions = [];
            const unselected = [];
            for (const opt of options) {
              const on = normName(opt.name);
              if (!on) continue;
              const hit = installedNames.find(n => {
                const nn = normName(n);
                if (!nn) return false;
                return (on.length > 4 && nn.includes(on)) || (nn.length > 4 && on.includes(nn));
              });
              if (hit) suggestions.push({ option: opt.name, group: opt.group, condition: opt.condition, matchedInstalled: hit });
              else unselected.push(opt.name);
            }
            results.push({ status: 'SUGGESTIONS', modId: e.modId, fileId: e.fileId, name: e.name, file: fname, source: options.length && options[0].group !== 'desc' ? 'fomod' : 'desc', suggestions, unselected });
          } catch (err) {
            results.push({ status: 'API_ERROR', modId: e.modId, name: e.name, error: err.message });
          }
        }
        if (args.json) console.log(JSON.stringify(results, null, 2));
        else results.forEach(r => {
          console.log(`== ${r.modId} ${r.name} ${r.file || ''} [${r.source || ''}] → ${r.status}${r.error ? ' ' + r.error : ''}`);
          (r.suggestions || []).forEach(s => console.log(`  [建议勾选] ${s.option}  ← 命中已装: ${s.matchedInstalled}${s.condition ? ' (dep: ' + s.condition + ')' : ''}`));
          if (r.unselected && r.unselected.length) console.log(`  [未匹配] ${r.unselected.join(' | ')}`);
        });
        break;
      }
      default:
        console.log('usage: nexus-autodl.js <login|whoami|inspect modId [substr]|dl manifest.tsv|verify manifest.tsv|installed manifest.tsv|patchscan manifest.tsv|patchpicker manifest.tsv|rebuild|monitor> [--go] [--start N] [--limit N] [--wait S] [--json] [--redownload] [--downloads DIR] [--sevenzip PATH] [--installed-dir MO2_MODS_DIR] [--api-key-file PATH] [--series-file PATH] [--modlist PATH] [--only-enabled] [--out PATH] [--sort small-first] [--reconnect] [--work-dir PATH] [--interval SEC] [--stall-after MIN] [--timeout MIN]');
    }
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
