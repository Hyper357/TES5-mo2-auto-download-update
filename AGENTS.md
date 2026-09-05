# AI Agent Mandatory Protocol — Precision First

本仓库的目标不是“尽量多下载”，而是：**只自动下载能够被程序证据链证明正确的文件**。
任何 Agent（包括 Pi Agent）都必须服从程序门禁，不能通过改清单动作、删除 HOLD、伪造 NONE 结论来绕过。

## 1. 默认只审计

先运行：

```powershell
npm run check
npm test
node index.js "<MO2 mods>" "<Nexus API key file>" --force-refresh
```

没有用户明确授权时，不得加 `--go`。

每次运行的证据会写入：

```text
.runtime/runs/<timestamp>/
  plan.json
  registry-audit.json
  closure.json
  review-queue.json
  review-queue.tsv
  manifest-final.tsv
  final-report.json
```

Pi Agent 优先读取 `review-queue.tsv/json`，不要自己从头猜“该处理哪些 MOD”。

## 2. 不允许自行猜 Main File

`check-outdated.js` 只有在高置信情况下才允许保留 `DOWNLOAD`。

以下状态必须核验，不能手工改成 DOWNLOAD：

- `HOLD_MULTI_SOURCE`
- `HOLD_UNRESOLVED_LOCAL`
- `HOLD_LOW_CONFIDENCE`
- `HOLD_AMBIGUOUS`
- `HOLD_SAME_VERSION_REPLACEMENT`
- `HOLD_REVIEW`
- `HOLD_API_ERROR`

核验至少使用：

- 本地 `meta.ini` / `installationFile` / 精确 fileId；
- Nexus Files 页面；
- MAIN / UPDATE / OPTIONAL / OLD / ARCHIVED 分类；
- AE / SE / VR / GOG；
- 3BA / CBBE / BHUNP / UNP；
- 1K / 2K / 4K / 8K；
- CC / No CC；
- 文件说明、Requirements、版本、上传时间。

**上传时间永远只能是次级证据。** “最新上传”不能单独决定目标文件。

## 3. 本地整合包画像不是事实源

`profile.js` 只从已装文件名中推导弱画像。证据不足时必须保持 `UNKNOWN`。

禁止因为 Agent 主观认为“这套整合应该是 AE/3BA/2K”而强写画像，从而排除候选。
真正的平台/运行时应优先由游戏环境和精确已装文件来源确认。

## 4. PATCH / 汉化必须闭合，而且绑定 mainFileId

`config/aux-registry.tsv` 使用 v2 12 列格式：

```text
mainModId  mainFileId  mainVersion  kind  status  auxModId  auxFileId  auxVersion  auxName  checkedAt  evidence  note
```

每个准备自动更新的**目标 mainFileId**都必须明确回答：

1. PATCH 是否需要；
2. TRANSLATION（汉化）是否需要。

合法结论：

- `NONE`：已核验不存在/不需要；
- `REQUIRED`：需要，并填写精确 `auxModId + auxFileId + auxVersion + auxName`；
- `SELF / AUX`：该 modId 本身就是补丁/汉化页，不递归闭合。

### NONE 不是“没找到就写没有”

写 `NONE` 必须填写：

- `checkedAt`：本次核验日期；
- `evidence`：核验过哪些 Files / Requirements / Translations 页面以及结论摘要。

如果扫描器已经发现 PATCH/汉化候选，而 registry 写 `NONE`，`closure-gate.js` 会产生：

```text
HOLD_CLOSURE_CONFLICT
```

Agent 必须解释候选为什么不适用，不能删除候选或强行改动作。

### registry 结论会过期

默认超过 14 天视为过期，需要重新核验。可用：

```powershell
node index.js ... --max-age-days 7
```

缩短有效期。

## 5. REQUIRED 附属文件必须通过 API 二次验证

`audit-registry.js` 会检查 REQUIRED 记录：

- auxModId 是否存在；
- auxFileId 是否存在；
- 是否已 OLD / ARCHIVED；
- registry 版本与 Nexus 当前 fileId 版本是否一致。

未通过 `registry-audit.json` 的 REQUIRED 项不能进入最终下载清单。

因此不要凭聊天记录、旧截图或旧 fileId 填 registry。

## 6. 独立汉化页不能靠文件名关键词判断

确认某个 Nexus modId 是目标主 MOD 的独立汉化页后，该页 MAIN FILE 即使名字没有 `Chinese/汉化/CHS`，也可能是正确汉化文件。

独立翻译关系必须写入 registry；不能依赖单纯关键词扫描。

## 7. 多个 Patch 必须按“补丁族”处理

同一页面可能同时存在：

- JK Patch
- USSEP Patch
- LOTD Patch
- Lux Patch
- CC Patch
- BodySlide/物理适配

它们是并列分支，不是“PATCH 只取 fileId 最大的一个”。
需要的每一个都应单独记录为 `REQUIRED`。

## 8. 下载必须由事务执行器负责

真实下载只允许通过：

```powershell
node index.js "<mods>" "<api key>" --go
```

总控会调用 `execute-plan.js`，按事务逐项执行：

```text
主文件
→ 必需 Patch
→ 必需 Translation
→ 每项等待 VERIFIED
```

若任一项提交或 verify 失败，同一事务后续项会被阻断，不得继续“把剩下的先全下了”。

状态持久化在：

```text
.runtime/runs/<timestamp>/execution-state.json
```

已经 `VERIFIED` 的 `modId:fileId` 在同一运行状态中不会重复提交。

## 9. 不允许无限重试

NXM 是短时签名。提交失败、文件卡错误、MO2 队列异常时：

- 默认不自动重新提交；
- 先读 `execution-state.json`；
- 确认具体 `modId:fileId` 后再单独处理；
- 不批量重新运行整个失败批次制造重复条目。

## 10. 成功的唯一定义

以下都不等于成功：

```text
页面点击成功
NXM 已取得
SUBMITTED
MO2 队列出现
LANDED
```

只有：

```text
VERIFIED
```

才允许报告“下载完成”。VERIFIED 至少要求：

- `.meta` 的 modID/fileID 精确匹配；
- 版本匹配；
- 归档存在且非零；
- 没有未完成状态；
- 7-Zip 测试通过。

## 11. 推荐 Pi Agent 工作循环

1. `npm run check && npm test`；
2. 运行 Audit pipeline；
3. 读取 `review-queue.tsv/json`；
4. 逐项核验 Main File；
5. 对每个目标 mainFileId 核验 PATCH + TRANSLATION；
6. 更新 `config/aux-registry.tsv` v2 记录；
7. 再次 Audit；
8. 直到目标批次只剩可解释的 HOLD，且准备下载项通过 closure；
9. 用户授权后运行 `--go`；
10. 只报告 VERIFIED；
11. 不安装、不启用、不排序，除非用户另外明确授权。
