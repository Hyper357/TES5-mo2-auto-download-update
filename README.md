# TES5 MO2 Auto Download Update

面向 Skyrim SE/AE + Mod Organizer 2 的**证据驱动 Nexus 更新流水线**。

目标不是“尽量多下载”，而是：

> **简单、证据充分的 MOD 自动完成；多分支、多 Patch、低置信项目集中交给用户确认；只有 VERIFIED 才算成功。**

当前版本：**v3.8 beta**。

## 核心能力

- 以本地 `meta.ini / installationFile / fileId` 为锚点选择正确 Main File；
- 识别 AE/SE/VR、身形、分辨率、CC、Vanilla/KS/HDT 等互斥变体；
- Patch Discovery Graph：同页 Files、Requirements、Description、已知独立 Patch 页面、本地 MO2 环境、FOMOD 线索；
- Patch family 与 Translation 独立闭合；
- 多分支/多 Patch/低置信项目自动延期到本地 Review Center；
- 独立自动化浏览器，不控制日常 Edge；
- `modId:fileId` 精确 NXM 提交、MO2 queue 幂等、跨运行 submission ledger；
- MO2 重复下载弹窗安全 Guard：只允许确定/否，不自动点重新下载；
- Flight Recorder：结构化日志、错误码、诊断快照；
- 事务式执行：`MAIN → PATCH(es) → TRANSLATION`，每项必须 VERIFIED；
- `agent:status`：给 Pi/AI Agent 的小型状态 API，避免每次读取整个仓库。

## 环境

- Windows + Mod Organizer 2
- Node.js 22+
- Nexus Mods 登录账户
- Nexus API key
- 推荐 Chrome for Testing 作为项目专用自动化浏览器
- 7-Zip 推荐安装，用于归档完整性验证

路径可通过命令参数/环境变量配置。仓库中的示例路径不是强制默认环境判断依据。

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

### 1. 先 Audit

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --force-refresh
```

Audit 不触发真实下载。

### 2. 看精简状态

```powershell
npm run agent:status
```

常见状态：

```text
COMPLETE
READY_FOR_GO
REVIEW_REQUIRED
PATCH_REVIEW_REQUIRED
ATTENTION
IN_PROGRESS_OR_ABORTED
```

### 3. 用户授权后真实下载

```powershell
node index.js "E:\SkyrimAE\mo2\mods" "E:\SkyrimAE\tools\.nexus_api_key" --go --debug
```

自动阶段只处理高置信项目。

### 4. 集中处理复杂 MOD

```powershell
npm run review
```

Review Center 会显示：

- 本轮自动请求 / VERIFIED / 失败数量；
- 当前已装 Main 分支；
- 允许选择的 exact Main fileId；
- AI 环境匹配建议（仅建议，不代替用户授权）；
- 未闭合 Patch family；
- Patch 候选、来源、证据、exact modId/fileId。

用户确认后仍会重新执行 Preflight、单执行器锁、queue 幂等和 VERIFIED 验证。

## 为什么复杂 MOD 不再让 AI 硬猜

例如一个 Nexus 页面同时提供：

```text
Vanilla
KS Hairdos Full
KS Hairdos Partial
KS Hairdos HDT-SMP
Hotfix / Optional Patch
```

它们可能都是“最新文件”，但不是同一产品分支。

这种情况程序应返回：

```text
HOLD_VARIANT_REVIEW
```

而不是沿着当前 Vanilla 分支或上传时间自动猜测。用户在 Review Center 选择 KS HDT 后，系统才获得该 exact fileId 的授权。

## Patch Closure

Main File 下载前必须完成 Patch Discovery。

每个发现的 Patch family 必须对**精确 mainFileId**得到结论：

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

存在未解决候选或页面覆盖无法证明完成时：

```text
HOLD_PATCH_DISCOVERY
```

`REQUIRED` 必须保存精确：

```text
auxModId
auxFileId
auxVersion
auxName
```

并通过 Nexus API audit。

Translation 是独立闭合链，不能用 Patch 的结论替代。

## 下载成功的定义

以下都**不算完成**：

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

执行顺序：

```text
MAIN
→ VERIFIED
→ PATCH family #1
→ VERIFIED
→ PATCH family #2
→ VERIFIED
→ TRANSLATION
→ VERIFIED
```

前项失败会阻断后项。

## 防重复提交

同一 exact `modId:fileId` 提交前会综合检查：

```text
MO2 Downloads .meta/.unfinished
.runtime/state/submission-ledger.json
.runtime/state/download-executor.lock
MO2 UI queue
```

已 COMPLETE / INFLIGHT / 近期 SUBMITTED 时只等待验证，不再提交第二个 NXM。

查看：

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

Pi/自动化只允许连接项目管理的独立浏览器 Profile。

如果 9222 被普通 Edge/其他 Profile 占用：

```text
BROWSER_PROFILE_MISMATCH
```

流水线停止，不接管日常浏览器。

## Diagnostics

每轮运行位于：

```text
.runtime/runs/<timestamp>/
```

常见诊断文件：

```text
logs/pipeline.log
logs/events.jsonl
logs/errors.jsonl
diagnostics/failed-items.json
execution-state.json
patch-discovery.json
patch-discovery-tasks.tsv
review-center.html
final-report.json
```

不要默认全部读取。先运行：

```powershell
npm run agent:status
```

然后根据 errorCode/nextActions 定点查看。

## 常用命令

```powershell
npm run check
npm test
npm run agent:status
npm run diagnose
npm run browser:start
npm run browser:status
npm run queue:status
npm run mo2:status
npm run review
```

## 安全边界

默认流水线只负责审计和下载。

除非用户另行明确授权，否则不会：

- 安装 MOD；
- 启用/禁用 MOD；
- 调整 MO2 左侧顺序；
- 修改插件排序；
- 删除旧归档；
- 强制重新下载已经在途的文件。

不得提交或打印 Nexus API key、Cookie、Authorization、完整签名 NXM 或私有浏览器会话数据。

## 代码结构

```text
index.js                         流水线协调器
scripts/check-outdated.js        Main 选择/候选收集
scripts/discover-patches.js      Patch Discovery 页面调查
scripts/closure-gate.js          Patch + Translation 闭合
scripts/execute-plan.js          VERIFIED 事务执行器
scripts/nexus-autodl.js          Nexus/NXM/MO2 底层驱动
scripts/agent-status.js          Agent 精简状态入口
scripts/review-*.js              人工复核服务/执行
scripts/lib/                     确定性业务与公共基础设施
web/review/                      Review Center 前端源码
config/aux-registry.tsv          精确 aux 决策
config/patch-relations.tsv       已知独立 Patch 页面关系
```

AI Agent 的强制规则见 `AGENTS.md`；任务操作指南见 `SKILL.md`；历史架构演进见 `docs/v3.*`。
