# AI Agent Mandatory Protocol — Precision First

本仓库的目标不是“尽量多下载”，而是：**只自动下载能够被证据链证明正确且附属依赖已闭合的文件。**
Pi Agent/其他 Agent 不得删除 HOLD、伪造 NONE、跳过 discovery/closure/verify 或直接调用底层下载器绕过总控。

## 1. 浏览器隔离

Nexus 自动化必须使用项目管理的独立浏览器/Profile：

```powershell
npm run browser:start
npm run browser:status
```

不得给用户日常 Edge 加 `--remote-debugging-port`。如果 9222 属于非项目浏览器，`BROWSER_PROFILE_MISMATCH` 是硬熔断。

## 2. 默认 AUDIT，真实下载必须走总控

标准开始：

```powershell
git pull
npm install
npm run check
npm test
npm run browser:start
node index.js "<MO2 mods>" "<Nexus API key file>" --force-refresh
```

没有用户明确授权，不得加 `--go`。真实下载只允许：

```powershell
node index.js "<mods>" "<api key>" --go
```

## 3. Main File 不允许猜

Main 必须锚定本地 `installationFile / meta.ini / installed fileId`，再经过角色、平台、运行时、身形、分辨率、CC、版本与名称族判断。
`HOLD_MULTI_SOURCE / HOLD_UNRESOLVED_LOCAL / HOLD_LOW_CONFIDENCE / HOLD_AMBIGUOUS / HOLD_SAME_VERSION_REPLACEMENT / HOLD_REVIEW` 不得手工改成 DOWNLOAD。
上传时间只能是次级证据。

## 4. v3.6 Patch Discovery Graph 是 Main 下载前硬门禁

每个准备更新的 Main target `modId:mainFileId` 必须先生成：

```text
.runtime/runs/<timestamp>/patch-discovery.json
.runtime/runs/<timestamp>/patch-discovery-tasks.tsv
```

Discovery 至少检查：

1. 同一 Nexus 页 Files 中 Patch/Fix/Compatibility；
2. Nexus `Mods requiring this file` 反向 Requirements；
3. Description/Compatibility 中的 Patch 链接与声明；
4. `config/patch-relations.tsv` 中已经学习到的独立 Patch 页；
5. 当前 MO2 已安装 MOD 上下文；
6. 本地可见 FOMOD compatibility 线索。

`Requirements` 或 `Description` 覆盖无法证明完成时，必须：

```text
HOLD_PATCH_DISCOVERY
```

不得用“没看到 Patch”推导“没有 Patch”。

## 5. 每个 Patch family 都必须有结论

Patch 不再是单个 `PATCH=YES/NO`。USSEP、Lux、JK、LOTD、WACCF、CC 等可同时存在。
每个发现的 family 必须对**精确 mainFileId**落到以下之一：

- `REQUIRED`：当前环境需要，填写精确 auxModId + auxFileId + auxVersion + auxName；
- `NOT_APPLICABLE`：候选存在，但对应环境/MOD 不在当前整合中；
- `ALREADY_INCLUDED`：兼容修复已并入主包/当前包；
- `OBSOLETE`：补丁对目标主文件已废弃/被替代。

只要一个候选仍为 `UNRESOLVED`：

```text
HOLD_PATCH_DISCOVERY
```

Agent 不得继续 Main 下载。

## 6. aux-registry v3

新 Patch family 使用 13 列：

```text
mainModId mainFileId mainVersion kind family status auxModId auxFileId auxVersion auxName checkedAt evidence note
```

`checkedAt + evidence` 必须真实填写。结论默认 14 天过期。
`PATCH NONE` 不能覆盖已经发现的 candidate family；Discovery 完整且候选数为 0 时，程序可直接证明 Patch closure。
旧 v2 仍可解析用于迁移；新的 family 决策应写 v3。

## 7. 独立 Patch 页如何学习

如果 Requirements/Description/Pi 核验确认一个独立 Nexus 页面是主 MOD 的 Patch Hub/兼容补丁页，把关系加入：

```text
config/patch-relations.tsv
mainModId  auxModId  family  source  note
```

这只是“下次必须检查该页面”的发现关系，**不是 REQUIRED 批准**。是否下载仍由 aux-registry 对当前 mainFileId 的 family 决策决定。

## 8. REQUIRED 附属必须 API 二次验真

`audit-registry.js` 对 REQUIRED 的 `auxModId + auxFileId + version` 做 Nexus API 校验。OLD/ARCHIVED、fileId 不存在、版本不符都不能进入 manifest。

## 9. Translation 仍必须闭合

TRANSLATION 与 PATCH 是两条独立闭合链。独立汉化页的 MAIN FILE 名字不一定包含 Chinese/汉化/CHS；已确认关系时以精确页面/fileId 证据为准。

## 10. 事务顺序

最终执行器按同一 tx：

```text
MAIN
→ VERIFIED
→ REQUIRED PATCH family #1
→ VERIFIED
→ REQUIRED PATCH family #2
→ VERIFIED
→ TRANSLATION
→ VERIFIED
```

任何一项失败，后续依赖项阻断。页面点击、NXM 获取、SUBMITTED、MO2 队列出现都不算完成；只有 `VERIFIED` 算成功。

## 11. Queue-aware idempotency

提交同一 `modId:fileId` 前必须检查：

```text
MO2 Downloads .meta/.unfinished.meta/.unfinished
.runtime/state/submission-ledger.json
.runtime/state/download-executor.lock
MO2 UI queue state
```

已 COMPLETE/INFLIGHT/近期 SUBMITTED 的目标只等待/verify，不再次交 NXM。并发第二个 `--go` 必须因 `CONCURRENT_EXECUTOR` 停止。
`--force-resubmit` 只有用户明确授权且证据证明旧提交不存在时才能使用。

## 12. MO2 UI Guard

重复弹窗只允许：

- 可靠匹配“已在下载队列中” → `确定/OK`；
- 可靠匹配“重新下载？” → `否/No/取消`。

绝对不得自动点击 `是(Y)/Yes/Retry/Re-download/Download`。身份不明确必须 `MO2_DIALOG_AMBIGUOUS` 并停止 UI 操作；不得坐标点击或发送 Enter/Y 作为回退。

## 13. Debug / Flight Recorder

故障调查固定顺序：

1. `logs/errors.jsonl`；
2. `diagnostics/failed-items.json`；
3. `execution-state.json`；
4. `submission-ledger.json` + `npm run queue:status`；
5. Browser/NXM 问题再看 browser diagnostics/screenshots；
6. Patch 问题先看 `patch-discovery.json` 和 `patch-discovery-tasks.tsv`。

需要细日志：

```powershell
node index.js "<mods>" "<api key>" --go --debug
```

不得泄露 API key、Cookie、Authorization 或完整签名 NXM。

## 14. Agent 处理 Patch Discovery task 的规则

看到 `patch-discovery-tasks.tsv`：

- `COVERAGE:*`：补足页面覆盖；不能直接写 NONE；
- `UNRESOLVED_PATCH`：核对候选页面、Main 目标版本、当前 MO2 已装环境；
- 若 REQUIRED：找到正确当前文件的精确 fileId，不得按“最新 fileId”猜；
- 若 NOT_APPLICABLE：evidence 必须指出当前环境缺少哪个 counterpart；
- 若 ALREADY_INCLUDED/OBSOLETE：必须引用作者说明、changelog、文件说明等具体证据；
- 确认独立 Patch 页后可更新 `patch-relations.tsv`，让后续版本自动重新发现。

修改 registry 后必须重新 Audit，直到：

```text
coverageProblems = 0
unresolvedPatchCandidates = 0
HOLD_PATCH_DISCOVERY = 0
```

才有资格进入 `--go`。

## 15. 不允许整批盲目重跑

一个文件失败时只处理精确 `tx + modId:fileId`。已经 VERIFIED 的保持不动；SUBMITTED/INFLIGHT 的等待验证；Main 未 VERIFIED 时不得提前提交其 Patch/汉化。

## 16. 推荐 Pi Agent 循环

1. `git pull`；
2. `npm install`；
3. `npm run check && npm test`；
4. `npm run browser:start`，确认 MANAGED；
5. `--diagnose`；
6. `npm run queue:status`；
7. 运行 Audit；
8. 先处理 `patch-discovery-tasks.tsv`；
9. 再处理 `review-queue.tsv/json`；
10. 更新 `patch-relations.tsv`（有新独立 Patch 关系时）与 `aux-registry.tsv` v3；
11. 重新 Audit + registry audit；
12. 只有全部门禁通过且用户授权后运行唯一一个 `--go`；
13. 失败按 Flight Recorder 定点恢复；
14. 只报告 VERIFIED；
15. 不安装、不启用、不排序，除非用户另行明确授权。
