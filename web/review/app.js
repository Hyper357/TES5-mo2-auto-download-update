'use strict';

const D = window.REVIEW_DATA || {};
const root = document.getElementById('root');
const statusEl = document.getElementById('status');
const moreBtn = document.getElementById('more');
const state = { decisions: {}, expanded: new Set() };
const view = { filter: 'actionable', query: '', limit: 25 };
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const decision = id => state.decisions[id] || (state.decisions[id] = { patches: {}, components: {} });

function componentGroups(it) {
  if (it.componentFamilies?.length) return it.componentFamilies;
  return (it.patchFamilies || []).map(f => ({ kind: 'PATCH', key: 'PATCH:' + f.family, ...f }));
}

function itemBucket(it) {
  if (it.reviewClass) return it.reviewClass;
  if (it.action === 'HOLD_UPDATE_ELIGIBILITY') return 'eligibility';
  if ((it.mainOptions || []).length > 1 || componentGroups(it).length) return 'actionable';
  return 'technical';
}

function bucketCounts() {
  const counts = { actionable: 0, eligibility: 0, technical: 0, all: (D.items || []).length };
  for (const it of D.items || []) counts[itemBucket(it)] = (counts[itemBucket(it)] || 0) + 1;
  return counts;
}

function summary() {
  const auto = D.autoSummary;
  const env = D.environment;
  const updates = D.updateSummary || {};
  const confirmed = Number(updates.UPDATE_CONFIRMED || 0);
  const counts = bucketCounts();
  const runId = D.runId || String(D.plan || '').match(/runs[\\/]+([^\\/]+)/)?.[1] || 'unknown run';
  document.getElementById('run-meta').innerHTML = 'Run: ' + h(runId) + '<br>' + h(D.generatedAt || '');

  document.getElementById('auto-summary').innerHTML = auto ?
    '<span class="pill">自动请求 ' + Number(auto.requested || 0) + '</span>' +
    '<span class="pill good">VERIFIED ' + Number(auto.verified || 0) + '</span>' +
    '<span class="pill ' + (auto.failed ? 'danger' : 'good') + '">失败/未验证 ' + Number(auto.failed || 0) + '</span>' +
    '<span class="pill">真更新 ' + confirmed + '</span>' :
    '<span class="pill warn">尚无本轮自动阶段汇总</span>' + (confirmed ? '<span class="pill">真更新 ' + confirmed + '</span>' : '');

  document.getElementById('summary').innerHTML =
    (env ? '<span class="pill ' + (env.profileResolved ? 'good' : 'danger') + '">MO2 ' + h(env.profileName || 'UNRESOLVED') + '</span>' : '') +
    '<span class="pill">需要你决定 ' + counts.actionable + '</span>' +
    '<span class="pill">资格待确认 ' + counts.eligibility + '</span>' +
    '<span class="pill">技术阻断 ' + counts.technical + '</span>' +
    (D.nonBlockingEvidence ? '<span class="pill">已自动降噪证据 ' + Number(D.nonBlockingEvidence || 0) + '</span>' : '');

  const zero = document.getElementById('zero-warning');
  if (auto && Number(auto.requested || 0) === 0 && confirmed > 0) {
    zero.className = 'zero-warning';
    zero.innerHTML = '<b>⚠ 自动阶段仍是 0</b>　检测到 ' + confirmed + ' 个真更新，但没有任何项目进入下载。' +
      '这不是让你手动点完全部项目的理由；默认页只列真正可由你决策的项，其余技术噪声应由流水线继续消化。';
  } else if (!auto && String(D.plan || '').includes('runs')) {
    zero.className = 'zero-warning';
    zero.innerHTML = '<b>ℹ 这份页面没有嵌入自动阶段汇总。</b> 如果它来自旧 Run，请不要据此判断当前 requested / VERIFIED。';
  } else {
    zero.className = '';
    zero.innerHTML = '';
  }

  document.getElementById('filters').innerHTML = [
    ['actionable', '需要我决定'],
    ['eligibility', '资格待确认'],
    ['technical', '技术阻断'],
    ['all', '全部'],
  ].map(([key, label]) => '<button class="filter ' + (view.filter === key ? 'active' : '') + '" data-filter="' + key + '">' +
      label + ' ' + (counts[key] || 0) + '</button>').join('');
}

function itemReason(it) {
  const groups = componentGroups(it);
  const mains = (it.mainOptions || []).length;
  const blockers = (it.blockers || []).length;
  if (itemBucket(it) === 'eligibility') return '更新资格还没有被证明；这里只展示证据，不能从 Review Center 强行越过资格门禁。';
  const parts = [];
  if (mains > 1) parts.push('选择 1 个 Main 分支');
  if (groups.length) parts.push('确认 ' + groups.length + ' 个组件/补丁族');
  if (!parts.length && blockers) parts.push('存在 ' + blockers + ' 个技术阻断，需要 Pi 补证据');
  return parts.join('；') || '需要人工确认';
}

function blockersHtml(it) {
  const list = it.blockers || [];
  if (!list.length) return '';
  const first = list.slice(0, 2).map(x => '<div class="blocker">⚠ ' + h(x) + '</div>').join('');
  if (list.length <= 2) return '<div class="blocker-list">' + first + '</div>';
  const rest = list.slice(2).map(x => '<div class="blocker">⚠ ' + h(x) + '</div>').join('');
  return '<div class="blocker-list">' + first + '<details class="technical"><summary>另外 ' + (list.length - 2) +
    ' 条阻断详情</summary><div class="technical-body">' + rest + '</div></details></div>';
}

function renderMainOptions(it) {
  if (!it.mainOptions?.length) return '';
  const d = decision(it.id);
  let out = '<div class="section"><h3>Main 分支</h3>' +
    '<div class="section-note">只选你实际使用的产品分支。选择后会记忆该语义分支；作者以后改结构仍会重新 HOLD。</div>';
  if (it.variantPolicy?.branchKey) {
    out += '<div class="blocker">🧠 上次使用：' + h(it.variantPolicy.branchKey) +
      (it.variantPolicy.lastConfirmedName ? ' · ' + h(it.variantPolicy.lastConfirmedName) : '') + '</div>';
  }
  for (const o of it.mainOptions) {
    const checked = d.mainFileId ? String(d.mainFileId) === String(o.fileId) : !!o.current;
    out += '<label class="option ' + (o.recommended ? 'recommended ' : '') + (o.current ? 'current' : '') + '"><div class="row">' +
      '<input type="radio" data-main-choice="' + h(it.id) + '" name="main-' + h(it.id) + '" value="' + h(o.fileId) + '" ' + (checked ? 'checked' : '') + '><div><b>' + h(o.name) + '</b> ' +
      (o.current ? '<span class="tag strong">当前分支</span>' : '') + (o.recommended ? '<span class="tag">AI 建议</span>' : '') +
      '<div class="meta">fileId ' + h(o.fileId) + ' · v' + h(o.version) + (o.branchKey ? ' · ' + h(o.branchKey) : '') + '</div>' +
      (o.description ? '<div class="desc">' + h(o.description) + '</div>' : '') + '</div></div></label>';
  }
  return out + '</div>';
}

function technicalCandidate(p, f) {
  const env = p.environmentDecision;
  const relevance = p.relevance;
  const local = (p.localMatches || []).slice(0, 5);
  return '<details class="technical"><summary>技术证据</summary><div class="technical-body">' +
    '<div>' + h(p.kind || f.kind || 'PATCH') + ' · ' + h(p.source || '?') + ' · modId ' + h(p.modId || '?') + ' · fileId ' + h(p.fileId || '?') + ' · v' + h(p.version || '?') + '</div>' +
    (relevance?.disposition ? '<div>Relevance: ' + h(relevance.disposition) + ' · ' + h(relevance.reason || '') + '</div>' : '') +
    (env?.reason ? '<div>Environment: ' + h(env.reason) + '</div>' : '') +
    (local.length ? '<div>本地命中: ' + h(local.join(' | ')) + '</div>' : '') +
    (p.evidence ? '<div>证据: ' + h(p.evidence) + '</div>' : '') +
    '</div></details>';
}

function renderComponentFamilies(it) {
  const groups = componentGroups(it);
  if (!groups.length) return '';
  const d = decision(it.id);
  let out = '<div class="section"><h3>组件 / Patch / 汉化</h3>' +
    '<div class="section-note">这里列的是仍会阻挡 Main 的候选；普通发现证据和反向依赖已隐藏。只有 DOWNLOAD 才会提交 exact modId:fileId。</div>';
  for (const f of groups) {
    const groupKey = f.key || ((f.kind || 'PATCH') + ':' + (f.family || 'GENERAL'));
    const saved = d.components[groupKey] || {};
    out += '<div class="patch"><div class="patch-top"><div><b>' + h(f.kind || 'PATCH') + '</b> <span class="tag soft">' + h(f.family || 'GENERAL') + '</span></div>' +
      '<select data-component-decision="' + h(it.id) + '" data-component-key="' + h(groupKey) + '">' +
      '<option value="">请选择…</option>' +
      ['DOWNLOAD','NOT_APPLICABLE','ALREADY_INCLUDED','OBSOLETE','SKIP_FOR_NOW'].map(v => '<option value="' + v + '" ' + (saved.decision === v ? 'selected' : '') + '>' + ({DOWNLOAD:'下载一个候选',NOT_APPLICABLE:'不适用于当前环境',ALREADY_INCLUDED:'已包含 / 已有',OBSOLETE:'已废弃 / 无需',SKIP_FOR_NOW:'本次跳过整个 MOD'}[v]) + '</option>').join('') +
      '</select></div>';
    for (const p of f.candidates || []) {
      const chosen = saved.modId && saved.fileId && String(saved.modId) === String(p.modId) && String(saved.fileId) === String(p.fileId);
      out += '<label class="option"><div class="row"><input type="radio" name="component-' + h(it.id) + '-' + h(groupKey) + '" value="' + h(p.modId) + ':' + h(p.fileId) + '" ' +
        (chosen ? 'checked ' : '') + (!p.selectable ? 'disabled' : '') + '><div><b>' + h(p.name || ('候选 ' + p.key)) + '</b> ' +
        (p.requiredHint ? '<span class="tag strong">明确 Required</span>' : '') +
        (p.installedContextMatch ? '<span class="tag">当前环境命中</span>' : '') +
        (p.optionalHint ? '<span class="tag soft">Optional</span>' : '') +
        (!p.selectable ? '<span class="tag soft">缺 exact fileId</span>' : '') +
        technicalCandidate(p, f) + '</div></div></label>';
    }
    out += '</div>';
  }
  return out + '</div>';
}

function renderCard(it) {
  const bucket = itemBucket(it);
  const groups = componentGroups(it);
  const expanded = state.expanded.has(it.id);
  const d = decision(it.id);
  const badge = bucket === 'eligibility' ? '<span class="badge eligibility">资格待确认</span>' :
    bucket === 'technical' ? '<span class="badge tech">技术阻断</span>' : '<span class="badge action">需要选择</span>';
  const metrics = [];
  if ((it.mainOptions || []).length > 1) metrics.push((it.mainOptions || []).length + ' Main');
  if (groups.length) metrics.push(groups.length + ' 组件族');
  if ((it.blockers || []).length) metrics.push((it.blockers || []).length + ' 阻断');
  const card = document.createElement('div');
  card.className = 'card ' + (bucket === 'actionable' ? 'attention ' : '') + (expanded ? 'expanded' : '');
  card.dataset.item = it.id;
  card.innerHTML = '<div class="head" data-expand="' + h(it.id) + '"><div><div class="title-line"><b>' + h(it.localName || it.mainName || ('Mod ' + it.modId)) + '</b>' + badge +
    (d.skip ? '<span class="badge skip-mark">本轮已跳过</span>' : '') + '</div><div class="reason-line">' + h(itemReason(it)) + '</div>' +
    '<div class="card-meta">modId ' + h(it.modId) + ' · ' + h(it.action || 'REVIEW') + (metrics.length ? ' · ' + h(metrics.join(' · ')) : '') + '</div></div>' +
    '<div class="head-actions"><a class="link" data-no-expand="1" target="_blank" href="https://www.nexusmods.com/skyrimspecialedition/mods/' + encodeURIComponent(it.modId) + '?tab=files">Nexus ↗</a><span class="chevron">⌄</span></div></div>' +
    '<div class="body">' + blockersHtml(it) + renderMainOptions(it) + renderComponentFamilies(it) +
    '<div class="section"><button class="btn secondary" data-skip="' + h(it.id) + '">' + (d.skip ? '✓ 本轮已跳过' : '本次跳过这个 MOD') + '</button></div></div>';
  return card;
}

function filteredItems() {
  const q = view.query.trim().toLowerCase();
  return (D.items || []).filter(it => {
    if (view.filter !== 'all' && itemBucket(it) !== view.filter) return false;
    if (!q) return true;
    return `${it.localName || ''} ${it.mainName || ''} ${it.modId || ''}`.toLowerCase().includes(q);
  });
}

function render() {
  summary();
  const list = filteredItems();
  const shown = list.slice(0, view.limit);
  document.getElementById('visible-status').textContent = '显示 ' + shown.length + ' / ' + list.length;
  root.innerHTML = '';
  if (!shown.length) {
    root.innerHTML = '<div class="empty">这个视图没有项目。' + (view.filter === 'actionable' ? '<br>这通常是好事：没有必须由你手工做的选择。' : '') + '</div>';
  } else {
    for (const it of shown) root.appendChild(renderCard(it));
  }
  moreBtn.hidden = shown.length >= list.length;
  moreBtn.textContent = '显示更多（剩余 ' + Math.max(0, list.length - shown.length) + '）';
  bind();
}

function bind() {
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    view.filter = b.dataset.filter; view.limit = 25; render();
  });
  document.querySelectorAll('[data-expand]').forEach(head => head.onclick = e => {
    if (e.target.closest('[data-no-expand]')) return;
    const id = head.dataset.expand;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    render();
  });
  document.querySelectorAll('[data-main-choice]').forEach(input => input.onchange = () => {
    const d = decision(input.dataset.mainChoice); d.mainFileId = input.value; d.rememberMain = true;
  });
  document.querySelectorAll('[data-component-decision]').forEach(select => select.onchange = () => {
    const d = decision(select.dataset.componentDecision);
    const key = select.dataset.componentKey;
    const group = componentGroups((D.items || []).find(x => x.id === select.dataset.componentDecision) || {}).find(f => (f.key || ((f.kind || 'PATCH') + ':' + (f.family || 'GENERAL'))) === key) || {};
    d.components[key] = { ...(d.components[key] || {}), decision: select.value, kind: group.kind || 'PATCH', family: group.family || 'GENERAL' };
    if ((group.kind || 'PATCH') === 'PATCH') d.patches[group.family] = d.components[key];
  });
  document.querySelectorAll('input[name^="component-"]').forEach(input => input.onchange = () => {
    const label = input.closest('.patch');
    const select = label?.querySelector('[data-component-decision]');
    if (!select) return;
    const d = decision(select.dataset.componentDecision); const key = select.dataset.componentKey;
    const [modId, fileId] = input.value.split(':');
    d.components[key] = { ...(d.components[key] || {}), modId, fileId };
  });
  document.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => {
    decision(b.dataset.skip).skip = true; render();
  });
}

function collect() {
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

document.getElementById('search').oninput = e => { view.query = e.target.value; view.limit = 25; render(); };
moreBtn.onclick = () => { view.limit += 25; render(); };

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
    const decisions = collect();
    if (!Object.keys(decisions).length) throw new Error('还没有做任何人工选择。默认页不要求你处理隐藏的技术证据。');
    const j = await post('/api/download', { decisions });
    statusEl.textContent = '已启动 reviewed download，job=' + j.jobId + '。';
  } catch (e) { statusEl.textContent = '未启动：' + e.message; }
};

render();
