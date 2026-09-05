# AI Agent Mandatory Protocol — Precision First

本仓库的目标不是“尽量多下载”，而是“只下载能证明正确的文件”。任何 Agent（包括 Pi Agent）都必须遵守以下门禁。

## 1. 默认只审计

先运行：

```powershell
npm run check
npm test
node index.js "<MO2 mods>" "<Nexus API key file>" --force-refresh
```

没有用户明确授权时，不得加 `--go`。

## 2. 不允许自行猜 Main File

`check-outdated.js` 的 `DOWNLOAD` 才表示选择器达到高置信度。

以下状态必须核验，不能改成 DOWNLOAD 来绕过：

- `HOLD_MULTI_SOURCE`
- `HOLD_UNRESOLVED_LOCAL`
- `HOLD_LOW_CONFIDENCE`
- `HOLD_AMBIGUOUS`
- `HOLD_SAME_VERSION_REPLACEMENT`
- `HOLD_REVIEW`

核验时至少使用：本地 fileId / installationFile、Nexus 精确 Files 页面、文件分类、运行时、平台/身形/分辨率/CC 变体、版本与文件说明。

## 3. PATCH / 汉化必须闭合

每个准备更新的主 MOD，在当前目标主版本上都必须明确回答两件事：

1. 是否需要 PATCH；
2. 是否需要 TRANSLATION（汉化）。

把结论写入 `config/aux-registry.tsv`。不能只在聊天里说“查过了”。

- 确认没有/不需要：写 `NONE`；
- 确认需要：写 `REQUIRED`，并填写**精确** `auxModId + auxFileId + auxVersion + auxName`；
- 某 modId 本身就是汉化/补丁页：写 `SELF / AUX`，避免递归检查。

如果主版本变化，默认重新核验。除非证据明确长期稳定，否则不要用 `*` 给版本敏感的 PATCH/汉化结论放行。

`closure-gate.js` 会自动把 REQUIRED 附属文件加入最终下载清单。缺 PATCH 或 TRANSLATION 结论时会变成 `HOLD_CLOSURE`，不得绕过。

## 4. 独立汉化页不能靠文件名关键词判断

一旦已经确认某个 Nexus modId 是该主 MOD 的汉化页，该页面的 MAIN FILE 即使名称里没有 `Chinese/汉化/CHS`，也可以是正确汉化文件。

因此独立汉化关系必须记录到 registry，不要依赖“文件名里有没有汉化两个字”。

## 5. 多个 Patch 不能只取最新一个

同一页面可能同时有 JK、USSEP、LOTD、CC、BodySlide 等不同补丁族。它们是并列关系，不是“同类只取 fileId 最大的一个”。

先按补丁目标分族，再根据当前启用 modlist/requirements 判断哪些需要。需要的每一个都写成 REQUIRED。

## 6. 下载只能使用精确 fileId

最终执行必须来自 `manifest-final-*.tsv` / `run-*.tsv`，每行都要有：

```text
modId + fileId + version + DOWNLOAD
```

禁止从搜索结果、最新上传、相邻 fileId、模糊名称直接点击。

## 7. 成功的定义

`SUBMITTED` 不是成功，`LANDED` 也不是最终成功。只有：

```text
VERIFIED
```

才允许报告“已下载完成”。必须核对 `.meta` 的 modID/fileID/version，并通过 7-Zip 测试。

## 8. 推荐工作循环

1. Audit pipeline；
2. 逐项解决 HOLD；
3. 更新 `aux-registry.tsv`；
4. 再次 Audit，直到目标批次无关键 HOLD；
5. 用户授权后 `node index.js ... --go`；
6. 对非 VERIFIED 项单独重试/人工处理；
7. 不安装、不启用、不排序，除非用户另外明确授权。
