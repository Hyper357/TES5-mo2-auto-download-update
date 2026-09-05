# AI Agent Mandatory Protocol — Precision First

本仓库的目标不是“尽量多下载”，而是：**只自动下载能够被程序证据链证明正确的文件，并在失败时保留足够证据供 Agent 定点恢复。**
任何 Agent（包括 Pi Agent）都必须服从程序门禁，不能通过改清单动作、删除 HOLD、伪造 NONE 结论来绕过。

## 1. 默认只审计

先运行：

```powershell
npm run check
npm test
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

## 2. 不允许自行猜 Main File

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

## 3. 本地整合包画像不是事实源

`profile.js` 只从已装文件名中推导弱画像。证据不足时必须保持 `UNKNOWN`。
禁止因为 Agent 主观认为“这套整合应该是 AE/3BA/2K”而强写画像。

## 4. PATCH / 汉化必须闭合，而且绑定 mainFileId

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

## 5. REQUIRED 附属文件必须通过 API 二次验证

`audit-registry.js` 会检查 REQUIRED 的 auxModId、auxFileId、OLD/ARCHIVED 状态和版本一致性。未通过 `registry-audit.json` 的附属项不得进入下载清单。

## 6. 独立汉化页不能靠文件名关键词判断

确认某个 Nexus modId 是目标主 MOD 的独立汉化页后，该页 MAIN FILE 即使名字没有 `Chinese/汉化/CHS`，也可能是正确汉化文件。关系必须写入 registry。

## 7. 多个 Patch 必须按补丁族处理

JK、USSEP、LOTD、Lux、CC、BodySlide 等可能并列存在。不能把所有 PATCH 折叠成“最新一个”；需要的每一个都应单独记录为 REQUIRED。

## 8. 真实下载前必须通过诊断门禁

可以随时只做体检：

```powershell
node index.js "<mods>" "<api key>" --diagnose
```

真实 `--go` 会自动先执行同样的 Preflight。若环境为 `UNHEALTHY`，程序必须阻止下载。

重点检查：

- Nexus API；
- CDP `127.0.0.1:9222`；
- Nexus 登录浏览器；
- `nxmhandler.exe`；
- 正确 MO2 进程；
- Downloads 目录与写权限；
- 7-Zip。

不得通过删除健康检查、忽略 `UNHEALTHY` 或强制调用底层 `dl` 来绕过。

## 9. 下载必须由事务执行器负责

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

## 10. Debug / Flight Recorder 是故障事实源

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

## 11. 错误码决定是否允许自动重试

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

- `FILEID_MISMATCH`
- `META_MISMATCH`
- `VERSION_MISMATCH`
- `VARIANT_CONFLICT`
- `DOM_SELECTOR_CHANGED`
- `DOM_FILE_NOT_FOUND`
- `CLOSURE_CONFLICT`
- `AMBIGUOUS_MAIN_FILE`

默认提交最多尝试 2 次，可用 `--max-submit-attempts` 调整，但 Agent 不得把次数无限增大来掩盖根因。

## 12. 不允许整批盲目重跑

一个事务失败后：

- 先确定具体 `modId:fileId`；
- 确认错误码是否可重试；
- 只恢复当前精确项；
- 已 VERIFIED 项保持不动；
- 后续 Patch/汉化只有主项重新 VERIFIED 后才可继续。

不要因为一个文件失败就重新提交整个批次。

## 13. 成功的唯一定义

以下都不等于成功：页面点击成功、NXM 已取得、SUBMITTED、MO2 队列出现、LANDED。

只有：

```text
VERIFIED
```

才允许报告“下载完成”。至少要求 `.meta` 的 modID/fileID/版本匹配、归档完整、没有未完成状态，并通过 7-Zip 测试。

## 14. 推荐 Pi Agent 工作循环

1. `npm run check && npm test`；
2. `--diagnose`；
3. 运行 Audit pipeline；
4. 处理 `review-queue.tsv/json`；
5. 更新并审计 `aux-registry.tsv`；
6. 再次 Audit；
7. 用户授权后运行 `--go`；
8. 若失败，读取 `errors.jsonl + failed-items.json`；
9. 按错误码定点恢复，不整批重提；
10. 只报告 VERIFIED；
11. 不安装、不启用、不排序，除非用户另外明确授权。
