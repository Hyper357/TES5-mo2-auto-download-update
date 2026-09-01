# TES5 MO2 Auto Download Update

面向 Skyrim Special Edition / Anniversary Edition 的安全 Nexus 下载与验收工具。它把已登录的 Nexus 文件页中的短时 `nxm://` 链接交给指定的 Mod Organizer 2 实例，并提供精确文件核对、重复检测、MO2 下载队列刷新和 7-Zip 归档验收。

这个项目的目标是“下载和核验”，不是自动安装整合包：它不会安装、启用、禁用、移动或排序模组，也不会修改 `modlist.txt`、`plugins.txt` 或 INI。

## 功能

- 以 `mod ID + file ID` 精确选择 Nexus 文件，避免同名旧文件或错误变体。
- 提供基于 Python + CDP 的全自动静默提取器 (`scripts/auto_nexus_downloader.py`) 与 Node.js 工作流 (`scripts/nexus-autodl.js`)。
- 自动穿透 Nexus Web Component Shadow DOM (`mod-file-download`) 并触发慢速下载。
- 自动处理 5 秒人机校验倒计时，无感提取带合法签名（`key` / `expires` / `user_id`）的真实 NXM 协议流。
- 支持 AE/SE/NG/CC 等版本由清单和 Nexus 文件页共同核对；不按相邻 file ID 猜版本。
- **强制核验 Mod 介绍页面与更新日志 (Description & Changelog)**：在下载和更新前必须核验 Mod 介绍页、前置需求 (Requirements) 和置顶评论，确保目标文件、多子包补丁、游戏本体版本（AE 1.6.1170）与配套汉化 (CHS) 版本完全精确匹配。
- 支持 `DOWNLOAD`、`MANUAL`、`HOLD_PATCH`、`HOLD_TRANSLATION` 等动作字段，人工项不会被误触发。
- 下载前检查 MO2 Downloads 中是否已经存在同一 `modID/fileID` 的完整归档，默认返回 `SKIP_DUPLICATE`。
- 通过 Python `subprocess([nxmhandler, nxm])` 传递完整 NXM 参数，不使用会拆分 `&` 的 `cmd /c start`。
- 把 NXM 提交、MO2 唤醒、归档落盘和 7-Zip 验收分开报告：`SUBMITTED`、`LANDED`、`VERIFIED`。
- 自动刷新 MO2 Downloads；找不到可唤醒的 UI 行时只记录状态，不把已提交的 NXM 误报成失败。
- `verify` 命令按精确 file ID 核对 `.meta`、归档大小、`.unfinished` 残留、版本和 7-Zip 完整性。
- 支持 JSON 输出，方便其他脚本、代理或 GUI 调用。

## 安全边界

本工具不会：

- 回显、保存或复用带 `key`、`expires`、`user_id` 的完整签名 NXM；
- 保存 Nexus 密码、浏览器 Cookie 或 API key；
- 绕过验证码、403、登录拦截或付费下载限制；
- 自动选择 FOMOD、分辨率、互斥补丁、汉化替换版或游戏内容选项；
- 删除旧归档、`.meta`、`.unfinished` 或错误变体。

遇到版本选择、FOMOD 或互斥方案时，应把该行标记为 `MANUAL` / `HOLD_*`，而不是猜测。

## 环境要求

- Windows 10/11
- Node.js 18+
- 当前运行中的 MO2 实例及其 `nxmhandler.exe`
- 已登录 Nexus 的 Edge/Chrome，并通过 CDP 暴露 `127.0.0.1:9222`
- 7-Zip（默认检测 `C:\Program Files\7-Zip\7z.exe`）

安装依赖：

```powershell
npm install
```

## 配置

不要把示例路径当成固定路径。通过环境变量指向实际 MO2 实例：

```powershell
$env:MO2_NXM_HANDLER = 'E:\SkyrimAE\mo2\nxmhandler.exe'
$env:MO2_DOWNLOADS_DIR = 'E:\SkyrimAE\mo2\downloads'
$env:MO2_REFRESH_SCRIPT = "$PWD\scripts\refresh-mo2-downloads.ps1"
$env:MO2_WAKE_SCRIPT = "$PWD\scripts\wake-mo2-download.ps1"
$env:MO2_7Z = 'C:\Program Files\7-Zip\7z.exe'
```

如果没有设置环境变量，脚本会按仓库相邻的 `mo2\` 目录推断 handler、Downloads 和脚本路径；从其他目录克隆时建议显式设置。

## 启动浏览器会话

使用独立浏览器配置，避免污染日常浏览器。登录一次 Nexus 后保持窗口打开：

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  '--user-data-dir=C:\Users\<用户名>\.nexus-mo2-download' `
  '--remote-debugging-port=9222' `
  '--disable-extensions' `
  '--no-first-run' `
  'https://www.nexusmods.com/users/sign-in'
```

如果使用 Chrome，把可执行文件路径替换为 Chrome，并确保端口仍为 9222。不要在报告中复制完整签名 NXM。

检查登录态：

```powershell
node scripts/nexus-autodl.js whoami
```

只有看到用户菜单或 `Sign out` 才能认为登录成功。

## 清单格式

每行使用 TAB 分隔，推荐填写精确 file ID：

```text
modID<TAB>名称子串<TAB>期望版本<TAB>备注<TAB>期望fileID<TAB>动作
```

示例：

```text
17732	Skyrim 3D Rocks	1.0.3	Mathy79 original main	139229	DOWNLOAD
24324	Medieval Candlehorns and Sconces	2.0.0	FOMOD; install choice later	97446	DOWNLOAD
20829	Skyrim 3D Misc		Many independent components; choose manually		MANUAL
78511	SDA Patch Hub SE	2.9.7	Optional translation/patch hub	741211	HOLD_PATCH
```

动作不是 `DOWNLOAD` 的行永远不会触发 Nexus 下载，可用来保留审计结论和人工待办项。

## 推荐流程

### 1. 预览

```powershell
node scripts/nexus-autodl.js dl .\manifests\batch.tsv --wait 1
```

预览会逐项核对文件卡、版本、分类和精确 file ID，但不会触发 NXM。

### 2. 下载

```powershell
node scripts/nexus-autodl.js dl .\manifests\batch.tsv --go --wait 3 --json
```

一次只提交一个文件。`--json` 适合被其他工具读取；人类查看时可以省略。

常用选项：

```text
--start N             从第 N 行开始
--limit N             最多处理 N 行
--wait SEC            两次提交之间的等待时间
--go                  真正触发下载；没有此项只是预览
--gate                允许非 MAIN/OPTIONAL/MISC 分类通过分类门槛
--redownload          忽略完整重复归档，强制再次提交
--downloads DIR       指定 MO2 Downloads
--sevenzip PATH       指定 7z.exe
--json                输出机器可读 JSON
```

### 3. 验收

```powershell
node scripts/nexus-autodl.js verify .\manifests\batch.tsv --json
```

验收状态含义：

| 状态 | 含义 |
|---|---|
| `SUBMITTED` | NXM 已交给目标 MO2 handler，不代表文件已完成 |
| `SKIP_DUPLICATE` | Downloads 中已有同一 mod ID + file ID 的非空归档 |
| `INCOMPLETE` | 缺归档、只有 `.unfinished` 或归档仍为 0 字节 |
| `VERIFIED` | `.meta`、mod/file ID、版本匹配，且 7-Zip 返回 0 |
| `VERIFIED_WITH_RESIDUAL` | 正式归档通过验证，但目录还留有同名 `.unfinished` 残留；不删除，需单独观察队列 |
| `MISSING_META` | 没有对应的 MO2 `.meta` |
| `META_MISMATCH` | 归档旁的 `.meta` 与清单不一致 |
| `VERSION_MISMATCH` | 版本确实不同，而非末尾 `.0` 格式差异 |
| `SKIP_ACTION_MANUAL` | 清单明确要求人工选择，自动化跳过 |

只有 `VERIFIED` 才能进入“已下载并通过验证”清单。`.unfinished` 文件不要手工改名、拼接或删除，先观察 MO2 是否继续增长。

## MO2 队列辅助脚本

```powershell
pwsh -NoProfile -File scripts/refresh-mo2-downloads.ps1
pwsh -NoProfile -File scripts/wake-mo2-download.ps1 -Pattern 'Skyrim 3D Rocks'
```

`refresh` 只点击 MO2 Downloads 的刷新按钮。`wake` 只尝试唤醒名称匹配的下载行；`ROW_NOT_FOUND` 不等于 NXM 提交失败，最终状态必须以 Downloads 目录和 `verify` 为准。

## 补丁、资源和汉化的处理原则

主文件下载不能代替附属文件核对。对每个系列应按以下链条单独记录：

```text
主 MOD → 贴图/网格 → BodySlide/身体物理 → SPID/BOS/KID
       → 功能补丁/修复 → 当前版本汉化 → 最终覆盖
```

补丁或汉化如果需要用户选择、版本未闭合、自动下载失败或没有当前对应版本，应分别记为 `HOLD_PATCH`、`MANUAL_PATCH`、`HOLD_TRANSLATION` 或 `MANUAL_TRANSLATION`，并保留精确页面和 file ID。纯资源、纯 DLL 和无文本文件通常标记为“不需要独立汉化”。

## 常见失败

### 无效下载索引

不要重复点击旧链接。重新打开精确 `file_id` 页面，确认 MO2 handler 和登录态，再只提交一次新的短时 NXM；仍失败就记为 `RETRY`。

### MO2 显示挂起

先刷新 Downloads，检查目标归档和 `.unfinished` 的大小是否增长。不要把 UI 状态直接当成文件状态；`verify` 才是最终判断。

### 403 或未登录

停止自动化，让用户完成登录、验证码或 Nexus 页面确认。工具不会绕过这些拦截。

### 同名文件选错

在清单中填写精确 `modID`、`fileID` 和期望版本。名称子串只是辅助显示，不能替代 file ID。

### 7-Zip 不存在

安装 7-Zip，或显式指定：

```powershell
node scripts/nexus-autodl.js verify batch.tsv --sevenzip 'D:\Apps\7-Zip\7z.exe'
```

## 文件说明

```text
SKILL.md                         可供其他 AI/工具调用的完整工作流
scripts/nexus-autodl.js          Nexus 文件核验、NXM 提交、重复检测和验收
scripts/refresh-mo2-downloads.ps1 MO2 Downloads 刷新
scripts/wake-mo2-download.ps1    MO2 下载行唤醒
agents/openai.yaml               Codex skill 元数据
```

本项目只负责下载阶段；安装、启用、排序、FOMOD 选择和游戏测试必须在用户明确授权后单独进行。
