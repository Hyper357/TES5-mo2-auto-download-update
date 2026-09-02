# TES5 MO2 Auto Download Update

面向 Skyrim Special Edition / Anniversary Edition 的安全 Nexus 下载与验收工具。它把已登录的 Nexus 文件页中的短时 `nxm://` 链接交给指定的 Mod Organizer 2 实例，并提供精确文件核对、重复检测、MO2 下载队列刷新和 7-Zip 归档验收。

这个项目的目标是“下载和核验”，不是自动安装整合包：它不会安装、启用、禁用、移动或排序模组，也不会修改 `modlist.txt`、`plugins.txt` 或 INI。

## 功能

- 以 `mod ID + file ID` 精确选择 Nexus 文件，避免同名旧文件或错误变体。
- `installed` 审计命令对照本地 MO2 已装 file ID（`meta.ini` 的 `1\fileid=`）区分真缺口、已装最新与变体不一致，防止把“已装最新”误当更新。
- `dl` 支持 `--installed-dir` 变体防护：目标 fileID 与本地已装变体不一致时返回 `VARIANT-MISMATCH` 拒绝下载（如 3BA/BHUNP、4K/2K 双 MAIN 模组）。
- `patchscan` 命令扫描主 MOD 文件卡中的补丁/汉化候选（PATCH / TRANSLATION 分类），供人工勾选后并入下载清单。
- 支持 AE/SE/NG/CC 等版本由清单和 Nexus 文件页共同核对；不按相邻 file ID 猜版本。
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

## 性能与架构特性 (v1.9)

- **智能汉化依赖闭合与挂起保护 (Smart CHS Linking & Hold)**：自动建立本体与汉化包（CHS）的关联。当本体发布重大新版但汉化作者尚未更新时，动作列自动标记为 `HOLD_NO_CHS`，防止玩家更新本体后出现大修文本回退为英文或 MCM 丢失的问题。

## 性能与架构特性 (v2.0)

- **AIO 多包合集 Hub 智能解耦与多目标下载**：针对如 doodlum 的 dTry Plugin Updates (85740) 等将多个独立插件作为平级 MAIN 托管在一个 Mod 页面中的合集 Hub，支持精准识别本地 modlist 启用的各个独立子插件，支持多文件并发独立下载，并新增 `--ignore-variant-mismatch` 放行指令。

## 性能与架构特性 (v2.1)

- **一键自动化流水线 ()**：全自动串联扫描画像、小文件优先调度下载、7-Zip 完整性验收及 FOMOD 安装备忘推导。
- **模块化工程分层 ()**：拆分 `mo2-reader`、`profile` (画像决策引擎)、`semver`、`fomod-helper`，便于扩展维护与单元测试。
- **FOMOD 安装备忘清单 (FOMOD Preset Memory)**：自动读取上次安装时在 `FOMOD Plus` 中勾选的具体子选项，并在下载完成后高亮展示，避免重新安装时选错身形或漏勾补丁。

## 性能与架构特性 (v1.8)

- **时间戳优先排序与强制刷新支持 ()**：文件列表优先按 `uploaded_time` 倒序严格取最新，同时支持 `--no-cache` / `--force-refresh` 绕过本地磁盘缓存实时拉取 Nexus 刚上传的最新发布包。

## 性能与架构特性 (v1.7)

- **智能补丁/宿主对齐准则 (Smart Patch & Host Binding Matrix)**：
  1. **本体与补丁强隔离**：本地安装为本体主包时，禁止因可选补丁区（Optional/Patch）发布了更高版本号而误下第三方兼容包（如 Archery Target Remodel、Water in Wells 等）。
  2. **第三方宿主强绑定 (Host-Binding)**：本地安装为 `For ModX` 专用补丁时，升级目标必须命中同宿主关键词，严禁错升为其他关联 Mod 的补丁。

- **平台与身形变体硬核隔离 (Platform & Body Type Strict Isolation)**： `check-outdated.js` 全面引入平台（SE/AE vs VR）与身形（3BA/CBBE vs BHUNP/UNP）指纹对齐机制。当本地为 SE/AE 时严禁匹配 VR 分支，本地为 3BA 时严禁错匹纯 BHUNP 分支，彻底避免错下 VR 动态库或身形破皮安装包。
- **跨类别误升与补丁/可选文件隔离保护**：`check-outdated.js` 严密限制非 MAIN 类别的回退逻辑，禁止将单体独立 Patch/Update 误升级为主文件（例如 Archery Target、Water in Wells 独立补丁），彻底消除假性更新。
- **先小后大队列自适应调度 (Small-First Scheduling)**：下载调度层原生集成体积预判机制，默认按安装包体积升序调度下载。小体积核心插件/脚本优先落盘并完成验证，GB 级大包平稳置后，彻底避免单个大文件卡死整个批量下载链。
- **智能变体与版本噪音自动过滤**：`check-outdated.js` 内置语义版本与噪音过滤引擎，自动识别 `.0` 后缀噪音（`SKIP_NOISE`）与作者反向降级（`SKIP_DOWNGRADE`），并优先沿同分类/同变体分支匹配最新目标。
- **高性能并发扫描**：`check-outdated.js` 支持 HTTP Keep-Alive 连接池复用与多路并发队列，2000+ Mod 全量审计耗时由原本 30 分钟压缩至 1 分钟左右。
- **本地 API 磁盘缓存**：自动缓存 Nexus Mod 文件信息至 `.api_cache/`，避免频繁触发 Cloudflare 403 频控与 API Rate Limit，支持秒级断点恢复。
- **大文件智能流控 (Active Download Watcher)**：`nexus-autodl.js` 在批量调度时自适应监控 `.unfinished` / `.crdownload` 下载完成状态，防止大材质包/动画包并发阻塞或提前跳过。
- **Nexus 2026 Shadow DOM 适配**：`nexus-autodl.js` 支持穿透 Shadow DOM (`<mod-download-modal>`) 并结合请求拦截捕获 `nxm://`，原生兼容最新版 Nexus 页面交互。

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

使用项目提供的启动脚本打开独立浏览器配置，避免污染日常浏览器。它检查实际的 CDP 端口，不会因为普通 Edge 已经打开而误判。登录一次 Nexus 后保持窗口打开：

    scripts\start-cdp-edge.cmd

如需自定义 Edge 路径或独立配置目录，可先设置 `MO2_EDGE` 和 `MO2_EDGE_USERDATA`。
也可以手动使用下面的等价命令：

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  '--user-data-dir=C:\Users\<用户名>\.nexus-mo2-download' `
  '--remote-debugging-port=9222' `
  '--disable-extensions' `
  '--no-first-run' `
  'https://www.nexusmods.com/users/sign-in'
```

如果使用 Chrome，把可执行文件路径替换为 Chrome，并确保端口仍为 9222。不要在报告中复制完整签名 NXM。

## 浏览器 NXM 失效时的手动单条下载

如果普通 Edge 的倒计时结束后没有把 NXM 链接交给 MO2，可使用本地桥接脚本，不需要把签名链接发送给项目或聊天：

1. 在 Nexus 文件页点击下载，倒计时结束后，在 `Start download manually` 上右键，选择“复制链接地址”。
2. 双击 `scripts\send-nxm-to-mo2.cmd`。
3. 脚本只从剪贴板读取本次完整的 Skyrim NXM 链接，并把它作为一个参数交给当前 MO2 handler；不会回显、保存或写入日志。

该入口只负责提交下载，不安装、启用或修改模组排序。

如果需要修复 Edge 的外部协议交接，可导入 `scripts\edge-nxm-policy.reg`，然后完全退出并重启 Edge。该文件只允许 Nexus 的 `nxm` 协议调用，并不放行其他协议。

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

### 4. 下载前审计（installed）

下载前先用 `installed` 对照本地已装 file ID，区分真缺口与已装最新，避免白下：

```powershell
node scripts/nexus-autodl.js installed .\manifests\batch.tsv --installed-dir <MO2 mods 目录> [--downloads DIR]
```

| 状态 | 含义 |
|---|---|
| `NEED_DOWNLOAD` | 目标 fileID 未在本地安装，真缺口 |
| `ALREADY_INSTALLED` | 目标 fileID 已装（meta.ini `1\fileid=` 命中），跳过 |
| `VARIANT_MISMATCH` | 本地装了同一 modId 的**其他变体**（如 3BA vs BHUNP）——目标与本地变体不一致，下载前必须确认变体 |
| `NOT_INSTALLED` | 本地无该 mod 的安装记录 |

`dl` 传 `--installed-dir` 时对 `VARIANT_MISMATCH` 行直接拒绝下载（返回 `VARIANT-MISMATCH`），防止再发生“清单填了 A 变体、实际下成 B 变体”的错误。判断依据是 MO2 `meta.ini` 的 `1\fileid=`（权威），不是经常过时的顶层 `version=`。

### 4.5 全量更新检查（check-outdated）

MO2 自带的 Check for Updates 缓存可能过期（`lastNexusQuery` 可能数月前），且很多 meta.ini 没有 `1\fileid`。用 `check-outdated` 直接以 Nexus API 为准做全量扫描：

```powershell
node scripts/check-outdated.js <MO2 mods 目录> <apiKeyFile> [--json] [--out manifest.tsv]
```

判断逻辑：本地已装 fileId 在 Nexus 上**仍是活跃 MAIN(1)/OPTIONAL(3)** → 已最新；已被移到 OLD_VERSION/ARCHIVED 或文件消失 → 过时，列出最新 MAIN 作为目标。

fileId 解析三通道（顶层 `version=` 字段经常过时，不可用于判断）：

1. meta.ini 的 `1\fileid=` 配对（MO2 记录实际安装的 Nexus file ID）
2. `installationFile` 与 API `file_name` 精确匹配（旧式下载文件名）
3. 名称子串匹配（新式文件名，如 `AI Overhaul AE 1.9.5 21654 1.9.5 2026-...-xxx.zip`）

输出 `OUTDATED` 行（含目标 fileID/版本）；`--out` 可生成 dl 直接可读的候选清单。**注意：输出是候选，仍需人工甄别变体/版本噪音**（如 3.0 vs 3.0.0 格式差异、同 modId 多个补丁文件、作者降级等情况），甄别后交给 `dl`。

该脚本串行限速（约 0.15s/mod），2000 个 mod 约 8 分钟；`fail`（403/超时）与 `unresolved`（三通道都解析不出 fileId）会单独报告，需补查。

### 5. 补丁/汉化候选扫描（patchscan）

```powershell
node scripts/nexus-autodl.js patchscan .\manifests\main-mods.tsv --installed-dir <MO2 mods 目录> [--api-key-file <key 文件>] [--json]
```

对清单中每个主 MOD 扫描其 Nexus 文件卡，按名称关键词分类输出补丁/汉化候选：

| 字段 | 含义 |
|---|---|
| `PATCH` | 文件名为补丁/修复（patch/fix/compat/兼容/补丁） |
| `TRANSLATION` | 文件名为汉化/翻译（Chinese/汉化/CHS/translation） |
| `CANDIDATE` | 候选，可并入下载清单 |
| `ALREADY_INSTALLED` | 该 fileID 本地已装 |
| `NO_AUX` | 文件卡中无候选（独立翻译页/补丁中心需页面核验） |

局限（如实）：Nexus 开放 API 无 search/requirements/translations 端点，patchscan 只能扫描**同一 modId 文件卡**中的候选；跨 mod 的独立翻译页、补丁中心、FOMOD 互斥方案仍需人工页面核验后标记 `MANUAL` / `HOLD_*`。patchscan 的用途是把“逐页人工核对”变成“脚本出候选表 + 人工勾选”，不是替代人工决定。

跨 mod 的汉化/补丁可用 `--series-file` 扩展：本地维护一张系列关系表（主 modId 与独立汉化/补丁 modId 的对应），patchscan 会一并扫描。格式：

```text
# 主modId<TAB>附属modId<TAB>PATCH|TRANSLATION<TAB>备注
122487	172586	TRANSLATION	FDE Uthgerd 的 CHS 翻译（独立mod）
```

### 6. 补丁中心选项匹配（patchpicker）

```powershell
node scripts/nexus-autodl.js patchpicker .\manifests\patch-hubs.tsv --modlist <modlist.txt> [--api-key-file <key>] [--work-dir <临时目录>]
```

读取 Patch Hub 的 FOMOD 真实选项（本地已有归档时解包解析 `fomod/ModuleConfig.xml`），与本地 modlist 已装模组名匹配，输出“建议勾选/未匹配”清单供人工确认；本地无归档时回退用文件描述中的列表项匹配。匹配基于名称关键词，**仅供人工确认，不自动选择**。

### 7. 归档库重建（rebuild）

```powershell
node scripts/nexus-autodl.js rebuild --installed-dir <MO2 mods> [--downloads DIR] [--modlist PATH] [--only-enabled] [--out manifest.tsv] [--json]
```

扫描已装 mod 的 `meta.ini`，对照 downloads 现有归档，输出“已装但缺归档”的清单（TSV，可直接喂给 `dl`）。**只出清单不自动下载**——因为用户可能主动清理过 downloads 缓存，且全量重建可能数百 GB。无 fileID 的条目标记为 `MANUAL`（需人工从 Nexus 页面补 fileID）。

### 8. 下载队列监控（monitor）

```powershell
node scripts/nexus-autodl.js monitor [--downloads DIR] [--interval SEC] [--stall-after MIN] [--timeout MIN] [--json]
```

轮询 downloads 目录，报告 `.unfinished` 的 `GROWING` / `STALLED`（超过 `--stall-after` 分钟无增长）/ `COMPLETED` 状态。用于判断“下载慢 vs 卡死”，不要用网页弹窗判断。

### 9. 下载顺序（dl --sort small-first）

```powershell
node scripts/nexus-autodl.js dl .\manifests\batch.tsv --go --sort small-first --api-key-file <key>
```

下载前用 Nexus API 预取各目标文件大小，小文件（SKSE/框架，几百 KB）先提交，大型材质包（GB 级）后提交，避免队列被大文件堵住。需要 API key。

### 10. 浏览器会话自动恢复（dl --reconnect）

```powershell
node scripts/nexus-autodl.js dl .\manifests\batch.tsv --go --reconnect
```

CDP（127.0.0.1:9222）断连时，自动用独立 Edge 配置（`~/.claude/nexus-autodl-edge`，登录态持久化）重启浏览器会话并等待端口就绪，然后继续。

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
