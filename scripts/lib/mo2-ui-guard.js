'use strict';

const STOP = new Set([
  'latest', 'version', 'latestversion', 'main', 'file', 'files', 'mod', 'manager',
  'download', 'downloads', 'update', 'updated', 'the', 'and', 'for', 'with',
  '版本', '最新版', '文件', '下载', '模组', '更新',
]);

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\u2010-\u2015_]+/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(input) {
  return normalizeText(input)
    .split(' ')
    .filter(Boolean)
    .filter(t => t.length >= 2)
    .filter(t => !STOP.has(t))
    .filter(t => !/^20\d{2}$/.test(t))
    .filter(t => !/^\d{2,}$/.test(t));
}

function nameMatch(targetName, text) {
  const targetNorm = normalizeText(targetName);
  const textNorm = normalizeText(text);
  if (!targetNorm || !textNorm) return { score: 0, matched: [], target: [] };
  if (textNorm.includes(targetNorm)) {
    const target = significantTokens(targetName);
    return { score: 1, matched: target, target };
  }
  const target = [...new Set(significantTokens(targetName))];
  const hay = new Set(significantTokens(text));
  const matched = target.filter(t => hay.has(t));
  const score = target.length ? matched.length / target.length : 0;
  return { score, matched, target };
}

function classifyDialogText(text) {
  const raw = String(text || '');
  if (/此文件已在下载队列中|already\s+(?:exists\s+)?(?:in|on)\s+(?:the\s+)?download\s+queue|already.*download.*queue/i.test(raw)) {
    return 'DUPLICATE_QUEUE_INFO';
  }
  if (/重新下载\s*[?？]?|re[- ]?download\s*[?？]?/i.test(raw)
      && /已有同名|同名.*下载文件|same\s+(?:file\s+)?name|already.*same.*name|file.*already.*exists/i.test(raw)) {
    return 'REDOWNLOAD_PROMPT';
  }
  return null;
}

function classifyQueueText(text) {
  const raw = String(text || '');
  if (/正在下载|下载中|downloading|\b\d+(?:\.\d+)?\s*(?:kb|mb|gb)\/s\b|\b\d{1,3}%\b/i.test(raw)) return 'DOWNLOADING';
  if (/排队|队列|等待|queued|waiting/i.test(raw)) return 'QUEUED';
  if (/暂停|paused/i.test(raw)) return 'PAUSED';
  if (/已下载|downloaded|complete(?:d)?/i.test(raw)) return 'COMPLETE';
  if (/已安装|installed/i.test(raw)) return 'INSTALLED';
  return 'PRESENT';
}

function windowText(w) {
  return [w?.title, ...(w?.texts || []), ...(w?.buttons || [])].filter(Boolean).join(' | ');
}

function evaluateSnapshot(snapshot, target = {}) {
  const modId = String(target.modId || '');
  const fileId = String(target.fileId || '');
  const name = String(target.name || '');
  const dialogs = [];
  const safeActions = [];

  for (const w of snapshot?.windows || []) {
    const text = windowText(w);
    const kind = classifyDialogText(text);
    if (!kind) continue;
    const exactIds = !!modId && !!fileId && text.includes(modId) && text.includes(fileId);
    const nm = nameMatch(name, text);
    const strongName = nm.matched.length >= 2 && nm.score >= 0.45;
    const record = {
      handle: w.handle,
      title: w.title || '',
      kind,
      exactIds,
      nameScore: nm.score,
      matchedTokens: nm.matched,
      buttons: w.buttons || [],
      sample: text.slice(0, 1200),
      safe: false,
      safeButton: null,
    };

    if (kind === 'DUPLICATE_QUEUE_INFO' && (exactIds || strongName)) {
      record.safe = true;
      record.safeButton = 'OK';
      safeActions.push({
        handle: w.handle,
        kind,
        buttonRole: 'OK',
        reason: exactIds ? 'EXACT_MOD_FILE_DUPLICATE' : 'STRONG_TARGET_NAME_DUPLICATE',
      });
    } else if (kind === 'REDOWNLOAD_PROMPT' && strongName) {
      // Only cancel a re-download. Never select Yes/Retry/Download.
      record.safe = true;
      record.safeButton = 'NO';
      safeActions.push({ handle: w.handle, kind, buttonRole: 'NO', reason: 'STRONG_TARGET_NAME_MATCH' });
    }
    dialogs.push(record);
  }

  const queueCandidates = [];
  for (const item of snapshot?.queueItems || []) {
    const text = [item?.name, ...(item?.texts || [])].filter(Boolean).join(' | ');
    const nm = nameMatch(name, text);
    const strongName = nm.matched.length >= 2 && nm.score >= 0.45;
    if (!strongName) continue;
    queueCandidates.push({
      name: item.name || '',
      state: classifyQueueText(text),
      score: nm.score,
      matchedTokens: nm.matched,
      sample: text.slice(0, 1000),
    });
  }

  const rank = { DOWNLOADING: 5, QUEUED: 4, PAUSED: 3, COMPLETE: 2, INSTALLED: 1, PRESENT: 0 };
  queueCandidates.sort((a, b) => (rank[b.state] || 0) - (rank[a.state] || 0) || b.score - a.score);
  const primaryQueue = queueCandidates[0] || null;
  const inflight = !!primaryQueue && ['DOWNLOADING', 'QUEUED', 'PAUSED'].includes(primaryQueue.state);
  const complete = !!primaryQueue && ['COMPLETE', 'INSTALLED'].includes(primaryQueue.state);
  const ambiguousDialogs = dialogs.filter(d => !d.safe);

  return {
    process: snapshot?.process || null,
    dialogs,
    safeActions,
    ambiguousDialogs,
    queue: {
      state: primaryQueue?.state || 'ABSENT',
      inflight,
      complete,
      primary: primaryQueue,
      candidates: queueCandidates,
    },
    safety: {
      hasSafeDuplicateDialog: safeActions.length > 0,
      hasAmbiguousDuplicateDialog: ambiguousDialogs.length > 0,
      neverClicksAffirmativeRedownload: true,
    },
  };
}

function buttonRegexForRole(role) {
  // MO2/Qt may expose accelerators as 否(N), No(&N), OK(O), etc.
  const accelerator = '(?:\\(&?[A-Za-z]\\))?';
  if (role === 'OK') return `^(确定|OK|Ok|ok)${accelerator}$`;
  if (role === 'NO') return `^(否|No|NO|no|取消|Cancel)${accelerator}$`;
  throw new Error(`unsupported safe button role: ${role}`);
}

module.exports = {
  normalizeText,
  significantTokens,
  nameMatch,
  classifyDialogText,
  classifyQueueText,
  evaluateSnapshot,
  buttonRegexForRole,
};
