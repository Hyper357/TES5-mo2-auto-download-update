# Pi / AI Agent Mandatory Protocol — Precision First

本仓库只自动执行**证据充分且可验证**的 Nexus/MO2 下载。宁可 HOLD，也不能猜“是否需要更新”、Main、Component、汉化或重复提交。

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

- `UPDATE_REVIEW_REQUIRED` → `npm run updates:status`；
- `ATTENTION` → errorCode → 对应诊断条目/最小模块；
- `COMPONENT_REVIEW_REQUIRED` → 只看 component discovery tasks 和对应 item；
- `REVIEW_REQUIRED` → `npm run review`；
- Profile/环境问题 → `npm run environment:status`；
- 程序性 bug → 根据 sourceHints 定点读模块，不先读 60KB 下载器全文。

### 用户意图分流：不要把完整更新错误地停在 Audit

以下表达视为**完整更新授权**：

```text
开始项目
开始更新
跑完整流程
更新我的 MOD
开始完整更新
```

Agent 完成自检后应直接运行：

```powershell
npm run update
```

`npm run update` 本身代表：允许对**通过全部 Update Eligibility / Main / Variant / Component Closure / Preflight 安全门禁**的高置信项目进行真实下载。不要在 Audit 完成、列出 `UPDATE_CONFIRMED` 后再次问“是否开始下载”。

以下表达才是**只审计**：

```text
检查一下
扫描一下
看看有哪些更新
只审计
不要下载
```

此时运行：

```powershell
npm run audit
```

完整更新模式中：

- 高置信且闭合的安全项继续自动下载并逐项 VERIFIED；
- 多分支、资格不确定、Component/Patch 未闭合或冲突项自动延期到 Review Center；
- 单个 MOD/NXM/CDN 临时失败不得让其余安全项停工，保持失败项 NOT VERIFIED 并继续；
- 自动阶段结束后自动打开 Review Center（若存在人工项）；
- 只有真正的硬门禁/环境不可信才允许整条流水线停止。

## 2. Update Eligibility 是所有更新逻辑的第一门禁

在讨论 Main、分支、Patch、Resource 之前，必须先回答：

> **这个 MOD 真的需要更新吗？**

固定顺序：

```text
Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ Download
→ VERIFIED
```

证据优先级：

1. Nexus exact `file_updates`：`old_file_id -> new_file_id`；
2. 确实晚于已装 exact file 的兼容新上传；
3. MO2 黄色下载箭头的等价 metadata signal；
4. `version/newestVersion` 字符串；
5. MO2 红感叹号 / Nexus 作者元数据警告。

第 5 类**不得进入更新真值判定**。

### MO2 黄色箭头

黄色箭头很有价值，应该优先检查，但只是候选优先级，不是 DOWNLOAD 授权。

项目从 `meta.ini` 读取：

```text
version
newestVersion
ignoredVersion
nexusFileStatus
```

如果 MO2 认为有更新，但 Nexus Files API 无法证明 exact successor 或真正更晚的兼容文件：

```text
SKIP_METADATA_FALSE_POSITIVE
```

不得继续 Main/Component/下载流程。

如果 MO2 没亮箭头，但 Nexus exact chain/新上传明确证明更新：

```text
UPDATE_CONFIRMED
```

仍然必须处理。

### Update Eligibility 状态

```text
UPDATE_CONFIRMED
HOLD_UPDATE_ELIGIBILITY
SKIP_METADATA_FALSE_POSITIVE
SKIP_UP_TO_DATE
SKIP_IGNORED_UPDATE
```

查看：

```powershell
npm run updates:status
```

`HOLD_UPDATE_ELIGIBILITY` 是上游 HOLD。Review Center 可以展示证据，但**不得直接生成 Main DOWNLOAD**，否则会绕过 Component Closure。必须先把更新资格确认清楚，再进入后续流程。

## 3. MO2 Environment Graph 是当前环境事实源

v4.0+ 读取当前 MO2 Profile：

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

MO2 UI 的红色感叹号、Nexus 作者填写异常版本/元数据导致的警告，均属于弱观察信号：

```text
trustedForUpdateDecision = false
```

Agent 不得因为红感叹号就判定需要更新、本地损坏、重新下载、迁移 Main 或触发 `--force-resubmit`。

真正的文件身份依据仍是 `meta.ini / installationFile / exact fileId / Nexus Files API / verified relationship evidence`。

## 4. 浏览器隔离是硬门禁

```powershell
npm run browser:start
npm run browser:status
```

Nexus 自动化只允许项目管理的独立浏览器/Profile。不得给日常 Edge 开远程调试。`BROWSER_PROFILE_MISMATCH` 必须停止，不能绕过。

`npm run update` 与 `npm run audit` 会先确保项目管理浏览器启动，再进入总控流水线。

## 5. 启动语义：FULL UPDATE 与 AUDIT ONLY

### FULL UPDATE：完整流水线，不在 Audit 后再次询问

当用户表达“开始项目/开始更新/跑完整流程”等完整更新意图时：

```powershell
npm run update
```

其固定语义为：

```text
浏览器/Preflight
→ 全库扫描
→ Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ 自动下载全部高置信安全项
→ 单项失败继续其余事务
→ 全局 VERIFIED
→ 自动打开 Review Center（若有人工项）
```

Agent **不得**在以下中间节点停下来重新索取方向：

- 扫描完成；
- `updates:status` 汇总完成；
- 已找到若干 `UPDATE_CONFIRMED`；
- 已生成 Component/Patch tasks；
- 已区分“自动项”和“人工项”。

这些都是完整更新的一部分，不是新的授权点。

只有以下情况可以整条停止并报告：

- Preflight/浏览器隔离等硬门禁不可信；
- 运行所需关键配置缺失且无法安全推断；
- 程序性故障导致总控无法继续。

普通复杂项应 HOLD 到 Review Center；普通单项下载失败应继续其他事务并在最终汇报标记 NOT VERIFIED。

### AUDIT ONLY：用户明确只想看、不下载

当用户明确说“检查/扫描/只审计/不要下载”时：

```powershell
npm run audit
```

Audit 只生成 Update Eligibility、Main/Component 计划、Review Center 与状态报告，不真实提交 NXM。

不得直接调用底层下载器绕过总控。无论 FULL UPDATE 还是 AUDIT，默认都**不安装、不启用、不禁用、不排序、不自动操作 FOMOD**。

## 6. Main File：只处理 UPDATE_CONFIRMED

Main 必须锚定本地 `installationFile / meta.ini / installed fileId`，结合文件角色、平台/运行时、身形、分辨率、CC、名称族和版本判断。

如果 Environment Graph 已可靠解析，平台/身形/兼容环境画像只使用**当前 Profile 已启用 MOD**；禁用 MOD 仍可被扫描更新，但不得污染当前运行环境推断。

禁止：

- 对 `SKIP_*` 项继续挑 Main；
- 仅按上传日期、最大 fileId 或“看起来最新”选择；
- 在环境 UNKNOWN 时自行发明 AE/SE/VR/身形等结论；
- 手工把 `HOLD_*` 改成 DOWNLOAD。

存在多个互斥合理 Main 分支时必须交给 Review Center。若 Nexus exact update chain 已明确指向当前 exact file 的 successor，且没有 runtime/body/role 硬冲突，可视为当前分支的强证据，不必因为同页其他 Main 自动强制迁移选择。

### Variant Decision Memory

用户明确点击过的 Main 语义分支可保存在 `.runtime/state/variant-policies.json`。记 `branchKey`，不记一次性 fileId；分支消失、结构变化或环境冲突 → `HOLD_VARIANT_POLICY_CHANGED`；绝不自动回退到其他分支。

## 7. Generalized Component Discovery + Closure

只有通过 Update Eligibility 的目标才进入 Component Discovery：

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

环境自动 `NOT_APPLICABLE` 仅开放给极窄的 PATCH/HOTFIX compatibility 场景。Forward Requirements / Resource 缺失或禁用必须继续 HOLD，不能自动排除。

覆盖不完整或 unresolved → `HOLD_COMPONENT_DISCOVERY`；Registry 缺失/过期/冲突 → `HOLD_COMPONENT_CLOSURE` / `HOLD_CLOSURE_CONFLICT`。

## 8. Review Center

```powershell
npm run review
```

Review Center 显示当前 Profile、Update Eligibility 证据、Main 分支以及 Component family。

网页选择只授权服务器报告中已有的 exact `modId:fileId`。AI 建议、黄色箭头、Requirements 指向、本地 Profile 命中都只是证据提示，不是用户授权。

如果 Main 已高置信选对、只是 Component Discovery HOLD，Review item 必须保留 exact Main target；组件解决后 reviewed transaction 必须恢复 Main。

`HOLD_UPDATE_ELIGIBILITY` 不允许从 reviewed download 直接放行 Main。

## 9. 成功定义

页面点击、拿到 NXM、SUBMITTED、MO2 队列出现都不是成功；只有：

```text
VERIFIED
```

才算完成。同一事务中的 Main 和所有确认的 REQUIRED Components 都必须逐项 VERIFIED。

## 10. Queue idempotency + MO2 UI Guard

提交 exact `modId:fileId` 前必须尊重 Downloads `.meta/.unfinished`、submission ledger、executor lock 和 MO2 UI queue state。已 COMPLETE/INFLIGHT/近期 SUBMITTED → 等待/verify，不重复提交 NXM。

重复弹窗只允许可靠匹配后的 OK/No；绝不自动点 Yes/Re-download。

## 11. 故障处理与隐私

固定顺序：

1. `npm run agent:status`；
2. Update Eligibility 问题先 `npm run updates:status`；
3. Profile 问题先 `npm run environment:status`；
4. errorCode / nextActions；
5. 对应 diagnostics；
6. 必要时 execution-state / ledger；
7. Browser/NXM 才看截图；
8. Component 问题才看 discovery task/item。

一个文件失败只处理该 `tx + modId:fileId`。不得整批盲目重跑。VERIFIED 项保持不动。

不得提交或回显 API key、Cookie、Authorization、完整签名 NXM、浏览器会话数据。`.runtime/` 保持本地。

不得伪造 NONE、删除 HOLD、用 Agent 偏好代替用户选择、把 MO2 红感叹号或黄色箭头单独当更新事实，或在未授权时安装/启用/排序/FOMOD 自动安装。

**核心原则：先证明“要不要更新”，再决定“更新哪个文件”；完整更新一旦启动就连续跑到自动阶段终点；复杂项交给 Review Center；exact identity 描述文件身份；Profile 描述当前环境；确定性程序做门禁；VERIFIED 定义完成。**
