#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function load(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function safe(v) { return String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim(); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function keyOf(modId, fileId) { return `${String(modId)}:${String(fileId || '')}`; }

function compactMainOption(o, item) {
  return {
    modId: String(item.modId),
    fileId: String(o.fileId || ''),
    name: o.name || '',
    fileName: o.fileName || '',
    version: o.version || '',
    category: o.category || 'Main Files',
    description: o.description || '',
    branchKey: o.branchKey || '',
    tags: o.tags || [],
    current: !!o.current,
    recommended: String(o.fileId || '') === String(item.manualReview?.recommendedFileId || ''),
    environmentScore: o.environmentScore || 0,
    environmentMatch: o.environmentMatch || '',
    selectable: !!o.fileId,
  };
}

function compactPatchCandidate(c, mainModId) {
  const modId = String(c.auxModId || (c.source === 'SAME_PAGE_FILE' ? mainModId : '') || '');
  return {
    key: c.key || '', family: c.family || 'GENERAL', source: c.source || '',
    modId, fileId: String(c.fileId || ''), version: c.version || '', name: c.name || '',
    evidence: c.evidence || '', installedContextMatch: !!c.installedContextMatch,
    localMatches: c.localMatches || [],
    selectable: !!(modId && c.fileId),
  };
}

function htmlTemplate(payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TES5 MO2 自动更新 · 人工决策中心</title>
<style>
:root{font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:dark;background:#101418;color:#e8edf2}
*{box-sizing:border-box}body{margin:0;background:#101418}.wrap{max-width:1180px;margin:auto;padding:28px}.hero{background:#171d24;border:1px solid #2b3541;border-radius:16px;padding:22px;margin-bottom:18px}.hero h1{margin:0 0 8px;font-size:25px}.muted{color:#9caaba}.summary{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}.pill{background:#222b35;border:1px solid #344252;padding:7px 11px;border-radius:999px}.danger{color:#ffb4ab}.good{color:#9be7a6}.warn{color:#ffd180}.card{background:#171d24;border:1px solid #2b3541;border-radius:16px;margin:16px 0;overflow:hidden}.head{padding:18px 20px;border-bottom:1px solid #2b3541;display:flex;justify-content:space-between;gap:12px}.body{padding:18px 20px}.section{margin:18px 0}.section h3{font-size:15px;margin:0 0 10px;color:#c7d3df}.option{display:block;border:1px solid #32404f;border-radius:12px;padding:12px;margin:8px 0;background:#12171d}.option.recommended{border-color:#7397c2}.option.current{box-shadow:inset 3px 0 #6fcf97}.row{display:flex;align-items:flex-start;gap:10px}.meta{font-size:12px;color:#9caaba;margin-top:5px}.desc{font-size:13px;color:#c4ced8;margin-top:7px;line-height:1.45}.tag{display:inline-block;font-size:11px;background:#26313c;border-radius:999px;padding:3px 7px;margin:3px 4px 0 0}.patch{border:1px solid #32404f;border-radius:12px;padding:12px;margin:10px 0}.patch select{background:#11171c;color:#e8edf2;border:1px solid #455466;border-radius:8px;padding:7px}.actions{position:sticky;bottom:0;background:rgba(16,20,24,.96);backdrop-filter:blur(8px);border-top:1px solid #2b3541;padding:14px 0;display:flex;gap:10px;align-items:center}.btn{border:0;border-radius:10px;padding:10px 15px;font-weight:600;cursor:pointer}.primary{background:#88aee0;color:#0b1117}.secondary{background:#293440;color:#e8edf2}.btn:disabled{opacity:.45;cursor:not-allowed}.status{font-size:13px;color:#aab8c5}.link{color:#9bc1f1;text-decoration:none}.empty{padding:30px;text-align:center;color:#9caaba}.blocker{background:#30231c;border:1px solid #67452e;border-radius:10px;padding:9px;margin:8px 0;color:#ffd4b3}
</style></head>
<body><div class="wrap"><div class="hero"><h1>🎛️ MO2 人工决策中心</h1><div class="muted">简单 MOD 已交给自动流水线。这里只处理多分支、多 Patch、或 AI 不确定的项目。</div><div class="summary" id="summary"></div></div><div id="root"></div>
<div class="actions"><button class="btn secondary" id="save">保存选择</button><button class="btn primary" id="download">下载所有已确认项</button><span class="status" id="status"></span></div></div>
<script>window.REVIEW_DATA=${json};</script>
<script>
const D=window.REVIEW_DATA; const root=document.getElementById('root'); const statusEl=document.getElementById('status');
const state={decisions:{}};
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function summary(){document.getElementById('summary').innerHTML='<span class="pill">待复核 '+D.items.length+'</span><span class="pill">多分支 '+D.counts.variant+'</span><span class="pill">Patch 未闭合 '+D.counts.patch+'</span><span class="pill">其他不确定 '+D.counts.other+'</span>';}
function decision(id){return state.decisions[id]||(state.decisions[id]={patches:{}})}
function render(){summary(); if(!D.items.length){root.innerHTML='<div class="card empty">没有需要人工复核的项目 🎉</div>';return;} root.innerHTML='';
 for(const it of D.items){const c=document.createElement('div');c.className='card';let b='';
 b+='<div class="head"><div><b>'+h(it.localName||it.mainName||('Mod '+it.modId))+'</b><div class="meta">modId '+h(it.modId)+' · '+h(it.action||'REVIEW')+'</div></div><a class="link" target="_blank" href="https://www.nexusmods.com/skyrimspecialedition/mods/'+encodeURIComponent(it.modId)+'?tab=files">打开 Nexus Files ↗</a></div><div class="body">';
 if(it.blockers?.length) for(const x of it.blockers)b+='<div class="blocker">⚠ '+h(x)+'</div>';
 if(it.mainOptions?.length){b+='<div class="section"><h3>Main 分支（单选）</h3>';
 for(const o of it.mainOptions){b+='<label class="option '+(o.recommended?'recommended ':'')+(o.current?'current':'')+'"><div class="row"><input type="radio" name="main-'+h(it.id)+'" value="'+h(o.fileId)+'" '+(o.current?'checked':'')+'><div><b>'+h(o.name)+'</b> '+(o.current?'<span class="tag">当前</span>':'')+(o.recommended?'<span class="tag">AI 建议</span>':'')+'<div class="meta">fileId '+h(o.fileId)+' · v'+h(o.version)+' · '+h(o.branchKey||o.category)+' · 环境匹配 '+Math.round((o.environmentScore||0)*100)+'%</div>'+(o.tags?.length?'<div>'+o.tags.map(t=>'<span class="tag">'+h(t)+'</span>').join('')+'</div>':'')+(o.description?'<div class="desc">'+h(o.description)+'</div>':'')+'</div></div></label>';}
 b+='</div>';}
 if(it.patchFamilies?.length){b+='<div class="section"><h3>Patch / Hotfix 决策</h3>';
 for(const f of it.patchFamilies){b+='<div class="patch"><div><b>'+h(f.family)+'</b> <span class="meta">'+h(f.reason||'需要确认')+'</span></div><div style="margin:8px 0"><select data-patch-decision="'+h(it.id)+'" data-family="'+h(f.family)+'"><option value="">请选择…</option><option value="DOWNLOAD">下载一个候选</option><option value="NOT_APPLICABLE">不适用于当前环境</option><option value="ALREADY_INCLUDED">已包含/已有</option><option value="OBSOLETE">已废弃/无需</option><option value="SKIP_FOR_NOW">本次跳过整个 MOD</option></select></div>';
 for(const p of f.candidates||[]){b+='<label class="option"><div class="row"><input type="radio" name="patch-'+h(it.id)+'-'+h(f.family)+'" value="'+h(p.modId)+':'+h(p.fileId)+'" '+(!p.selectable?'disabled':'')+'><div><b>'+h(p.name||('候选 '+p.key))+'</b>'+(p.installedContextMatch?'<span class="tag">本地环境命中</span>':'')+(!p.selectable?'<span class="tag">需 Pi 补 exact fileId</span>':'')+'<div class="meta">'+h(p.source)+' · modId '+h(p.modId||'?')+' · fileId '+h(p.fileId||'?')+' · v'+h(p.version||'?')+'</div>'+(p.evidence?'<div class="desc">'+h(p.evidence)+'</div>':'')+'</div></div></label>';}
 b+='</div>';}
 b+='</div>';}
 b+='<div class="section"><button class="btn secondary" data-skip="'+h(it.id)+'">本次跳过这个 MOD</button></div></div>'; c.innerHTML=b;root.appendChild(c); }
 attach();}
function collect(){for(const it of D.items){const d=decision(it.id);const m=document.querySelector('input[name="main-'+CSS.escape(it.id)+'"]:checked');if(m)d.mainFileId=m.value;for(const f of it.patchFamilies||[]){const s=document.querySelector('select[data-patch-decision="'+CSS.escape(it.id)+'"][data-family="'+CSS.escape(f.family)+'"]');if(!s)continue;const x={decision:s.value};const r=document.querySelector('input[name="patch-'+CSS.escape(it.id)+'-'+CSS.escape(f.family)+'"]:checked');if(r){const [modId,fileId]=r.value.split(':');x.modId=modId;x.fileId=fileId;}d.patches[f.family]=x;}}return state.decisions;}
function attach(){document.querySelectorAll('[data-skip]').forEach(b=>b.onclick=()=>{decision(b.dataset.skip).skip=true;b.textContent='✓ 已标记本次跳过';});}
async function post(url,body){const token=new URLSearchParams(location.search).get('token')||'';const r=await fetch(url+'?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;}
document.getElementById('save').onclick=async()=>{try{if(location.protocol==='file:')throw new Error('静态报告只读。请运行 npm run review 打开可操作版本。');const j=await post('/api/save',{decisions:collect()});statusEl.textContent='已保存 '+(j.saved||0)+' 项选择';}catch(e){statusEl.textContent='保存失败：'+e.message;}};
document.getElementById('download').onclick=async()=>{try{if(location.protocol==='file:')throw new Error('请运行 npm run review 后再下载。');const j=await post('/api/download',{decisions:collect()});statusEl.textContent='已启动 reviewed download，job='+j.jobId+'。页面可继续保留。';}catch(e){statusEl.textContent='未启动：'+e.message;}};
render();
</script></body></html>`;
}

function main() {
  const planFile = process.argv[2];
  const patchFile = process.argv[3];
  const closureFile = process.argv[4];
  const outJson = argValue('--out');
  const outHtml = argValue('--html');
  if (!planFile || !outJson || !outHtml) {
    console.error('Usage: node build-review-center.js <plan.json> [patch-discovery.json] [closure.json] --out review-center.json --html review-center.html');
    process.exit(2);
  }
  const plan = load(planFile, { items: [] });
  const patch = load(patchFile, { items: [] });
  const closure = load(closureFile, { items: [] });
  const patchMap = new Map((patch.items || []).map(x => [keyOf(x.modId, x.mainFileId), x]));
  const closureMap = new Map((closure.items || []).map(x => [keyOf(x.modId, x.fileId), x]));
  const map = new Map();

  function ensure(item) {
    const id = `mod:${item.modId}`;
    if (!map.has(id)) map.set(id, {
      id, modId: String(item.modId), localName: item.name || item.localName || '', mainName: item.latestName || item.name || '',
      localFileId: item.localFileId || item.fileId || '', action: item.action || '', mainOptions: [], patchFamilies: [], blockers: [],
    });
    return map.get(id);
  }

  for (const item of plan.items || []) {
    const isReview = item.action === 'HOLD_VARIANT_REVIEW' || ['HOLD_REVIEW','HOLD_AMBIGUOUS','HOLD_LOW_CONFIDENCE','HOLD_SAME_VERSION_REPLACEMENT'].includes(item.action);
    if (!isReview && !item.manualReview?.required) continue;
    const r = ensure(item);
    if (item.manualReview?.options?.length) r.mainOptions = item.manualReview.options.map(o => compactMainOption(o, item));
    else r.mainOptions = (item.candidates || []).filter(x => x.fileId).map(o => ({
      modId: String(item.modId), fileId: String(o.fileId), name: o.name || '', fileName: o.fileName || '', version: o.version || '',
      category: o.category || '', description: o.description || '', branchKey: '', tags: [], current: String(o.fileId) === String(item.localFileId || ''),
      recommended: String(o.fileId) === String(item.latestFileId || ''), environmentScore: o.similarity || 0, environmentMatch: '', selectable: true,
    }));
    if (item.action === 'HOLD_VARIANT_REVIEW') r.blockers.push('检测到多个互斥 Main 分支：程序不会自动从当前分支迁移到另一分支。');
  }

  for (const p of patch.items || []) {
    if (p.complete) continue;
    const pseudo = { modId: p.modId, name: p.mainName, latestName: p.mainName, localFileId: '', action: 'HOLD_PATCH_DISCOVERY' };
    const r = ensure(pseudo);
    r.action = r.action || 'HOLD_PATCH_DISCOVERY';
    for (const problem of p.coverageProblems || []) r.blockers.push(`Patch discovery 覆盖不完整：${problem.source} / ${problem.status}${problem.detail ? ` — ${problem.detail}` : ''}`);
    const fam = new Map();
    for (const c of p.unresolved || []) {
      const f = c.family || 'GENERAL';
      if (!fam.has(f)) fam.set(f, { family: f, reason: '未解决 Patch family', candidates: [] });
      fam.get(f).candidates.push(compactPatchCandidate(c, p.modId));
    }
    r.patchFamilies.push(...fam.values());
  }

  for (const r of map.values()) {
    const targetId = r.mainOptions.find(x => x.recommended)?.fileId || r.localFileId || '';
    const c = closureMap.get(keyOf(r.modId, targetId));
    if (c?.closure === 'FAILED') {
      if (c.missingKinds?.length) r.blockers.push(`Closure 未完成：${c.missingKinds.join(', ')}`);
      if (c.conflicts?.length) r.blockers.push(`Closure 证据冲突：${c.conflicts.join(' | ')}`);
    }
    r.blockers = [...new Set(r.blockers)];
    const pm = patchMap.get(keyOf(r.modId, targetId));
    if (pm && !pm.complete && !r.patchFamilies.length) r.blockers.push('Patch Discovery 尚未闭合；需要 Pi Agent 先补候选 exact fileId/证据。');
  }

  const items = [...map.values()].sort((a,b) => Number(a.modId)-Number(b.modId));
  const counts = {
    variant: items.filter(x => x.mainOptions.length > 1).length,
    patch: items.filter(x => x.patchFamilies.length || x.blockers.some(b => /Patch/i.test(b))).length,
    other: items.filter(x => x.mainOptions.length <= 1 && !x.patchFamilies.length).length,
  };
  const payload = { generatedAt: new Date().toISOString(), version: 1, plan: planFile, patchDiscovery: patchFile || null, closure: closureFile || null, counts, items };
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(outHtml, htmlTemplate(payload), 'utf8');
  console.log(JSON.stringify({ items: items.length, counts, outJson, outHtml }, null, 2));
}

main();
