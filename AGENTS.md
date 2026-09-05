# Pi / AI Agent Mandatory Protocol — Precision First

本仓库只自动执行**证据充分且可验证**的 Nexus/MO2 下载。宁可 HOLD，也不能猜 Main、Component、汉化或重复提交。

## 1. Context budget：先读状态，不要先读全仓库

每次接手先运行：

```powershell
git pull
npm install
npm run check
npm test
npm run agent:status
```

`agent:status` 是默认入口。除非状态明确要求，否则不要一次性读取 README、SKILL、所有历史 docs、全部 JSON/log 或整份源码。

按需读取：

- `ATTENTION` → errorCode → 对应诊断条目/最小模块；
- `COMPONENT_REVIEW_REQUIRED` → 只看 component discovery tasks 和对应 item；
- `REVIEW_REQUIRED` → `npm run review`；
- 程序性 bug → 根据 sourceHints 定点读模块，不先读 60KB 下载器全文。

## 2. 浏览器隔离是硬门禁

```powershell
npm run browser:start
npm run browser:status
```

Nexus 自动化只允许项目管理的独立浏览器/Profile。不得给日常 Edge 开远程调试。`BROWSER_PROFILE_MISMATCH` 必须停止，不能绕过。

## 3. 默认 AUDIT；真实下载必须有用户授权

```powershell
node index.js "<mods>" "<api-key-file>" --force-refresh
```

只有用户明确允许真实下载时才可：

```powershell
node index.js "<mods>" "<api-key-file>" --go
```

不得直接调用底层下载器绕过总控。默认不安装、不启用、不禁用、不排序。

## 4. Main File：证据不足就 HOLD

Main 必须锚定本地 `installationFile / meta.ini / installed fileId`，结合文件角色、平台/运行时、身形、分辨率、CC、名称族和版本判断。

禁止：

- 仅按上传日期、最大 fileId 或“看起来最新”选择；
- 在环境 UNKNOWN 时自行发明 AE/SE/VR/身形等结论；
- 手工把 `HOLD_*` 改成 DOWNLOAD。

存在多个互斥合理 Main 分支时必须交给 Review Center。

### Variant Decision Memory

用户明确点击过的 Main 语义分支可以保存到本机 `.runtime/state/variant-policies.json`。

规则：

- 记 `branchKey`，不记一次性 fileId；
- 新版本同分支仍存在且与当前环境无硬冲突时可沿分支更新；
- 分支消失/结构变化/环境冲突 → `HOLD_VARIANT_POLICY_CHANGED`；
- 绝不自动回退到 Vanilla/另一身形/另一 runtime；
- `GENERIC` 分支不能持久化。

查看/清除：

```powershell
npm run variant:status
npm run variant:forget -- <modId>
```

## 5. Generalized Component Discovery + Closure

Main 下载前必须完成 Component Discovery。组件类型包括：

```text
RESOURCE
MESH
TEXTURE
PHYSICS
BODYSLIDE
CONFIG
HOTFIX
PATCH
TRANSLATION
OPTIONAL_COMPONENT
```

检查来源包括：

- 同页 Files；
- **Forward Nexus Requirements**：Main 自己需要的依赖/资源；
- Reverse `Mods requiring this file`：独立 Patch/Translation/附属页；
- Description links/text；
- `config/patch-relations.tsv`；
- 当前 MO2 已安装环境；
- 本地 FOMOD 组件线索。

**发现到候选不等于必须下载。** 每个发现的 `kind + family` 对精确 `mainFileId` 必须解释为：

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

`REQUIRED` 必须有精确：

```text
auxModId
auxFileId
auxVersion
auxName
```

并经 `audit-registry.js` API 二次验真。

覆盖不完整或仍有 unresolved → `HOLD_COMPONENT_DISCOVERY`。Registry 缺失/过期/冲突 → `HOLD_COMPONENT_CLOSURE` 或 `HOLD_CLOSURE_CONFLICT`。

不得：

- 因为文件在 Optional Files 就自动下载；
- 因为 Forward Requirements 有 `requiredHint` 就跳过 exact fileId 验证；
- 用一个 `NONE` 覆盖已经发现的候选；
- 把 `NOT_APPLICABLE` 当成无证据的默认答案。

Translation 仍是独立且显式的闭合链，不能静默跳过。

## 6. 复杂项目交给 Review Center

```powershell
npm run review
```

网页选择只授权服务器报告中已有的 exact `modId:fileId`。Component family 可以选择：

```text
DOWNLOAD
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
SKIP_FOR_NOW
```

AI 建议、`requiredHint`、本地环境命中都只是证据提示，不是用户授权。

如果 Main 已经高置信选对，只是 Component Discovery 把它 HOLD，Review item 必须保留 exact Main target；用户解决组件后 reviewed transaction 必须恢复 Main，而不是只下载附属文件。

## 7. 成功定义

页面点击、拿到 NXM、SUBMITTED、MO2 队列出现都不是成功；只有：

```text
VERIFIED
```

才算完成。

同一事务中的 Main 和所有确认的 REQUIRED Components 都必须逐项 VERIFIED；任一项失败，后续项阻断。

## 8. Queue idempotency + MO2 UI Guard

提交 exact `modId:fileId` 前必须尊重：

- Downloads `.meta/.unfinished.meta/.unfinished`；
- `.runtime/state/submission-ledger.json`；
- `.runtime/state/download-executor.lock`；
- MO2 UI queue state。

已 COMPLETE/INFLIGHT/近期 SUBMITTED → 等待/verify，不重复提交 NXM。

重复弹窗只允许安全动作：

- “已在下载队列中”可靠匹配 → `确定/OK`；
- “重新下载？”可靠匹配 → `否/No/取消`。

绝不自动点 `是/Yes/Re-download`；身份不清 → `MO2_DIALOG_AMBIGUOUS`。

## 9. 故障处理

固定顺序：

1. `npm run agent:status`；
2. errorCode / nextActions；
3. 对应 diagnostics 条目；
4. 必要时 execution-state / ledger；
5. Browser/NXM 才看浏览器截图/诊断；
6. Component 问题才看 discovery task/item。

一个文件失败只处理该 `tx + modId:fileId`。不得整批盲目重跑。VERIFIED 项保持不动。

## 10. 隐私与禁止事项

不得提交或回显：API key、Cookie、Authorization、完整签名 NXM、浏览器会话数据。`.runtime/` 保持本地。

不得伪造 NONE、删除 HOLD、用 Agent 偏好代替用户选择、坐标盲点 MO2，或在未授权时安装/启用/排序/FOMOD 自动安装。

**核心原则：Agent 调查证据；确定性程序做门禁；用户决定真正有多个合理答案的分支/组件；VERIFIED 定义完成。**
