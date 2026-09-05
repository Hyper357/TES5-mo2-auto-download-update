'use strict';

const fs = require('fs');
const path = require('path');

const CODES = Object.freeze({
  NEXUS_API_401: { retry: false, layer: 'NEXUS_API', action: '检查 API key 是否有效。' },
  NEXUS_API_403: { retry: false, layer: 'NEXUS_API', action: '检查 Nexus/Cloudflare 拦截、API 权限或速率策略。' },
  NEXUS_API_429: { retry: true, layer: 'NEXUS_API', action: '等待后重试，降低请求频率。' },
  NEXUS_API_TIMEOUT: { retry: true, layer: 'NEXUS_API', action: '检查网络后重试。' },
  NEXUS_LOGIN_REQUIRED: { retry: false, layer: 'BROWSER', action: '在项目专用自动化浏览器中重新登录 Nexus。' },
  CDP_UNAVAILABLE: { retry: true, layer: 'BROWSER', action: '运行 npm run browser:start 启动项目专用自动化浏览器。' },
  BROWSER_PROFILE_MISMATCH: { retry: false, layer: 'BROWSER', action: '当前 CDP 端口属于非项目浏览器/Profile。关闭该远程调试实例，保持日常 Edge 正常启动，再运行 npm run browser:start。' },
  DOM_FILE_NOT_FOUND: { retry: false, layer: 'BROWSER', action: '核对目标 fileId；查看事故现场，禁止模糊点击。' },
  DOM_SELECTOR_CHANGED: { retry: false, layer: 'BROWSER', action: 'Nexus 页面结构可能变化；让 Agent 分析诊断快照并修复 selector。' },
  DOM_DOWNLOAD_BUTTON_MISSING: { retry: false, layer: 'BROWSER', action: '检查页面状态/登录/文件权限，不要猜其他按钮。' },
  NXM_EXTRACT_FAILED: { retry: true, layer: 'NXM', action: '重新打开精确文件卡并获取新的短时 NXM。' },
  NXM_EXPIRED: { retry: true, layer: 'NXM', action: '重新获取新签名 NXM，禁止复用旧签名。' },
  NXM_HANDLER_FAILED: { retry: true, layer: 'MO2', action: '检查 nxmhandler 与当前 MO2 实例绑定；不要在不确定是否已入队时盲目重提。' },
  MO2_NOT_RUNNING: { retry: false, layer: 'MO2', action: '启动正确的 MO2 实例后再执行。' },
  MO2_WRONG_INSTANCE: { retry: false, layer: 'MO2', action: '修正 nxmhandler 指向，避免提交到错误实例。' },
  MO2_QUEUE_NOT_FOUND: { retry: true, layer: 'MO2', action: '刷新 MO2 Downloads 并检查当前精确 fileId；不要直接重复提交 NXM。' },
  MO2_DOWNLOAD_STALLED: { retry: true, layer: 'DOWNLOAD', action: '检查 CDN/队列；先确认 submission ledger 与在途文件，再决定是否恢复当前项。' },
  ARCHIVE_NOT_LANDED: { retry: true, layer: 'DOWNLOAD', action: '确认下载队列和 CDN 状态；先等待已有提交，不要整批重提。' },
  META_MISSING: { retry: true, layer: 'VERIFY', action: '等待 MO2 完成 .meta 落盘；账本会阻止短时间内重复提交。' },
  META_MISMATCH: { retry: false, layer: 'VERIFY', action: '立即停止事务；存在错误归档/元数据风险。' },
  VERSION_MISMATCH: { retry: false, layer: 'VERIFY', action: '立即停止事务并重新核验 Nexus 目标版本。' },
  FILEID_MISMATCH: { retry: false, layer: 'VERIFY', action: '立即停止事务；绝不能继续 Patch/汉化。' },
  ARCHIVE_CORRUPT: { retry: true, layer: 'VERIFY', action: '隔离损坏下载并确认旧队列已清理后，再恢复精确 fileId。' },
  SEVENZIP_FAILED: { retry: false, layer: 'ENV', action: '检查 7-Zip 路径/安装。' },
  REGISTRY_STALE: { retry: false, layer: 'PLANNER', action: '重新核验 Patch/Translation 并刷新 registry evidence。' },
  CLOSURE_MISSING: { retry: false, layer: 'PLANNER', action: '补齐 PATCH 与 TRANSLATION 结论。' },
  CLOSURE_CONFLICT: { retry: false, layer: 'PLANNER', action: '扫描证据与 registry 冲突，重新研究后再放行。' },
  VARIANT_CONFLICT: { retry: false, layer: 'PLANNER', action: '目标变体与本地环境冲突；禁止强行下载。' },
  AMBIGUOUS_MAIN_FILE: { retry: false, layer: 'PLANNER', action: 'Main File 证据不足；人工/Agent 核验后再决定。' },
  VERIFY_TIMEOUT: { retry: true, layer: 'VERIFY', action: '先检查 ledger、.meta/.unfinished 和 MO2 队列；不要直接再次提交同一 fileId。' },
  CONCURRENT_EXECUTOR: { retry: false, layer: 'IDEMPOTENCY', action: '已有一个 --go 执行器正在运行。等待它结束并读取其 execution-state，不要并行启动第二个下载批次。' },
  LEDGER_VERIFIED_MISSING: { retry: false, layer: 'IDEMPOTENCY', action: '提交账本记录为 VERIFIED，但本地下载证据已缺失。先确认归档是否被移动/删除，再显式决定是否重下。' },
  COMMAND_FAILED: { retry: false, layer: 'PROCESS', action: '查看 stderr 与上下文后处理。' },
  UNKNOWN_FAILURE: { retry: false, layer: 'UNKNOWN', action: '查看 errors.jsonl 与诊断快照，禁止盲目继续。' },
});

function sanitizeString(input) {
  let s = String(input ?? '');
  s = s.replace(/([?&](?:key|expires|user_id|user|token|auth|signature|sig)=)[^&\s]+/gi, '$1[REDACTED]');
  s = s.replace(/(apikey\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  s = s.replace(/(Authorization\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
  s = s.replace(/nxm:\/\/([^\s?]+)\?[^\s]+/gi, 'nxm://$1?[REDACTED]');
  return s;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/cookie|password|api.?key|authorization|secret|token/i.test(k)) out[k] = '[REDACTED]';
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function classifyFailure(input) {
  const text = sanitizeString(typeof input === 'string' ? input : JSON.stringify(input || {}));
  const rules = [
    [/\b401\b.*(?:nexus|api)|nexus.*\b401\b/i, 'NEXUS_API_401'],
    [/\b403\b|cloudflare|forbidden/i, 'NEXUS_API_403'],
    [/\b429\b|rate.?limit/i, 'NEXUS_API_429'],
    [/api.*timeout|etimedout|socket hang up/i, 'NEXUS_API_TIMEOUT'],
    [/BROWSER_PROFILE_MISMATCH|unmanaged browser|unmanaged.*profile|profile.*mismatch/i, 'BROWSER_PROFILE_MISMATCH'],
    [/CONCURRENT_EXECUTOR|another --go executor|executor.*already.*running/i, 'CONCURRENT_EXECUTOR'],
    [/LEDGER_VERIFIED_MISSING|verified.*ledger.*missing|ledger.*verified.*missing/i, 'LEDGER_VERIFIED_MISSING'],
    [/sign.?in|login required|not logged|登录/i, 'NEXUS_LOGIN_REQUIRED'],
    [/ECONNREFUSED.*(?:9222|cdp)|cdp.*(?:failed|unavailable|connect)|127\.0\.0\.1:\d+.*refused/i, 'CDP_UNAVAILABLE'],
    [/NO-NXM-EXTRACTED|nxm.*(?:extract|capture).*(?:fail|missing)|no nxm/i, 'NXM_EXTRACT_FAILED'],
    [/nxm.*expired|expires.*(?:past|expired)|signature.*expired/i, 'NXM_EXPIRED'],
    [/nxmhandler.*(?:fail|error)|handler.*(?:fail|error)/i, 'NXM_HANDLER_FAILED'],
    [/MO2.*not running|ModOrganizer.*not running/i, 'MO2_NOT_RUNNING'],
    [/wrong.*MO2|MO2.*wrong instance/i, 'MO2_WRONG_INSTANCE'],
    [/queue.*not found|MO2_QUEUE_NOT_FOUND/i, 'MO2_QUEUE_NOT_FOUND'],
    [/download.*stall|no growth|stuck.*(?:0 ?B|download)|\.unfinished.*timeout/i, 'MO2_DOWNLOAD_STALLED'],
    [/VARIANT-MISMATCH|variant.*mismatch|variant conflict/i, 'VARIANT_CONFLICT'],
    [/FILEID.*MISMATCH|file.?id.*mismatch/i, 'FILEID_MISMATCH'],
    [/META.*MISMATCH|meta.*mismatch/i, 'META_MISMATCH'],
    [/VERSION.*MISMATCH|version.*mismatch/i, 'VERSION_MISMATCH'],
    [/MISSING_META|meta.*missing/i, 'META_MISSING'],
    [/ARCHIVE_TEST_FAILED|corrupt|CRC failed|data error/i, 'ARCHIVE_CORRUPT'],
    [/SEVENZIP_NOT_FOUND|7-?zip.*not found/i, 'SEVENZIP_FAILED'],
    [/HOLD_CLOSURE_CONFLICT|closure.*conflict/i, 'CLOSURE_CONFLICT'],
    [/HOLD_CLOSURE|closure.*missing/i, 'CLOSURE_MISSING'],
    [/REGISTRY_STALE|registry.*stale/i, 'REGISTRY_STALE'],
    [/HOLD_AMBIGUOUS|ambiguous.*main/i, 'AMBIGUOUS_MAIN_FILE'],
    [/VERIFY_TIMEOUT|verify.*timeout/i, 'VERIFY_TIMEOUT'],
    [/file.*not found|NOT-FOUND/i, 'DOM_FILE_NOT_FOUND'],
    [/download button.*missing|button.*not found/i, 'DOM_DOWNLOAD_BUTTON_MISSING'],
    [/selector.*(?:changed|missing)|shadow dom.*(?:changed|unexpected)/i, 'DOM_SELECTOR_CHANGED'],
  ];
  for (const [re, code] of rules) if (re.test(text)) return describeCode(code);
  return describeCode('UNKNOWN_FAILURE');
}

function describeCode(code) {
  const meta = CODES[code] || CODES.UNKNOWN_FAILURE;
  return { code: CODES[code] ? code : 'UNKNOWN_FAILURE', ...meta };
}

function createLogger(runDir, options = {}) {
  const logsDir = path.join(runDir, 'logs');
  const diagnosticsDir = path.join(runDir, 'diagnostics');
  const screenshotsDir = path.join(runDir, 'screenshots');
  for (const d of [logsDir, diagnosticsDir, screenshotsDir]) fs.mkdirSync(d, { recursive: true });
  const files = {
    pipeline: path.join(logsDir, 'pipeline.log'),
    events: path.join(logsDir, 'events.jsonl'),
    errors: path.join(logsDir, 'errors.jsonl'),
  };
  const debug = !!options.debug;
  const runId = options.runId || path.basename(runDir);

  function event(level, stage, message, data = {}) {
    if (level === 'DEBUG' && !debug) return;
    const rec = sanitize({
      time: new Date().toISOString(), runId, level, stage,
      message: sanitizeString(message), ...data,
    });
    const suffix = Object.entries(data || {})
      .filter(([k, v]) => ['modId', 'fileId', 'attempt', 'status', 'errorCode', 'tx'].includes(k) && v !== undefined)
      .map(([k, v]) => `${k}=${sanitizeString(v)}`).join(' ');
    fs.appendFileSync(files.pipeline, `${rec.time} ${level.padEnd(5)} [${stage}] ${rec.message}${suffix ? ` | ${suffix}` : ''}\n`, 'utf8');
    fs.appendFileSync(files.events, `${JSON.stringify(rec)}\n`, 'utf8');
    if (level === 'ERROR') fs.appendFileSync(files.errors, `${JSON.stringify(rec)}\n`, 'utf8');
    return rec;
  }

  return {
    runDir, logsDir, diagnosticsDir, screenshotsDir, files,
    debug: (stage, msg, data) => event('DEBUG', stage, msg, data),
    info: (stage, msg, data) => event('INFO', stage, msg, data),
    warn: (stage, msg, data) => event('WARN', stage, msg, data),
    error: (stage, msg, data) => event('ERROR', stage, msg, data),
    writeDiagnostic(name, value) {
      const safeName = String(name).replace(/[^a-z0-9._-]+/gi, '_');
      const file = path.join(diagnosticsDir, safeName.endsWith('.json') ? safeName : `${safeName}.json`);
      fs.writeFileSync(file, JSON.stringify(sanitize(value), null, 2), 'utf8');
      return file;
    },
  };
}

module.exports = { CODES, sanitizeString, sanitize, classifyFailure, describeCode, createLogger };
