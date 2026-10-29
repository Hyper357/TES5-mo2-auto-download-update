# Known issues

缺陷台账。每条记录：症状 → 影响 → 根因 → 证据 → 修复 → 防复发。

新增条目请沿用同一结构，并**必须**附一条能复现该缺陷的回归测试名。
没有回归测试的修复视为未完成 —— 这个仓库已经出现过同一个缺陷类别复发两次的情况。

状态取值：`OPEN` / `FIXED` / `WONTFIX`。

---

## ISS-001 — 弱证据路径把同页的"另一个文件"当成更新

- **状态**：**FIXED（2026-10-22，方案一：弱证据降级人工复核）**
- **发现**：2026-10-21，用户质疑 `Somewhere in Between - Helmets 3.0.5` 是否真的需要更新
- **影响面**：所有「一个 Nexus 页面挂多个并列文件」的 mod；每轮影响约 1–2 项
- **回归测试**：`scripts/test-update-eligibility.js`（弱证据必须 HOLD）、`scripts/test-runtime-compat.js`（runtime 门禁通过也不得自动放行）

### 症状

一个已装 mod 被判为 `UPDATE_CONFIRMED: NEWER_COMPATIBLE_FILE_UPLOAD`，自动下载，但下回来的**不是已装文件的更新版，而是同页另一个并列文件**。

实例（modId **98945**）：

| | 已装 | 被判为"更新" |
|---|---|---|
| 名称 | `Somewhere in Between - **Guards**`（守卫） | `Somewhere in Between - **Helmets**`（头盔） |
| 版本 | 2.4.1 | 3.0.5 |
| fileId | 513691 | 701118 |
| 类别 | OPTIONAL | OPTIONAL |

**Nexus 上根本没有 `Guards` 的 3.0.5** —— 该页 25 个文件里，3.0.5 只有 MAIN 主体（`3BA Armor Replacer PM/NPM`）、4 个 MISC 分卷、以及 OPTIONAL 的 `Helmets`。`Guards` 停在 2.4.1，没有后继。

### 影响

1. 下回一个不需要的文件（浪费带宽）。
2. 用户安装后，本地出现**第三个共用 modId 98945 的文件夹**（原本已有 `Guards` 与 `3BA Armor ReplacerNPM` 两个）。这与 `Horde`（2 个文件夹）、`NAT Effect 11`（3 个文件夹）是同一类 `LOCAL_MULTI_VERSION_IDENTITY` 隐患。
3. 它会**每天重复出现**在自动下载列表里，因为下回来的东西装不上、版本对不上，判定永远不收敛。

### 根因

`scripts/lib/update-eligibility.js` 的 `fallbackNewerCandidate()` 是**弱证据路径**（"页面上有更新的文件"）。它的准入条件是：

```
scoreCandidate 名称相似度 >= 58  &&  uploaded_time > 已装文件的上传时间
```

名称相似度用 `tokenSimilarity`，对 `Somewhere in Between - Guards` vs `Somewhere in Between - Helmets` 而言，共享 `somewhere / in / between` 三个词，**相似度足够高**，于是通过。判定链随后看版本号 `3.0.5 > 2.4.1` 成立，输出 `UPDATE_CONFIRMED`。

**缺的是"两者是不是同一个 artefact"这一步。**
`Guards` 与 `Helmets` 的区别词恰好被"共享页名"淹没了。

对比：强证据路径 `chainCandidate()` 走 `NEXUS_EXACT_UPDATE_CHAIN`（Nexus 官方记录"A 文件被 B 文件替换"），**不需要**这个判断，因为它本身就是替换关系的权威声明。缺陷只存在于弱证据路径。

同时注意两个本应拦住的信号当时都没拦住：

- `mo2Signal = NO:MO2_NO_UPDATE` —— MO2 自己说没有更新
- `newestVersion == installedVersion == 2.4.1.0`

### 证据

```
action      : DOWNLOAD
evidence    : ["NEWER_COMPATIBLE_FILE_UPLOAD"]        ← 弱证据，非精确链
mo2.reason  : MO2_NO_UPDATE                            ← MO2 明确说没更新
installed   : 2.4.1.0    target: 3.0.5
```

该 mod 的 25 个文件全表（`scripts/.api_cache/98945.json`）可证 `Guards` 无 3.0.5 后继。

### 最终修复（方案一，已实施）

**弱证据不再自动下载，一律转人工复核。**

`assessUpdateEligibility()` 里 `NEWER_COMPATIBLE_FILE_UPLOAD` 的终态由 `UPDATE_CONFIRMED`（自动下载）改为：

```
status   : HOLD_UPDATE_ELIGIBILITY
reason   : WEAK_UPDATE_EVIDENCE_DEFERRED
evidence : ['NEWER_COMPATIBLE_FILE_UPLOAD', 'WEAK_EVIDENCE_DEFERRED']
target   : 仍然保留（Review Center 能直接显示"将要下载哪个文件"）
```

只有 `NEXUS_EXACT_UPDATE_CHAIN`（Nexus 官方"A 被 B 替换"记录）继续自动下载。

**为什么降级而不是继续找启发式：** 见下方两次失败尝试。名字与归档名都不可靠，任何启发式都会误伤几十个真实更新；但"弱证据"这个信号本身是可靠的 —— 它确实不足以证明替换关系。**不再猜，交给人工一眼判断。**

**实测影响**（2026-10-22，同一 modlist 前后对比）：

| | 修复前 | 修复后 |
|---|---:|---:|
| 自动可下载 | 5 | **3** |
| `WEAK_UPDATE_EVIDENCE_DEFERRED` | — | 5 条 |
| 人工复核 | 220 | 220 |

代价符合预期：每轮约 1–2 项由自动转为人工。`Somewhere in Between - Helmets` 不再出现在自动下载列表。

**注意**：98945 本轮实际落在 `LOCAL_FILE_IDENTITY_UNRESOLVED`（本地已有 3 个共用该 modId 的文件夹），不是 `WEAK_UPDATE_EVIDENCE_DEFERRED`。两条路都是 HOLD，结果一致。

### 已被否决的方案（勿重试）

**方案 A —— 用「区别词」判定是否同一 artefact。**
`pageFamilyVocabulary()` 统计出现在 ≥50% 文件里的词作"页名"，剩下的词作该文件"区别词"；双方各有区别词且不相交 → 判为不同 artefact。分词用 `name + file_name`。

结果：**99 项被误拦**。原因：`file_name` 是归档名，含 modId、版本、上传时间戳和随机 token。`familyTokens` 只在 `. _ -` 连接时剥离版本串，空格分隔的新式归档名会留下 `2026 / 08 / 30t01 / 51z / oyyrpu3on.zip`。两个**名字逐字节相同**的文件（PapyrusUtil 462773 vs 797330）也被判成"不同"。

**方案 B —— 只按 `name` 分词（排除归档名噪音）。**
误拦从 99 降到 **68**，仍不可接受。原因见下。

**为什么基于名字的方案不可行：**

| modId | 已装（本地文件夹名） | 候选（Nexus 文件名） | 实际关系 |
|---|---|---|---|
| 52164 | Don't Stay in The Water | NPC Water AI Fix for SkyrimSE | **同一个 mod**，作者改过名 |
| 85694 | DrJacopo's - 3D 龙 Tongue | Cathedral - 3D Dragons Tongue | 同上 |
| 49746 | Alpha Jab -Unarmed 战斗音效 Rework | Alpha Jab -Vanilla Rework- | 同上（文件变体） |
| 144219 | NTZ's APPLE PIE - 3BA UBE BHUNP | NTZ's Apple Pie - 3BA | 仅大小写/修饰差异 |

本地文件夹名普遍被中文标签装饰（`【前置】`、`【汉化·人工】`），且作者在版本之间会**重命名文件**。名字差异无法区分「真·不同 artefact」与「合法改名」，信噪比不足。

### 遗留 / 未做

- 已产生的 3 个共用 modId 98945 的文件夹**未清理**，需要人工决定保留哪个（同 `Horde` / `NAT Effect 11`）。
- 若将来出现更强的结构性判据（例如 Nexus 明确标注某个文件被某个文件取代），可以再考虑恢复弱证据的自动下载能力。

---

## ISS-002 — 名字里的 "NG" 被当成独立 runtime 分支，误拦真实更新

- **状态**：**FIXED（2026-10-25）**
- **发现**：2026-10-25，用户指出 `modId 128582`（取消装备箭袋 / Unequip Quiver NG）"似乎没查到更新"
- **影响面**：名字带 `NG` 的 mod。当日 plan 中含 NG token 的 49 行里 10 行被 HOLD；其中因本缺陷误拦 **7 项**：128582、182536、189962、181603、42161、195077、97674
- **回归测试**：`scripts/test-selector.js` → `ngIsTheAeBranchNotANewRuntime`、`selectsNgUpdateOfAnInstalledNgMod`

### 症状

已装 mod 有明确的 Nexus 更新链，却被判成"版本分支冲突"，既不进自动下载、`target` 还是 `null`（Review Center 里连"要下哪个文件"都显示不出来）：

```
action   : HOLD_UPDATE_ELIGIBILITY
reason   : NEXUS_UPDATE_CHAIN_VARIANT_CONFLICT
conflicts: ["profile-runtime:AE!=NG"]
local    : 797013  v1.3.0
nexus    : 814615  v1.3.1 MAIN (2026-10-04)
chain    : file_updates 797013 -> 814615   （Nexus 官方替换记录，无歧义）
```

### 根因

`scripts/lib/file-selector.js` 的 `variantSignature()`：

```js
if (/\bng\b|next gen/.test(t)) runtime.add('NG');
```

它把 mod 名里的 `NG`（next-gen，社区对 1.6+ / AE 的叫法）当成**与 AE 并列的第三种 runtime**。随后 `hardVariantConflicts()` 用 profile 的 `AE` 与该集合比较，交集为空 → 判为硬冲突 → `chainCandidate()` 拒绝这条唯一后继 → `latest` 回退成已装文件 → `target: null`。

即：**用名字里的词去猜 runtime 分支**，而这个词本身就是 AE 的同义词。

### 修复

`variantSignature()` 将 `NG` 归一为 `AE`。分支证据只应来自两处：① 已装文件实际所在的分支；② 描述里显式写明的运行时/SKSE 要求（`runtimeCompatRejects`，原样保留、仍是硬门禁）。

刻意保留的东西：

- `SE` / `VR` / `GOG` 语义不变——那是真正不同的游戏分支；
- `body`（3BA/CBBE/BHUNP）、`resolution`（2K/4K）、`cc` 的名字判定不变——这些是内容分支，选错是真实的安装错误；
- `profile-body` / `profile-resolution` 的硬冲突不变（`test-variant-policy` 有断言）。

### 遗留 / 未做

- 另有 3 项被 `profile-runtime:AE!=SE` 拦住（150727 GDOS SE PBR 4.0、142566 Sturdy Sandals SE 2.0、173074 Character Menu SE 1.4）。本地装的就是 SE 版且能跑，但门禁按"不跨 AE/SE 分支"硬拦 —— 该问题已由 **ISS-003** 修复（已装分支优先于 profile）。
- `variant-review` 的 `branchKey` 里 `RUNTIME_NG` 会变成 `RUNTIME_AE`；现存 `variant-policies.json` 没有 NG 条目，无迁移影响。

---

## ISS-003 — profile 的 runtime 判定压过"已装文件实际分支"，把同分支更新判成跨版本

- **状态**：**FIXED（2026-10-25）**
- **发现**：2026-10-25，ISS-002 修完后仍有 3 项 `profile-runtime:AE!=SE`；用户裁定「材质类跨版本要求低，放行」
- **影响面**：已装文件自身带 runtime 标签、但 profile 标签与之不同的 mod。当日 3 项：150727（GDOS SE 3.5.1→4.0）、142566（Sturdy Sandals SE 1.9.1→2.0）、173074（Character Menu SE 1.3.0→1.4）
- **回归测试**：`scripts/test-selector.js` → `installedEditionBranchOutranksTheProfile`、`profileRuntimeStillGuardsAnUnknownInstalledBranch`、`selectsSeBranchUpdateForAnInstalledSeMod`

### 症状

```
action   : HOLD_UPDATE_ELIGIBILITY
reason   : NEXUS_UPDATE_CHAIN_VARIANT_CONFLICT
conflicts: ["profile-runtime:AE!=SE"]
local    : Glorious Doors of Skyrim (GDOS) SE PBR 3.5.1   ← 本地就是 SE 分支
nexus    : Glorious Doors of Skyrim (GDOS) SE PBR 4.0      ← 同分支更新
```

本地 `SE` ↔ 候选 `SE` 的 local 对比是通过的，冲突只来自 profile 的 `AE`。

### 根因

`hardVariantConflicts()` 里 profile 对比**无条件**执行：profile 写的是 `AE`，候选文件写的是 `SE`，交集为空即硬拒。可是"已装文件是 SE 且用户正在用它"本身就是该分支可用的证据——门禁在拿一个理想 profile 去否定用户的实际运行状态。

### 修复

profile 只在**已装文件自身没有 runtime 证据**时才参与 runtime 判定：

```js
const dimensions = [['body','profile-body'],['resolution','profile-resolution']];
if (!local.runtime.size) dimensions.unshift(['runtime','profile-runtime']);
```

`profile-body` / `profile-resolution` 仍是硬冲突（内容分支，选错是真实错误）。

**边界**：这不等于"SE 文件能随便装到 AE 上"。它只消除"已装同分支却被 profile 否掉"的自相矛盾；描述里显式声明需要 1.5.97 的运行时要求仍由 `runtimeCompatRejects` 硬拒。

### 遗留 / 未做

- 已装文件无 branch 标签时，profile 仍会保守 HOLD（有意为之）。
- `173074 Character Menu` 疑似 SKSE 插件，跨版本风险高于纯材质；用户已知悉后放行，若游戏出问题优先回退这一项。

---

## ISS-004 — 浏览器"逐页抓取失败"仍被当成干净审计

- **状态**：**FIXED（2026-10-29）**
- **发现**：2026-10-29 例行 audit，组件闭合 `complete=2 / held=12`、`coverageComplete = 0/14`
- **影响面**：每次 Nexus 网络抖动都会命中；本轮 6/14 目标

### 症状

audit 正常退出 0、报"自动项=2"，但 14 个目标里有 **6 个根本没做覆盖率检查**：

```
requirementsForward=BROWSER_ERROR   6
requirementsReverse=BROWSER_ERROR   6
description=BROWSER_ERROR           6

detail: net::ERR_CONNECTION_CLOSED at .../mods/181328   （5 个）
        Navigation timeout of 45000 ms exceeded         （1 个）
```

受影响：`Horde`、`Outfit Distributor SKSE`、`Simple Follower Framework CHS`、`Inventory Interface Injector`、`SPS`、`AnvilLOD`。

### 根因

`scripts/discover-patches.js` 的 `browserDiscover()` 用 try/catch 把任何抓取异常吞成 `BROWSER_ERROR`（三个覆盖率区段一起标记），`detail` 只写进工件。

而 2026-10-18 那次修复（见 §ISS-001 之前的 `c18d8f6`）只覆盖了**浏览器完全连不上**（`browserUnavailable`），判据是 `browser == null`。本轮浏览器**连上了**，只是逐页取失败 —— 走的是另一条路径，**降级检测完全没看到它**。

同一个"静默失败"缺陷类别，第二次出现，只是状态字符串不同。

### 修复

1. `scripts/discover-patches.js`：逐目标统计 `BROWSER_ERROR`，产出 `browserErrored` 计数与前 5 条 `browserErrorSamples`（modId + detail）；`browserErrored > 0` 时同样以 **exit 3** 退出。
2. `scripts/lib/coverage-degradation.js`（新）：把判定抽成纯函数 `summarizeCoverageDegradation()`，返回 `{ degraded, kind, affected }`，`kind ∈ BROWSER_UNAVAILABLE | PAGE_SCRAPE_FAILED`。抽出来是为了**能脱离真实浏览器做单元测试**。
3. `index.js`：改用该函数；`PAGE_SCRAPE_FAILED` 时打印受影响数与样例 `modId`，并记录 `errorCode=BROWSER_UNAVAILABLE_FOR_COVERAGE`（沿用既有诊断码，layer=BROWSER, retry=true）。

**注意**：`BROWSER_ERROR` 本身不代表"这些 mod 有问题" —— 它是**网络/浏览器**问题。所以修复方式是"让结论不可信并大声报出来"，不是把它们升级成别的 HOLD 原因。

### 防复发测试

`scripts/test-patch-discovery.js` 末尾 5 组断言：

1. `browserUnavailable` → `kind=BROWSER_UNAVAILABLE`，`affected=targets`
2. `browserErrored=6/targets=14` → `kind=PAGE_SCRAPE_FAILED`，`affected=6`，**必须 degraded**
3. 单个页面失败（1/3）也是 degraded
4. 健康运行（0 失败）→ `degraded=false`
5. 老调用方不传新字段 → 不得被判定为 degraded（向后兼容）

### 遗留 / 未做

- 只统计 `requirementsForward` 的状态作为代表（三个区段总是同时被标记，等价）。若将来 `browserDiscover` 改成部分区段成功，这里需要改成逐区段统计。
- 网络抖动导致的 6 个目标需要**重跑才能补上真实覆盖率**；本轮结论（自动项=2）对那 6 个不成立。

---

## 待建条目（尚未编号，记录线索）

- **多文件夹共用 modId 无自动检测**：`Horde`（2 夹）、`NAT Effect 11`（3 夹）、`Somewhere in Between`（3 夹）反复出现。目前只有 `LOCAL_MULTI_VERSION_IDENTITY` 在特定路径上拦截，没有全局体检。
- **`newestVersion` 字段大面积不可信**：2026-10-13 实测 439 个 `meta.ini` 的 `newestVersion` 为默认值 `1.0.0.0`，导致 MO2 界面箭头大量虚警（192 个箭头里仅 29 个是真更新）。
