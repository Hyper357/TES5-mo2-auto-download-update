'use strict';

const D = window.REVIEW_DATA;
const root = document.getElementById('root');
const statusEl = document.getElementById('status');
const state = { decisions: {} };
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const decision = id => state.decisions[id] || (state.decisions[id] = { patches: {} });

function summary() {
  const auto = D.autoSummary;
  document.getElementById('auto-summary').innerHTML = auto ?
    '<span class="pill">自动请求 ' + auto.requested + '</span>' +
    '<span class="pill good">VERIFIED ' + auto.verified + '</span>' +
    '<span class="pill ' + (auto.failed ? 'danger' : 'good') + '">失败/未验证 ' + auto.failed + '</span>' +
    '<span class="pill">延后人工复核 ' + auto.humanReview + '</span>' : '';
  document.getElementById('summary').innerHTML =
    '<span class="pill">待复核 ' + D.items.length + '</span>' +
    '<span class="pill">多分支 ' + D.counts.variant + '</span>' +
    '<span class="pill">Patch 未闭合 ' + D.counts.patch + '</span>' +
    '<span class="pill">其他不确定 ' + D.counts.other + '</span>';
}

function renderMainOptions(it) {
  if (!it.mainOptions?.length) return '';
  let out = '<div class="section"><h3>Main 分支（单选）</h3>';
  if (it.variantPolicy?.branchKey) {
    out += '<div class="blocker">🧠 上次记住：' + h(it.variantPolicy.branchKey) +
      (it.variantPolicy.lastConfirmedName ? ' · ' + h(it.variantPolicy.lastConfirmedName) : '') +
      '。当前页面结构发生变化，所以这次必须重新确认。</div>';
  }
  out += '<div class="meta">点击任一 Main 分支会把它记为后续更新偏好；如果作者以后删除/改名该分支，系统仍会重新 HOLD，不会自动退回其他分支。</div>';
  for (const o of it.mainOptions) {
    out += '<label class="option ' + (o.recommended ? 'recommended ' : '') + (o.current ? 'current' : '') + '"><div class="row">' +
      '<input type="radio" data-main-choice="' + h(it.id) + '" name="main-' + h(it.id) + '" value="' + h(o.fileId) + '" ' + (o.current ? 'checked' : '') + '><div><b>' + h(o.name) + '</b> ' +
      (o.current ? '<span class="tag">当前</span>' : '') + (o.recommended ? '<span class="tag">AI 建议</span>' : '') +
      '<div class="meta">fileId ' + h(o.fileId) + ' · v' + h(o.version) + ' · ' + h(o.branchKey || o.category) + ' · 环境匹配 ' + Math.round((o.environmentScore || 0) * 100) + '%</div>' +
      (o.tags?.length ? '<div>' + o.tags.map(t => '<span class="tag">' + h(t) + '</span>').join('') + '</div>' : '') +
      (o.description ? '<div class="desc">' + h(o.description) + '</div>' : '') + '</div></div></label>';
  }
  out += '<div class="meta" id="remember-' + h(it.id) + '"></div>';
  return out + '</div>';
}

function renderPatchFamilies(it) {
  if (!it.patchFamilies?.length) return '';
  let out = '<div class="section"><h3>Patch / Hotfix 决策</h3>';
  for (const f of it.patchFamilies) {
    out += '<div class="patch"><div><b>' + h(f.family) + '</b> <span class="meta">' + h(f.reason || '需要确认') + '</span></div>' +
      '<div style="margin:8px 0"><select data-patch-decision="' + h(it.id) + '" data-family="' + h(f.family) + '">' +
      '<option value="">请选择…</option><option value="DOWNLOAD">下载一个候选</option><option value="NOT_APPLICABLE">不适用于当前环境</option>' +
      '<option value="ALREADY_INCLUDED">已包含/已有</option><option value="OBSOLETE">已废弃/无需</option><option value="SKIP_FOR_NOW">本次跳过整个 MOD</option></select></div>';
    for (const p of f.candidates || []) {
      out += '<label class="option"><div class="row"><input type="radio" name="patch-' + h(it.id) + '-' + h(f.family) + '" value="' + h(p.modId) + ':' + h(p.fileId) + '" ' + (!p.selectable ? 'disabled' : '') + '><div><b>' + h(p.name || ('候选 ' + p.key)) + '</b>' +
        (p.installedContextMatch ? '<span class="tag">本地环境命中</span>' : '') + (!p.selectable ? '<span class="tag">需 Pi 补 exact fileId</span>' : '') +
        '<div class="meta">' + h(p.source) + ' · modId ' + h(p.modId || '?') + ' · fileId ' + h(p.fileId || '?') + ' · v' + h(p.version || '?') + '</div>' +
        (p.evidence ? '<div class="desc">' + h(p.evidence) + '</div>' : '') + '</div></div></label>';
    }
    out += '</div>';
  }
  return out + '</div>';
}

function render() {
  summary();
  if (!D.items.length) {
    root.innerHTML = '<div class="card empty">没有需要人工复核的项目 🎉</div>';
    return;
  }
  root.innerHTML = '';
  for (const it of D.items) {
    const card = document.createElement('div');
    card.className = 'card';
    const blockers = (it.blockers || []).map(x => '<div class="blocker">⚠ ' + h(x) + '</div>').join('');
    card.innerHTML = '<div class="head"><div><b>' + h(it.localName || it.mainName || ('Mod ' + it.modId)) + '</b><div class="meta">modId ' + h(it.modId) + ' · ' + h(it.action || 'REVIEW') + '</div></div>' +
      '<a class="link" target="_blank" href="https://www.nexusmods.com/skyrimspecialedition/mods/' + encodeURIComponent(it.modId) + '?tab=files">打开 Nexus Files ↗</a></div>' +
      '<div class="body">' + blockers + renderMainOptions(it) + renderPatchFamilies(it) +
      '<div class="section"><button class="btn secondary" data-skip="' + h(it.id) + '">本次跳过这个 MOD</button></div></div>';
    root.appendChild(card);
  }

  document.querySelectorAll('[data-main-choice]').forEach(input => {
    input.onclick = () => {
      const d = decision(input.dataset.mainChoice);
      d.mainFileId = input.value;
      d.rememberMain = true;
      const note = document.getElementById('remember-' + input.dataset.mainChoice);
      if (note) note.textContent = '🧠 已标记：成功提交本次 Review 后，记住这个 Main 分支用于以后更新。';
    };
  });

  document.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => {
    decision(b.dataset.skip).skip = true;
    b.textContent = '✓ 已标记本次跳过';
  });
}

function collect() {
  for (const it of D.items) {
    const d = decision(it.id);
    const main = document.querySelector('input[name="main-' + CSS.escape(it.id) + '"]:checked');
    if (main) d.mainFileId = main.value;
    for (const f of it.patchFamilies || []) {
      const select = document.querySelector('select[data-patch-decision="' + CSS.escape(it.id) + '"][data-family="' + CSS.escape(f.family) + '"]');
      if (!select) continue;
      const x = { decision: select.value };
      const chosen = document.querySelector('input[name="patch-' + CSS.escape(it.id) + '-' + CSS.escape(f.family) + '"]:checked');
      if (chosen) [x.modId, x.fileId] = chosen.value.split(':');
      d.patches[f.family] = x;
    }
  }
  return state.decisions;
}

async function post(url, body) {
  const token = new URLSearchParams(location.search).get('token') || '';
  const response = await fetch(url + '?token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
  return payload;
}

document.getElementById('save').onclick = async () => {
  try {
    if (location.protocol === 'file:') throw new Error('静态报告只读。请运行 npm run review 打开可操作版本。');
    const j = await post('/api/save', { decisions: collect() });
    statusEl.textContent = '已保存 ' + (j.saved || 0) + ' 项选择';
  } catch (e) { statusEl.textContent = '保存失败：' + e.message; }
};

document.getElementById('download').onclick = async () => {
  try {
    if (location.protocol === 'file:') throw new Error('请运行 npm run review 后再下载。');
    const j = await post('/api/download', { decisions: collect() });
    statusEl.textContent = '已启动 reviewed download，job=' + j.jobId + '。页面可继续保留。';
  } catch (e) { statusEl.textContent = '未启动：' + e.message; }
};

render();
