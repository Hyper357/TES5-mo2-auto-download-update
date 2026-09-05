# Pi / AI Agent Mandatory Protocol — Precision First

本仓库只自动执行**证据充分且可验证**的 Nexus/MO2 下载。宁可 HOLD，也不能猜 Main、Patch、汉化或重复提交。

## 1. Context budget：先读状态，不要先读全仓库

每次接手先运行：

```powershell
git pull
npm install
npm run check
npm test
npm run agent:status
```

`agent:status` 是默认入口。除非状态明确要求，否则**不要一次性读取 README.md、SKILL.md、docs/v3.*、所有 JSON/log 或整份源码**。

按需读取：

- `ATTENTION` → 先看摘要中的 errorCode；再只读对应 `diagnostics/failed-items.json` 条目。
- `PATCH_REVIEW_REQUIRED` → 只读 `patch-discovery-tasks.tsv` 和对应 discovery item。
- `REVIEW_REQUIRED` → 打开 `npm run review`，不要为多分支问题扫描源码。
- 程序性 bug → 根据 errorCode 只读相关模块；不要先读 60KB 下载器全文。

历史架构文档仅用于维护，不属于正常运行上下文。

## 2. 浏览器隔离是硬门禁

Nexus 自动化只允许项目管理的独立浏览器/Profile：

```powershell
npm run browser:start
npm run browser:status
```

不得给用户日常 Edge 开远程调试。`BROWSER_PROFILE_MISMATCH` 必须停止，不能绕过。

## 3. 默认 AUDIT；真实下载必须有用户授权

```powershell
node index.js "<mods>" "<api-key-file>" --force-refresh
```

只有用户明确允许真实下载时才可：

```powershell
node index.js "<mods>" "<api-key-file>" --go
```

不得直接调用底层下载器绕过总控。下载任务默认**不安装、不启用、不禁用、不排序**。

## 4. Main File：证据不足就 HOLD

Main 必须锚定本地 `installationFile / meta.ini / installed fileId`，结合文件角色、平台/运行时、身形、分辨率、CC、名称族和版本判断。

禁止：

- 仅按上传日期、最大 fileId 或“看起来最新”选择；
- 在平台/运行时 UNKNOWN 时自行发明 AE/SE/VR 等结论；
- 手工把 `HOLD_*` 改成 DOWNLOAD。

存在多个互斥合理 Main 分支时必须 `HOLD_VARIANT_REVIEW`，交给 Review Center。例如 Vanilla / KS / KS HDT 不能由 Agent 猜迁移。

## 5. Patch Discovery + Translation Closure

Main 下载前必须完成 Patch Discovery。检查来源包括：

- 同页 Files；
- `Mods requiring this file`；
- Description / Compatibility；
- `config/patch-relations.tsv`；
- 当前 MO2 已安装环境；
- 可见 FOMOD compatibility 线索。

每个 Patch family 对**精确 mainFileId**必须成为以下之一：

- `REQUIRED`：精确 auxModId + auxFileId + version + name；
- `NOT_APPLICABLE`；
- `ALREADY_INCLUDED`；
- `OBSOLETE`。

覆盖不完整或仍有 `UNRESOLVED` → `HOLD_PATCH_DISCOVERY`。不得用“没看到”推导“没有”。Translation 是独立闭合链，同样不能静默跳过。

REQUIRED aux 必须经 `audit-registry.js` API 二次验真。OLD/ARCHIVED、fileId 不存在、版本不符均不得下载。

## 6. 复杂项目交给 Review Center

自动阶段只处理高置信项目。多分支、多 Patch 或低置信项目集中到：

```powershell
npm run review
```

网页选择只授权报告中已有的 exact `modId:fileId`，不能绕过 Patch coverage、Preflight、执行锁、队列幂等或 VERIFIED。

AI 建议是提示，不是用户授权。

## 7. 执行顺序与成功定义

同一事务顺序：

```text
MAIN → VERIFIED
PATCH family #1 → VERIFIED
PATCH family #2 → VERIFIED
TRANSLATION → VERIFIED
```

任何前项失败，后项阻断。页面点击、获取 NXM、SUBMITTED、MO2 队列出现都**不是成功**；只有 VERIFIED 是成功。

## 8. Queue idempotency + MO2 UI Guard

提交 exact `modId:fileId` 前必须尊重：

- Downloads `.meta/.unfinished.meta/.unfinished`；
- `.runtime/state/submission-ledger.json`；
- `.runtime/state/download-executor.lock`；
- MO2 UI queue state。

已 COMPLETE/INFLIGHT/近期 SUBMITTED → 等待/verify，不重复交 NXM。并行第二个 `--go` 必须因 `CONCURRENT_EXECUTOR` 停止。

重复弹窗仅允许安全动作：

- “已在下载队列中”可靠匹配 → `确定/OK`；
- “重新下载？”可靠匹配 → `否/No/取消`。

绝不自动点 `是/Yes/Re-download`；身份不清 → `MO2_DIALOG_AMBIGUOUS` 并停止 UI 操作。

## 9. 故障处理

固定顺序：

1. `npm run agent:status`；
2. 摘要列出的 errorCode；
3. 对应 `diagnostics/failed-items.json` 条目；
4. 必要时 `execution-state.json` / submission ledger；
5. Browser/NXM 问题才看对应截图/诊断；
6. Patch 问题才看对应 discovery/task。

一个文件失败只处理该 `tx + modId:fileId`。不得整批盲目重跑。VERIFIED 项保持不动。

需要细日志时：

```powershell
node index.js "<mods>" "<api-key-file>" --go --debug
```

## 10. 隐私与禁止事项

不得提交或回显：API key、Cookie、Authorization、完整签名 NXM、浏览器会话数据。`.runtime/` 保持本地。

不得伪造 NONE、删除 HOLD、用 Agent 自己的偏好代替用户选择、坐标盲点 MO2，或在未授权时安装/启用/排序。

**核心原则：Agent 调查证据；确定性程序做门禁；用户决定真正有多个合理答案的分支；VERIFIED 定义完成。**
