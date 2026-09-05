# TES5 MO2 Auto Download Update

面向 Skyrim SE/AE + Mod Organizer 2 的**证据驱动 Nexus 更新流水线**。

目标不是“尽量多下载”，而是：

> **简单、证据充分的 MOD 自动完成；多分支、多组件、低置信项目集中交给用户确认；只有 VERIFIED 才算成功。**

当前版本：**v3.9 beta**。

## 核心能力

- 以本地 `meta.ini / installationFile / fileId` 为锚点选择正确 Main File；
- 识别 AE/SE/VR、身形、分辨率、CC、Vanilla/KS/HDT 等互斥变体；
- **Variant Decision Memory**：用户明确选择过的 Main 语义分支会被记住；分支消失或环境冲突时重新 HOLD，不自动回退；
- **Component Discovery**：同页 Files、Forward Requirements、Reverse Requirements、Description、本地 MO2、FOMOD 线索；
- **Generalized Component Closure**：`RESOURCE / MESH / TEXTURE / PHYSICS / BODYSLIDE / CONFIG / HOTFIX / PATCH / TRANSLATION / OPTIONAL_COMPONENT`；
- 多分支/多组件/低置信项目延期到本地 Review Center；
- 独立自动化浏览器，不控制日常 Edge；
- `modId:fileId` 精确 NXM 提交、MO2 queue 幂等、跨运行 submission ledger；
- MO2 重复下载弹窗安全 Guard：只允许确定/否，不自动点重新下载；
- Flight Recorder：结构化日志、错误码、诊断快照；
- 事务式执行：Main 与所有用户/registry 确认的 REQUIRED 组件逐项 VERIFIED；
- `agent:status`：给 Pi/AI Agent 的小型状态 API，避免每次读取整个仓库。

## 环境

- Windows + Mod Organizer 2
- Node.js 22+
- Nexus Mods 登录账户
- Nexus API key
- 推荐 Chrome for Testing 作为项目专用自动化浏览器
- 推荐 7-Zip，用于归档完整性验证

路径可通过命令参数/环境变量配置。仓库中的示例路径不是强制默认环境依据。

## 第一次使用

```powershell
git pull
npm install
npm run check
npm test
npm run browser:start
npm run browser:status
```

首次启动专用浏览器后，在该浏览器中登录 Nexus。

环境体检：

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --diagnose
```

## 推荐工作流

### 1. Audit

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --force-refresh
```

Audit 不触发真实下载。

### 2. 看 Agent 精简状态

```powershell
npm run agent:status
```

常见状态：

```text
COMPLETE
READY_FOR_GO
REVIEW_REQUIRED
COMPONENT_REVIEW_REQUIRED
ATTENTION
IN_PROGRESS_OR_ABORTED
```

### 3. 用户授权后真实下载

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --go --debug
```

自动阶段只处理通过全部门禁的高置信 exact fileId。

### 4. 集中处理复杂 MOD

```powershell
npm run review
```

Review Center 会显示：

- 本轮自动请求 / VERIFIED / 失败数量；
- 当前已装 Main 分支与可选 exact Main fileId；
- 用户已记住的 Main 分支；
- 未闭合 Component family；
- `RESOURCE / PHYSICS / BODYSLIDE / HOTFIX / PATCH / TRANSLATION ...` 候选；
- 候选来源、Requirements 提示、本地环境命中、exact `modId:fileId`。

每个组件族必须明确选择：

```text
DOWNLOAD
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
SKIP_FOR_NOW
```

`DOWNLOAD` 只能选择报告中已有的 exact `modId:fileId`，不能由网页任意构造。

## Variant Decision Memory

例如页面同时有：

```text
Vanilla
KS Hairdos Full
KS Hairdos HDT-SMP
```

第一次用户在 Review Center 明确点击 KS HDT 后，本机保存的是语义分支，而不是一次性的 fileId：

```text
.runtime/state/variant-policies.json
```

以后仍有该分支时沿分支更新；如果分支消失、改名或与当前 runtime/body/resolution/CC 环境硬冲突：

```text
HOLD_VARIANT_POLICY_CHANGED
```

查看/清除：

```powershell
npm run variant:status
npm run variant:forget -- <modId>
```

## Generalized Component Closure

Main File 在进入自动下载前，Component Discovery 会检查：

```text
同页 Files
Forward Nexus Requirements
Reverse Mods requiring this file
Description links/text
本地 MO2 环境
本地 FOMOD 线索
已知独立 Patch 关系
```

发现到组件**不等于必须下载**。

每个发现的 Component family 必须对精确 `mainFileId` 得到结论：

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

只有 `REQUIRED` 会进入下载事务，而且必须保存并 audit 精确：

```text
auxModId
auxFileId
auxVersion
auxName
```

如果页面覆盖无法证明完成，或仍有未解决候选：

```text
HOLD_COMPONENT_DISCOVERY
```

如果 registry 规则缺失、过期、冲突或无效：

```text
HOLD_COMPONENT_CLOSURE
HOLD_CLOSURE_CONFLICT
```

Translation 仍保持独立且显式的闭合要求。

详细设计：`docs/v3.9-phase2-component-closure.md`。

## Reviewed Main 恢复

如果 Main 已经由确定性选择器选对，只是因为 Component Discovery 未闭合而被 HOLD，Review Center 会保留该 exact Main target。

用户解决组件后，reviewed download 会恢复为一个事务：

```text
exact Main target
+ exact selected REQUIRED components
```

不会只下载补丁/资源却漏掉原本被 HOLD 的 Main。

## 下载成功的定义

以下都不算完成：

```text
点击下载
拿到 nxm://
交给 nxmhandler
MO2 队列出现
SUBMITTED
```

只有：

```text
VERIFIED
```

才算成功。

前项失败会阻断同一事务后续项。

## 防重复提交

同一 exact `modId:fileId` 提交前会综合检查：

```text
MO2 Downloads .meta/.unfinished
.runtime/state/submission-ledger.json
.runtime/state/download-executor.lock
MO2 UI queue
```

已 COMPLETE / INFLIGHT / 近期 SUBMITTED 时只等待验证，不再提交第二个 NXM。

```powershell
npm run queue:status
npm run mo2:status
```

## 浏览器隔离

```powershell
npm run browser:install
npm run browser:start
npm run browser:status
npm run browser:stop
```

Pi/自动化只允许连接项目管理的独立浏览器 Profile。9222 被普通浏览器占用时返回：

```text
BROWSER_PROFILE_MISMATCH
```

不会接管日常浏览器。

## Diagnostics

每轮运行位于：

```text
.runtime/runs/<timestamp>/
```

常见文件：

```text
logs/errors.jsonl
diagnostics/failed-items.json
execution-state.json
patch-discovery.json          # 历史文件名；v3.9 Phase 2 内容已是 Component Discovery
patch-discovery-tasks.tsv     # 历史文件名；内容已是 Component tasks
review-center.html
final-report.json
```

不要默认全部读取。先：

```powershell
npm run agent:status
```

然后根据 errorCode / nextActions 定点查看。

## 常用命令

```powershell
npm run check
npm test
npm run agent:status
npm run diagnose
npm run browser:start
npm run browser:status
npm run variant:status
npm run discover-components
npm run queue:status
npm run mo2:status
npm run review
```

`npm run discover-patches` 保留为兼容别名。

## 安全边界

默认流水线只负责审计和下载。除非用户另行明确授权，否则不会：

- 安装 MOD；
- 自动操作 FOMOD 安装器；
- 启用/禁用 MOD；
- 调整 MO2 左侧顺序；
- 修改插件排序；
- 删除旧归档；
- 强制重新下载已经在途的文件。

不得提交或打印 Nexus API key、Cookie、Authorization、完整签名 NXM 或私有浏览器会话数据。

## 代码结构

```text
index.js                           流水线协调器
scripts/check-outdated.js          Main 选择 + 同页 Component 候选
scripts/discover-patches.js        历史文件名；现为 Component Discovery 页面调查
scripts/closure-gate.js            Generalized Component Closure
scripts/review-*.js                人工复核服务/执行
scripts/execute-plan.js            VERIFIED 事务执行器
scripts/nexus-autodl.js            Nexus/NXM/MO2 底层驱动
scripts/agent-status.js            Agent 精简状态入口
scripts/lib/component-discovery.js Component 分类/解析/闭合决策模型
scripts/lib/variant-policy.js      用户 Main 分支记忆
web/review/                        Review Center 前端源码
config/aux-registry.tsv            精确 Component 决策
config/patch-relations.tsv         已知独立 Patch 页面关系
```

AI Agent 强制规则见 `AGENTS.md`；任务操作指南见 `SKILL.md`；历史架构演进见 `docs/`。
