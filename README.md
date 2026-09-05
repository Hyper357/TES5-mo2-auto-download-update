# TES5 MO2 Auto Download Update

面向 Skyrim SE/AE + Mod Organizer 2 的**证据驱动 Nexus 更新流水线**。

> **简单、证据充分的 MOD 自动完成；多分支、多组件、低置信项目集中交给用户确认；只有 VERIFIED 才算成功。**

当前版本：**v4.0 beta**。

## 核心能力

- exact `meta.ini / installationFile / fileId` 锚定正确 Main File；
- **MO2 Environment Graph**：读取 active Profile 的 `modlist.txt / plugins.txt / loadorder.txt`；
- 只用当前 Profile **已启用** MOD 推断 runtime/body/compatibility 环境；禁用 MOD 仍可扫描更新，但不污染当前环境判断；
- Variant Decision Memory：记住用户确认过的 Main 语义分支；
- Generalized Component Discovery/Closure：`RESOURCE / MESH / TEXTURE / PHYSICS / BODYSLIDE / CONFIG / HOTFIX / PATCH / TRANSLATION / OPTIONAL_COMPONENT`；
- Forward Requirements 查 Main 自己的依赖，Reverse Requirements 查独立 Patch/附属页；
- 多分支/多组件/低置信项目延期到本地 Review Center；
- Browser Isolation、exact NXM handoff、MO2 queue 幂等、UI Guard、Flight Recorder；
- Main 与所有 REQUIRED Components 必须逐项 VERIFIED；
- `agent:status` 提供给 Pi/AI 的小型状态接口。

## v4.0：MO2 Environment Graph

环境图的事实源是：

```text
<profile>/modlist.txt
<profile>/plugins.txt
<profile>/loadorder.txt
mods/*/meta.ini
mods/*/*.esp|esm|esl
```

查看当前解析结果：

```powershell
npm run environment:status
```

常见输出包括：

```text
profileName
profileSource
enabledMods
disabledMods
unlistedMods
pluginsEnabled
missingModlistEntries
```

### Active Profile 怎么确定

优先级：

1. `MO2_PROFILE_DIR`；
2. `MO2_PROFILE_NAME`；
3. `ModOrganizer.ini` 的 selected profile；
4. 只有一个 Profile 时才唯一推断。

如果存在多个 Profile 又无法证明当前使用哪一个：

```text
PROFILE_UNRESOLVED
```

此时程序仍可扫描更新，但**不会使用缺席/禁用状态自动做兼容性 NOT_APPLICABLE 推断**。

### MO2 红色感叹号不等于 MOD 有问题

MO2/Nexus 的版本元数据可能由作者填写异常，从而产生红色感叹号或版本警告。v4.0 明确规定：

```text
MO2 UI warning icon = observational signal only
trustedForUpdateDecision = false
```

因此红感叹号本身不会触发：

- 更新；
- 重下；
- Main 分支切换；
- 文件损坏结论；
- `--force-resubmit`。

真正决定文件身份的是：

```text
meta.ini
installationFile
exact fileId
Nexus Files API
verified relationship evidence
```

## Environment Graph 如何减少人工 Patch 判断

例如当前 Profile：

```text
+ USSEP
+ KS Hairdos HDT-SMP
- Lux
```

发现候选：

```text
USSEP compatibility patch
Lux compatibility patch
Required Framework
```

v4.0 可以得出：

```text
USSEP patch
→ counterpart ENABLED
→ 仍需确认 REQUIRED / INCLUDED / OBSOLETE

Lux patch
→ counterpart DISABLED_ONLY
→ high-confidence NOT_APPLICABLE

Required Framework
→ 如果未启用/不存在
→ REQUIRED_DEPENDENCY_DISABLED / ABSENT
→ HOLD，而不是 NOT_APPLICABLE
```

自动环境排除严格限定为：

```text
PATCH / HOTFIX
+ recognized compatibility family
+ active Profile 已可靠解析
+ counterpart 明确 disabled-only / absent
```

`RESOURCE / PHYSICS / BODYSLIDE / TEXTURE` 等不会因为“没看到”就自动排除。

## 推荐工作流

第一次/更新代码：

```powershell
git pull
npm install
npm run check
npm test
npm run environment:status
npm run browser:start
npm run browser:status
```

先 Audit：

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --force-refresh
```

看精简状态：

```powershell
npm run agent:status
```

需要人工复核：

```powershell
npm run review
```

用户明确授权后真实下载：

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --go --debug
```

## Review Center

Review Center 会显示：

- active MO2 Profile；
- 当前 MOD 的 `ENABLED / DISABLED / UNLISTED` 状态；
- Main 分支与 exact fileId；
- Component family；
- Forward/Reverse Requirements 证据；
- Environment reason，例如：
  - `COMPAT_COUNTERPART_ENABLED`
  - `REQUIRED_DEPENDENCY_DISABLED`
  - `REQUIRED_DEPENDENCY_ABSENT`
- 用户记住的 Main 分支。

Component 决策仍然是：

```text
DOWNLOAD
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
SKIP_FOR_NOW
```

只有 `DOWNLOAD` 会授权报告中已有的 exact `modId:fileId`。

## Variant Decision Memory

多 Main 页面例如：

```text
Vanilla
KS Hairdos Full
KS Hairdos HDT-SMP
```

用户明确选择一次 KS HDT 后，语义分支保存在：

```text
.runtime/state/variant-policies.json
```

新版本同分支存在且环境无硬冲突时沿分支更新；分支消失/环境变化则 `HOLD_VARIANT_POLICY_CHANGED`，绝不自动退回 Vanilla。

```powershell
npm run variant:status
npm run variant:forget -- <modId>
```

## Component Closure

Main 进入下载前检查：

```text
Same-page Files
Forward Nexus Requirements
Reverse Mods requiring this file
Description links/text
Active MO2 Environment Graph
FOMOD clues
known independent relationships
```

发现组件不等于必须下载。每个 Component family 必须得到：

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

`REQUIRED` 必须具有并 audit：

```text
auxModId
auxFileId
auxVersion
auxName
```

未解决：`HOLD_COMPONENT_DISCOVERY`；规则缺失/过期：`HOLD_COMPONENT_CLOSURE`；冲突：`HOLD_CLOSURE_CONFLICT`。

Translation 仍是独立显式闭合链。

## 成功定义与防重复

这些都不是成功：点击下载、拿到 `nxm://`、SUBMITTED、MO2 队列出现。

只有：

```text
VERIFIED
```

提交 exact `modId:fileId` 前综合检查：

```text
Downloads .meta/.unfinished
submission-ledger.json
download-executor.lock
MO2 UI queue
```

已 COMPLETE/INFLIGHT/近期 SUBMITTED → 等待验证，不重复 NXM。

```powershell
npm run queue:status
npm run mo2:status
```

## Diagnostics / artifacts

每轮：

```text
.runtime/runs/<timestamp>/
```

重要文件：

```text
mo2-environment.json
plan.json
patch-discovery.json          # 历史文件名，内容是 Component Discovery
patch-discovery-tasks.tsv     # 历史文件名，内容是 Component tasks
closure.json
review-center.html
execution-state.json
final-report.json
logs/errors.jsonl
```

先 `npm run agent:status`，再按 errorCode/nextActions 定点读取，不要一次塞整个仓库给 Agent。

## 常用命令

```powershell
npm run check
npm test
npm run agent:status
npm run environment:status
npm run diagnose
npm run browser:start
npm run browser:status
npm run variant:status
npm run discover-components
npm run queue:status
npm run mo2:status
npm run review
```

## 安全边界

默认只负责审计和下载。除非另行明确授权，不会自动安装、操作 FOMOD、启用/禁用 MOD、调整左侧优先级、排序插件或删除归档。

不得提交 Nexus API key、Cookie、Authorization、完整签名 NXM 或私有浏览器会话数据。

## 代码结构

```text
index.js                           流水线协调器
scripts/check-outdated.js          Main 选择 + Environment-aware planning
scripts/lib/mo2-environment.js     Active Profile / mod / plugin 环境图
scripts/environment-status.js      Environment Graph CLI
scripts/discover-patches.js        Component Discovery（历史文件名）
scripts/lib/component-discovery.js Component 分类与 closure decision
scripts/closure-gate.js            Generalized Component Closure
scripts/review-*.js                人工复核服务/执行
scripts/execute-plan.js            VERIFIED 事务执行器
scripts/nexus-autodl.js            Nexus/NXM/MO2 底层驱动
scripts/agent-status.js            Agent 精简状态入口
```

详细 v4.0 设计见 `docs/v4.0-mo2-environment-graph.md`。
