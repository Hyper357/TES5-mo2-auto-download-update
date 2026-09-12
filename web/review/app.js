'use strict';

const D = window.REVIEW_DATA || {};
const root = document.getElementById('root');
const statusEl = document.getElementById('status');
const moreBtn = document.getElementById('more');
const selectionSummaryEl = document.getElementById('selection-summary');
const downloadBtn = document.getElementById('download');
const clearBtn = document.getElementById('clear-selection');

const state = { decisions: {} };
const view = { filter: 'actionable', query: '', limit: 25 };
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function decision(id) {
  const d = state.decisions[id] || (state.decisions[id] = { selectedFiles: [] });
  if (!Array.isArray(d.selectedFiles)) d.selectedFiles = [];
  return d;
}

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

function normalizedFile(raw, it) {
  return {
    modId: String(raw?.modId || it.modId || ''),
    fileId: String(raw?.fileId || ''),
    name: raw?.name || raw?.fileName || `File ${raw?.fileId || ''}`,
    fileName: raw?.fileName || '',
    version: raw?.version || '',
    category: raw?.category || raw?.role || raw?.kind || 'Nexus file',
    role: raw?.role || raw?.kind || '',
    uploadedTime: raw?.uploadedTime || '',
    description: raw?.description || '',
    current: !!raw?.current || String(raw?.fileId || '') === String(it.localFileId || ''),
    recommended: !!raw?.recommended || String(raw?.fileId || '') === String(it.targetMainFileId || ''),
    active: raw?.active !== false,
    selectable: raw?.selectable !== false,
  };
}

function filesForItem(it) {
  const source = Array.isArray(it.recentNexusFiles) && it.recentNexusFiles.length
    ? it.recentNexusFiles
    : [
        ...(it.mainOptions || []),
        ...componentGroups(it).flatMap(f => (f.candidates || []).filter(x => String(x.modId || it.modId) === String(it.modId))),
      ];
  const seen = new Set();
  const out = [];
  for (const raw of source) {
    const f = normalizedFile(raw, it);
    const key = `${f.modId}:${f.fileId}`;
    if (!f.fileId || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function selectedKey(modId, fileId) {
  return `${String(modId)}:${String(fileId)}`;
}

function isSelected(itemId, modId, fileId) {
  return decision(itemId).selectedFiles.some(x => selectedKey(x.modId, x.fileId) === selectedKey(modId, fileId));
}

function setSelected(itemId, file, checked) {
  const d = decision(itemId);
  const key = selectedKey(file.modId, file.fileId);
  d.selectedFiles = d.selectedFiles.filter(x => selectedKey(x.modId, x.fileId) !== key);
  if (checked) d.selectedFiles.push({ modId: String(file.modId), fileId: String(file.fileId) });
  if (!d.selectedFiles.length) delete state.decisions[itemId];
}

function selectedEntries() {
  const out = [];
  for (const [itemId, d] of Object.entries(state.decisions)) {
    for (const file of d.selectedFiles || []) out.push({ itemId, ...file });
  }
  return out;
}

function updateSelectionBar() {
  const selected = selectedEntries();
  const modCount = new Set(selected.map(x => x.itemId)).size;
  selectionSummaryEl.textContent = `已选择 ${selected.length} 个文件 / ${modCount} 个 MOD`;
  downloadBtn.textContent = selected.length ? `下载所选 ${selected.length} 个` : '下载所选文件';
  downloadBtn.disabled = selected.length === 0;
  clearBtn.disabled = selected.length === 0;
}

function formatDate(value) {
  if (!value) return '日期未知';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
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
    '<span class="pill ' + (auto.failed ? 'danger' : 'good') + '">失败 ' + Number(auto.failed || 0) + '</span>' +
    '<span class="pill">真更新 ' + confirmed + '</span>' : '';

  document.getElementById('summary').innerHTML =
    (env ? '<span class="pill ' + (env.profileResolved ? 'good' : 'danger') + '">MO2 ' + h(env.profileName || 'UNRESOLVED') + '</span>' : '') +
    '<span class="pill emphasis">可选择 ' + counts.actionable + '</span>' +
    '<span class="pill">资格问题 ' + counts.eligibility + '</span>' +
    '<span class="pill">技术阻断 ' + counts.technical + '</span>';

  const zero = document.getElementById('zero-warning');
  if (counts.actionable === 0 && (counts.eligibility + counts.technical) > 0) {
    zero.className = 'zero-warning';
    zero.innerHTML = '<b>当前没有可直接选择下载的项目。</b> 其余项目在“资格问题 / 技术阻断”中，只供查看，不会让你用一堆按钮手工绕过安全门禁。';
  } else {
    zero.className = '';
    zero.innerHTML = '';
  }

  document.getElementById('filters').innerHTML = [
    ['actionable', '选择下载'],
    ['eligibility', '资格问题'],
    ['technical', '技术阻断'],
    ['all', '全部'],
  ].map(([key, label]) => '<button class="filter ' + (view.filter === key ? 'active' : '') + '" data-filter="' + key + '">' +
      label + ' ' + (counts[key] || 0) + '</button>').join('');
}

function technicalDetails(it) {
  const blockers = (it.blockers || []).map(x => '<li>' + h(x) + '</li>').join('');
  const groups = componentGroups(it);
  return '<details class="technical-panel"><summary>技术详情</summary><div class="technical-body">' +
    '<div><b>modId</b> ' + h(it.modId) + ' · <b>状态</b> ' + h(it.action || 'REVIEW') + '</div>' +
    (it.localFileId ? '<div><b>本地 fileId</b> ' + h(it.localFileId) + '</div>' : '') +
    (it.targetMainFileId ? '<div><b>推荐 target</b> ' + h(it.targetMainFileId) + '</div>' : '') +
    (it.recentNexusFilesSource ? '<div><b>文件来源</b> ' + h(it.recentNexusFilesSource) + '</div>' : '') +
    (it.variantPolicy?.branchKey ? '<div><b>已记忆分支</b> ' + h(it.variantPolicy.branchKey) + '</div>' : '') +
    (groups.length ? '<div><b>未闭合组件族</b> ' + groups.length + '</div>' : '') +
    (blockers ? '<ul>' + blockers + '</ul>' : '<div>没有额外阻断信息。</div>') +
    '</div></details>';
}

function fileRow(it, file, canChoose) {
  const checked = isSelected(it.id, file.modId, file.fileId);
  const disabled = !canChoose || file.current || !file.active || !file.selectable;
  const tags = [
    file.current ? '<span class="file-badge current">当前安装</span>' : '',
    file.recommended ? '<span class="file-badge recommended">推荐</span>' : '',
    !file.active ? '<span class="file-badge muted-badge">已归档</span>' : '',
  ].join('');
  const checkbox = canChoose
    ? '<input class="file-checkbox" type="checkbox" data-file-choice="' + h(it.id) + '" data-file-mod="' + h(file.modId) + '" data-file-id="' + h(file.fileId) + '" ' + (checked ? 'checked ' : '') + (disabled ? 'disabled' : '') + '>'
    : '<span class="view-dot">•</span>';
  const desc = file.description
    ? '<details class="file-description"><summary>文件说明</summary><div>' + h(file.description) + '</div></details>'
    : '';
  return '<label class="file-row ' + (checked ? 'selected ' : '') + (file.current ? 'is-current ' : '') + (disabled && canChoose ? 'disabled ' : '') + '">' +
    '<div class="file-check">' + checkbox + '</div>' +
    '<div class="file-main"><div class="file-title"><span>' + h(file.name) + '</span>' + tags + '</div>' +
    '<div class="file-meta">' + (file.version ? 'v' + h(file.version) + ' · ' : '') + h(file.category || file.role || 'Nexus file') + ' · ' + h(formatDate(file.uploadedTime)) + '</div>' +
    desc + '</div></label>';
}

function renderFilePicker(it) {
  const files = filesForItem(it);
  const canChoose = itemBucket(it) === 'actionable';
  if (!files.length) {
    return '<div class="file-section"><div class="file-section-title">Nexus 最近文件</div><div class="no-files">没有可展示的 Nexus 文件候选。</div></div>';
  }
  const note = canChoose
    ? '可同时勾选多个文件。未勾选 = 不下载。'
    : '仅供查看；该项目尚未通过下载安全门禁。';
  return '<div class="file-section"><div class="file-section-head"><div><div class="file-section-title">Nexus 最近文件</div><div class="file-section-note">' + note + '</div></div><span class="file-count">' + files.length + ' 个</span></div>' +
    '<div class="file-list">' + files.map(f => fileRow(it, f, canChoose)).join('') + '</div></div>';
}

function currentFileLabel(it) {
  const current = filesForItem(it).find(x => x.current);
  if (current) return `${current.name}${current.version ? ' · v' + current.version : ''}`;
  if (it.localApiVersion) return `v${it.localApiVersion}`;
  return it.localFileId ? `fileId ${it.localFileId}` : '未识别';
}

function renderCard(it) {
  const bucket = itemBucket(it);
  const badge = bucket === 'eligibility' ? '<span class="badge eligibility">资格问题</span>' :
    bucket === 'technical' ? '<span class="badge tech">技术阻断</span>' : '<span class="badge action">可选择</span>';
  const helper = bucket === 'actionable' ? '勾选你要下载的文件，可多选。' :
    bucket === 'eligibility' ? '更新资格尚未确认，文件列表仅供对照。' : '该项目有技术阻断，文件列表仅供对照。';
  const card = document.createElement('section');
  card.className = 'card ' + (bucket === 'actionable' ? 'attention' : 'readonly');
  card.dataset.item = it.id;
  card.innerHTML = '<div class="card-head"><div class="card-title-wrap"><div class="title-line"><h2>' + h(it.localName || it.mainName || ('Mod ' + it.modId)) + '</h2>' + badge + '</div>' +
    '<div class="current-line">当前：' + h(currentFileLabel(it)) + '</div><div class="reason-line">' + h(helper) + '</div></div>' +
    '<a class="nexus-link" target="_blank" rel="noreferrer" href="https://www.nexusmods.com/skyrimspecialedition/mods/' + encodeURIComponent(it.modId) + '?tab=files">Nexus ↗</a></div>' +
    renderFilePicker(it) + technicalDetails(it);
  return card;
}

function filteredItems() {
  const q = view.query.trim().toLowerCase();
  return (D.items || []).filter(it => {
    if (view.filter !== 'all' && itemBucket(it) !== view.filter) return false;
    if (!q) return true;
    const files = filesForItem(it).map(x => `${x.name} ${x.version}`).join(' ');
    return `${it.localName || ''} ${it.mainName || ''} ${it.modId || ''} ${files}`.toLowerCase().includes(q);
  });
}

function render() {
  summary();
  const list = filteredItems();
  const shown = list.slice(0, view.limit);
  document.getElementById('visible-status').textContent = '显示 ' + shown.length + ' / ' + list.length;
  root.innerHTML = '';
  if (!shown.length) {
    root.innerHTML = '<div class="empty">这个视图没有项目。' + (view.filter === 'actionable' ? '<br>没有必须由你手动选择的下载。' : '') + '</div>';
  } else {
    for (const it of shown) root.appendChild(renderCard(it));
  }
  moreBtn.hidden = shown.length >= list.length;
  moreBtn.textContent = '显示更多（剩余 ' + Math.max(0, list.length - shown.length) + '）';
  bindDynamic();
  updateSelectionBar();
}

function bindDynamic() {
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    view.filter = b.dataset.filter;
    view.limit = 25;
    render();
  });

  document.querySelectorAll('[data-file-choice]').forEach(input => input.onchange = () => {
    const it = (D.items || []).find(x => x.id === input.dataset.fileChoice);
    if (!it) return;
    const file = filesForItem(it).find(x => selectedKey(x.modId, x.fileId) === selectedKey(input.dataset.fileMod, input.dataset.fileId));
    if (!file) return;
    setSelected(it.id, file, input.checked);
    render();
  });
}

function collect() {
  const out = {};
  for (const [id, d] of Object.entries(state.decisions)) {
    if (!Array.isArray(d.selectedFiles) || !d.selectedFiles.length) continue;
    out[id] = { selectedFiles: d.selectedFiles.map(x => ({ modId: String(x.modId), fileId: String(x.fileId) })) };
  }
  return out;
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

async function get(url) {
  const token = new URLSearchParams(location.search).get('token') || '';
  const response = await fetch(url + '?token=' + encodeURIComponent(token), { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
  return payload;
}

document.getElementById('search').oninput = e => {
  view.query = e.target.value;
  view.limit = 25;
  render();
};
moreBtn.onclick = () => { view.limit += 25; render(); };

clearBtn.onclick = () => {
  state.decisions = {};
  statusEl.textContent = '';
  render();
};

downloadBtn.onclick = async () => {
  try {
    if (location.protocol === 'file:') throw new Error('静态报告只读。请运行 npm run review 打开可操作版本。');
    const decisions = collect();
    const count = selectedEntries().length;
    if (!count) throw new Error('请先勾选至少一个文件。');
    downloadBtn.disabled = true;
    statusEl.textContent = `正在提交 ${count} 个 exact 文件…`;
    const j = await post('/api/download', { decisions });
    statusEl.textContent = '已启动下载，job=' + j.jobId + '。';
  } catch (e) {
    statusEl.textContent = '未启动：' + e.message;
  } finally {
    updateSelectionBar();
  }
};

async function restoreSavedSelections() {
  if (location.protocol === 'file:') return;
  try {
    const payload = await get('/api/state');
    const saved = payload?.decisions?.decisions || payload?.decisions || {};
    for (const [id, d] of Object.entries(saved)) {
      if (!Array.isArray(d?.selectedFiles) || !d.selectedFiles.length) continue;
      state.decisions[id] = { selectedFiles: d.selectedFiles.map(x => ({ modId: String(x.modId), fileId: String(x.fileId) })) };
    }
    render();
  } catch (_) {
    // Review Center remains fully usable even if no prior selection state exists.
  }
}

render();
restoreSavedSelections();
