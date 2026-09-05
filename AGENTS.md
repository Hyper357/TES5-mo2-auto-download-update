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
- Profile/环境问题 → `npm run environment:status`；
- 程序性 bug → 根据 sourceHints 定点读模块，不先读 60KB 下载器全文。

## 2. MO2 Environment Graph 是当前环境事实源

v4.0 读取当前 MO2 Profile：

```text
modlist.txt
plugins.txt
loadorder.txt
mods/*/meta.ini
顶层 esp/esm/esl 文件
```

Profile 选择证据优先级：

1. `MO2_PROFILE_DIR` / 显式 `--profile-dir`；
2. `MO2_PROFILE_NAME` / 显式 `--profile-name`；
3. `ModOrganizer.ini` 的 selected profile；
4. 只有一个可用 Profile 时才允许唯一推断。

多个 Profile 且无法证明当前使用哪一个 → `PROFILE_UNRESOLVED`。此时**禁止**利用“某 MOD 没启用/没出现”自动推导 `NOT_APPLICABLE`。

查看：

```powershell
npm run environment:status
```

### MO2 红色感叹号不是更新事实源

MO2 UI 的红色感叹号、Nexus 作者填写异常版本/元数据导致的警告，均属于**弱观察信号**：

```text
trustedForUpdateDecision = false
```

Agent 不得因为红感叹号就：

- 判定 MOD 需要更新；
- 判定本地安装损坏；
- 重新下载；
- 改 Main File；
- 触发 `--force-resubmit`。

真正的文件身份依据仍是 `meta.ini / installationFile / exact fileId / Nexus Files API / verified relationship evidence`。

## 3. 浏览器隔离是硬门禁

```powershell
npm run browser:start
npm run browser:status
```

Nexus 自动化只允许项目管理的独立浏览器/Profile。不得给日常 Edge 开远程调试。`BROWSER_PROFILE_MISMATCH` 必须停止，不能绕过。

## 4. 默认 AUDIT；真实下载必须有用户授权

```powershell
node index.js "<mods>" "<api-key-file>" --force-refresh
```

只有用户明确允许真实下载时才可：

```powershell
node index.js "<mods>" "<api-key-file>" --go
```

不得直接调用底层下载器绕过总控。默认不安装、不启用、不禁用、不排序。

## 5. Main File：证据不足就 HOLD

Main 必须锚定本地 `installationFile / meta.ini / installed fileId`，结合文件角色、平台/运行时、身形、分辨率、CC、名称族和版本判断。

如果 Environment Graph 已可靠解析，平台/身形/兼容环境画像只使用**当前 Profile 已启用 MOD**；禁用 MOD 仍可被扫描更新，但不得污染当前运行环境推断。

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

## 6. Generalized Component Discovery + Closure

Main 下载前必须完成 Component Discovery：

```text
RESOURCE MESH TEXTURE PHYSICS BODYSLIDE CONFIG
HOTFIX PATCH TRANSLATION OPTIONAL_COMPONENT
```

证据来源包括同页 Files、Forward/Reverse Requirements、Description、已知独立关系、当前 MO2 Profile、FOMOD 线索。

**发现候选不等于必须下载。** 每个 `kind + family` 对精确 `mainFileId` 必须解释为：

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

`REQUIRED` 必须具有 exact `auxModId + auxFileId + auxVersion + auxName`，并通过 API audit。

### v4.0 Environment applicability 的自动边界

自动环境结论只开放给极窄场景：

```text
PATCH / HOTFIX
+ 已知 compatibility family
+ active Profile 已可靠解析
+ counterpart 明确未启用（disabled-only 或确实 absent）
→ high-confidence NOT_APPLICABLE
```

除此以外不允许因为“当前环境没看到”而自动排除。

特别是 Forward Requirements / `RESOURCE`：

```text
依赖 disabled / absent
→ REQUIRED_DEPENDENCY_DISABLED / REQUIRED_DEPENDENCY_ABSENT
→ 继续 HOLD
```

绝不能当作 `NOT_APPLICABLE`。

覆盖不完整或 unresolved → `HOLD_COMPONENT_DISCOVERY`；Registry 缺失/过期/冲突 → `HOLD_COMPONENT_CLOSURE` / `HOLD_CLOSURE_CONFLICT`。

## 7. 复杂项目交给 Review Center

```powershell
npm run review
```

Review Center 会显示当前 Profile、每个 MOD 的 `ENABLED/DISABLED/UNLISTED` 状态以及 Component 的 Environment reason/evidence。

网页选择只授权服务器报告中已有的 exact `modId:fileId`。AI 建议、Requirements 指向、本地 Profile 命中都只是证据提示，不是用户授权。

如果 Main 已经高置信选对，只是 Component Discovery HOLD，Review item 必须保留 exact Main target；组件解决后 reviewed transaction 必须恢复 Main。

## 8. 成功定义

页面点击、拿到 NXM、SUBMITTED、MO2 队列出现都不是成功；只有：

```text
VERIFIED
```

才算完成。同一事务中的 Main 和所有确认的 REQUIRED Components 都必须逐项 VERIFIED。

## 9. Queue idempotency + MO2 UI Guard

提交 exact `modId:fileId` 前必须尊重：

- Downloads `.meta/.unfinished.meta/.unfinished`；
- `.runtime/state/submission-ledger.json`；
- `.runtime/state/download-executor.lock`；
- MO2 UI queue state。

已 COMPLETE/INFLIGHT/近期 SUBMITTED → 等待/verify，不重复提交 NXM。

重复弹窗只允许：可靠匹配“已在下载队列中”→ OK；可靠匹配“重新下载？”→ No/取消。绝不自动点 Yes/Re-download。

## 10. 故障处理与隐私

固定顺序：

1. `npm run agent:status`；
2. Profile 问题先 `npm run environment:status`；
3. errorCode / nextActions；
4. 对应 diagnostics；
5. 必要时 execution-state / ledger；
6. Browser/NXM 才看截图；
7. Component 问题才看 discovery task/item。

一个文件失败只处理该 `tx + modId:fileId`。不得整批盲目重跑。VERIFIED 项保持不动。

不得提交或回显 API key、Cookie、Authorization、完整签名 NXM、浏览器会话数据。`.runtime/` 保持本地。

不得伪造 NONE、删除 HOLD、用 Agent 偏好代替用户选择、把 MO2 红感叹号当更新证据，或在未授权时安装/启用/排序/FOMOD 自动安装。

**核心原则：Profile 文件描述当前环境；exact identity 描述文件身份；Agent 调查证据；确定性程序做门禁；VERIFIED 定义完成。**
