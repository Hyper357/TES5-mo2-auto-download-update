# AI Agent Mandatory Protocol — Precision First

本仓库的目标不是“尽量多下载”，而是：**只自动下载能够被程序证据链证明正确的文件，并在失败时保留足够证据供 Agent 定点恢复。**
任何 Agent（包括 Pi Agent）都必须服从程序门禁，不能通过改清单动作、删除 HOLD、伪造 NONE 结论来绕过。

## 1. 浏览器必须隔离：禁止控制用户日常 Edge

从 v3.3 开始，Nexus 自动化必须使用项目管理的独立浏览器/Profile。Pi Agent 不得给用户日常 Edge 加 `--remote-debugging-port`，也不得把普通工作浏览器当作 CDP 会话。

标准流程：

```powershell
npm run browser:start
npm run browser:status
```

`browser:start` 优先使用：

1. `MO2_AUTOMATION_BROWSER` 指定的浏览器；
2. 项目已安装的 Chrome for Testing；
3. 系统 Chrome；
4. 若都不存在，首次启动自动下载官方 Chrome for Testing。

自动化 Profile 默认位于用户本地数据目录下的：

```text
TES5-MO2-AutoUpdate/browser-profile
```

项目会在 Profile 中建立随机 marker，并在浏览器中保留一个 sentinel 标签页。只有同时满足以下条件才视为合法自动化会话：

- CDP 端口可访问；
- Profile marker 存在；
- CDP target 中存在与 marker token 对应的 sentinel。

如果 9222 已被其他浏览器占用，会产生：

```text
BROWSER_PROFILE_MISMATCH
```

这是**安全熔断**。Agent 必须让用户关闭当前使用远程调试的普通浏览器实例，然后通过 `npm run browser:start` 启动项目专用浏览器。不得接管、关闭或继续操作不受管理的浏览器。

兼容入口 `scripts/start-cdp-edge.cmd` 已改为调用 browser manager，不再直接启动 Edge。

## 2. 默认只审计

先运行：

```powershell
npm run check
npm test
npm run browser:start
node index.js "<MO2 mods>" "<Nexus API key file>" --force-refresh
```

没有用户明确授权时，不得加 `--go`。

每次运行的证据会写入：

```text
.runtime/runs/<timestamp>/
  plan.json
  registry-audit.json
  closure.json
  review-queue.json
  review-queue.tsv
  manifest-final.tsv
  final-report.json
  logs/
    pipeline.log
    events.jsonl
    errors.jsonl
  diagnostics/
    environment.json
    failed-items.json
    <failure snapshots>.json
  screenshots/
    <browser failure>.png
```

Pi Agent 优先读取 `review-queue.tsv/json`；执行失败时优先读取 `errors.jsonl + failed-items.json`，不要从头猜。

## 3. 不允许自行猜 Main File

`check-outdated.js` 只有在高置信情况下才允许保留 `DOWNLOAD`。

以下状态必须核验，不能手工改成 DOWNLOAD：

- `HOLD_MULTI_SOURCE`
- `HOLD_UNRESOLVED_LOCAL`
- `HOLD_LOW_CONFIDENCE`
- `HOLD_AMBIGUOUS`
- `HOLD_SAME_VERSION_REPLACEMENT`
- `HOLD_REVIEW`
- `HOLD_API_ERROR`

核验至少使用本地 `meta.ini` / `installationFile` / 精确 fileId、Nexus Files 页面、文件分类、平台/运行时、身形、分辨率、CC、Requirements、版本与文件说明。

**上传时间永远只能是次级证据。** “最新上传”不能单独决定目标文件。

## 4. 本地整合包画像不是事实源

`profile.js` 只从已装文件名中推导弱画像。证据不足时必须保持 `UNKNOWN`。
禁止因为 Agent 主观认为“这套整合应该是 AE/3BA/2K”而强写画像。

## 5. PATCH / 汉化必须闭合，而且绑定 mainFileId

`config/aux-registry.tsv` 使用 v2 12 列格式：

```text
mainModId  mainFileId  mainVersion  kind  status  auxModId  auxFileId  auxVersion  auxName  checkedAt  evidence  note
```

每个准备自动更新的目标 `mainFileId` 都必须明确回答 PATCH 与 TRANSLATION 是否需要。

合法结论：

- `NONE`：已核验不存在/不需要；
- `REQUIRED`：需要，并填写精确 `auxModId + auxFileId + auxVersion + auxName`；
- `SELF / AUX`：该 modId 本身就是补丁/汉化页，不递归闭合。

`NONE` 必须填写 `checkedAt` 与 `evidence`。如果扫描证据与 NONE 冲突，程序必须产生 `HOLD_CLOSURE_CONFLICT`，Agent 不得绕过。

registry 默认超过 14 天视为过期，需要重新核验。

## 6. REQUIRED 附属文件必须通过 API 二次验证

`audit-registry.js` 会检查 REQUIRED 的 auxModId、auxFileId、OLD/ARCHIVED 状态和版本一致性。未通过 `registry-audit.json` 的附属项不得进入下载清单。

## 7. 独立汉化页不能靠文件名关键词判断

确认某个 Nexus modId 是目标主 MOD 的独立汉化页后，该页 MAIN FILE 即使名字没有 `Chinese/汉化/CHS`，也可能是正确汉化文件。关系必须写入 registry。

## 8. 多个 Patch 必须按补丁族处理

JK、USSEP、LOTD、Lux、CC、BodySlide 等可能并列存在。不能把所有 PATCH 折叠成“最新一个”；需要的每一个都应单独记录为 REQUIRED。

## 9. 真实下载前必须通过诊断门禁

可以随时只做体检：

```powershell
node index.js "<mods>" "<api key>" --diagnose
```

真实 `--go` 会自动先执行同样的 Preflight。若环境为 `UNHEALTHY`，程序必须阻止下载。

重点检查：

- Nexus API；
- 项目专用自动化浏览器与 Profile sentinel；
- CDP `127.0.0.1:9222`；
- `nxmhandler.exe`；
- 正确 MO2 进程；
- Downloads 目录与写权限；
- 7-Zip。

不得通过删除健康检查、忽略 `UNHEALTHY` 或强制调用底层 `dl` 来绕过。

## 10. 下载必须由事务执行器负责

真实下载只允许通过：

```powershell
node index.js "<mods>" "<api key>" --go
```

总控按事务逐项执行：

```text
主文件
→ VERIFIED
→ 必需 Patch
→ VERIFIED
→ 必需 Translation
→ VERIFIED
```

若任一项失败，同一事务后续项会被阻断。

状态持久化在：

```text
.runtime/runs/<timestamp>/execution-state.json
```

已经 `VERIFIED` 的 `modId:fileId` 不得重复提交。

## 11. Debug / Flight Recorder 是故障事实源

普通模式记录 INFO/WARN/ERROR；需要更细信息时使用：

```powershell
node index.js "<mods>" "<api key>" --go --debug
```

故障调查顺序固定为：

1. `logs/errors.jsonl`：找到 `errorCode / layer / retryable / action`；
2. `diagnostics/failed-items.json`：定位具体 `tx + modId + fileId`；
3. `execution-state.json`：查看 attempt、submit、verify 状态；
4. 若是 Browser/NXM 错误，再看 `diagnostics/*browser*.json` 与 `screenshots/*.png`；
5. 只有证据表明代码/selector 真有问题时才修改代码。

禁止把完整签名 NXM、Cookie、API key、Authorization 写进 Issue、日志或聊天。Flight Recorder 会主动脱敏，Agent 也必须继续遵守。

## 12. 错误码决定是否允许自动重试

程序只允许对已标记 `retry=true` 的瞬态错误进行有限次数重试，例如：

- `NEXUS_API_429`
- `NEXUS_API_TIMEOUT`
- `CDP_UNAVAILABLE`
- `NXM_EXTRACT_FAILED`
- `NXM_EXPIRED`
- `NXM_HANDLER_FAILED`
- `MO2_QUEUE_NOT_FOUND`
- `MO2_DOWNLOAD_STALLED`
- `VERIFY_TIMEOUT`

以下错误属于安全熔断，**不得自动重试到成功**：

- `BROWSER_PROFILE_MISMATCH`
- `FILEID_MISMATCH`
- `META_MISMATCH`
- `VERSION_MISMATCH`
- `VARIANT_CONFLICT`
- `DOM_SELECTOR_CHANGED`
- `DOM_FILE_NOT_FOUND`
- `CLOSURE_CONFLICT`
- `AMBIGUOUS_MAIN_FILE`

默认提交最多尝试 2 次，可用 `--max-submit-attempts` 调整，但 Agent 不得把次数无限增大来掩盖根因。

## 13. 不允许整批盲目重跑

一个事务失败后：

- 先确定具体 `modId:fileId`；
- 确认错误码是否可重试；
- 只恢复当前精确项；
- 已 VERIFIED 项保持不动；
- 后续 Patch/汉化只有主项重新 VERIFIED 后才可继续。

不要因为一个文件失败就重新提交整个批次。

## 14. 成功的唯一定义

以下都不等于成功：页面点击成功、NXM 已取得、SUBMITTED、MO2 队列出现、LANDED。

只有：

```text
VERIFIED
```

才允许报告“下载完成”。至少要求 `.meta` 的 modID/fileID/版本匹配、归档完整、没有未完成状态，并通过 7-Zip 测试。

## 15. 推荐 Pi Agent 工作循环

1. `git pull`；
2. `npm install`；
3. `npm run check && npm test`；
4. `npm run browser:start`，确认 `browser:status` 为 `MANAGED`；
5. `--diagnose`；
6. 运行 Audit pipeline；
7. 处理 `review-queue.tsv/json`；
8. 更新并审计 `aux-registry.tsv`；
9. 再次 Audit；
10. 用户授权后运行 `--go`；
11. 若失败，读取 `errors.jsonl + failed-items.json`；
12. 按错误码定点恢复，不整批重提；
13. 只报告 VERIFIED；
14. 不安装、不启用、不排序，除非用户另外明确授权。
