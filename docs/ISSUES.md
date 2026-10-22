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

## 待建条目（尚未编号，记录线索）

- **多文件夹共用 modId 无自动检测**：`Horde`（2 夹）、`NAT Effect 11`（3 夹）、`Somewhere in Between`（3 夹）反复出现。目前只有 `LOCAL_MULTI_VERSION_IDENTITY` 在特定路径上拦截，没有全局体检。
- **`newestVersion` 字段大面积不可信**：2026-10-13 实测 439 个 `meta.ini` 的 `newestVersion` 为默认值 `1.0.0.0`，导致 MO2 界面箭头大量虚警（192 个箭头里仅 29 个是真更新）。
