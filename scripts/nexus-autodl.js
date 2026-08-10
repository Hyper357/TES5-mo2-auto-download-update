#!/usr/bin/env node
// Nexus 免费账户自动下载驱动 —— 连接已在 127.0.0.1:9222 监听 CDP 的 Edge/Chrome。
// 子命令:
//   login                     打开 Nexus 登录页（新标签页）
//   whoami                    报告登录态
//   inspect <modId> [substr]  转储某模组 Files 页的文件卡 + 下载控件（学 DOM 用）
//   dl <manifest.tsv>         按清单逐条触发下载（默认 preview，--go 才真点）
// 清单格式（每行）:
//   modId<TAB>名称子串<TAB>期望版本<TAB>备注<TAB>期望fileId
// 选项: --start N --limit N --wait SEC --go --gate
const fs = require('fs');
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

function parseArgs(rest) {
  const out = { start: 0, limit: Infinity, wait: 6, go: false, gate: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--start') out.start = parseInt(rest[++i], 10);
    else if (a === '--limit') out.limit = parseInt(rest[++i], 10);
    else if (a === '--wait') out.wait = parseFloat(rest[++i]);
    else if (a === '--go') out.go = true;
    else if (a === '--gate') out.gate = true;
    else { out._pos = out._pos || []; out._pos.push(a); }
  }
  return out;
}

function parseManifest(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => {
      const [modId, name, ver, note, fileId] = l.split('\t').map(s => (s || '').trim());
      return { modId, name, ver, note, fileId };
    });
}

function normVer(v) {
  if (!v) return '';
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+(?:\.\d+)*)/);
  if (!m) return String(v).trim().toLowerCase();
  return m[1].split('.').map(x => parseInt(x, 10) || 0).join('.');
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

async function findCard(page, modId, nameSub) {
  await page.goto(`https://www.nexusmods.com/${DOMAIN}/mods/${modId}?tab=files`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await sleep(2500);
  await dismissConsent(page);
  // 等待文件卡渲染
  for (let i = 0; i < 15; i++) {
    const cards = await dumpCards(page, nameSub);
    if (cards.length) return { cards, atTab: true };
    await sleep(1500);
  }
  return { cards: await dumpCards(page, nameSub), atTab: true };
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

async function downloadOne(page, e, args) {
  const { cards } = await findCard(page, e.modId, e.name);
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
  return `OK submitted fileId=${card.fileId} ver=${card.version} mo2=${wake || 'unknown'}`;
}

function launchNxm(nxm) {
  return new Promise((res, rej) => {
    // 沿用项目中已验证的 Python subprocess 方式，整个 NXM 作为一个参数传给 handler。
    const py = 'import subprocess,sys; subprocess.run([sys.argv[1],sys.argv[2]], capture_output=True, timeout=20)';
    execFile('py', ['-c', py, NXM_HANDLER, nxm], { windowsHide: true, timeout: 30000 }, (err) =>
      err ? rej(err) : res());
  });
}

function wakeDownload(pattern) {
  return new Promise((res, rej) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', REFRESH_SCRIPT,
    ], { windowsHide: true, timeout: 20000 }, () => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-File', WAKE_SCRIPT, '-Pattern', pattern,
      ], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        if (err) return rej(err);
        res(String(stdout || '').trim());
      });
    });
  });
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });

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
          return {
            signedIn: /sign out|log ?out|登出|注销/i.test(html),
            hasSid: document.cookie.includes('sid_development'),
          };
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
        const entries = parseManifest(manifestPath);
        let i = args.start;
        let done = 0;
        while (i < entries.length && done < (args.limit === Infinity ? entries.length : args.limit)) {
          const e = entries[i];
          try {
            const r = await downloadOne(page, e, args);
            console.log(`[${i}] ${r} | ${e.modId} ${e.name} (${e.note || ''})`);
          } catch (err) {
            console.log(`[${i}] ERROR ${e.modId} ${e.name}: ${err.message}`);
          }
          i++; done++;
          if (i < entries.length && done < (args.limit === Infinity ? entries.length : args.limit)) {
            await sleep((args.wait || 6) * 1000);
          }
        }
        break;
      }
      default:
        console.log('usage: nexus-autodl.js <login|whoami|inspect modId [substr]|dl manifest.tsv> [--go] [--start N] [--limit N] [--wait S]');
    }
  } finally {
    await page.close().catch(() => {});
    await browser.disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
