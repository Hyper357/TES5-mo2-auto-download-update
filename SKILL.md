---
name: skyrim-mo2-safe-update
description: "Safely audit and download Skyrim SE/AE Nexus mod updates through MO2 with exact file IDs, patch/translation closure, deferred human review for ambiguous variants, queue idempotency, diagnostics, and VERIFIED completion."
---

# Skyrim MO2 Safe Update Skill

`AGENTS.md` contains the mandatory safety rules. This file is a compact operating guide; do not load historical `docs/v3.*` unless maintaining a specific subsystem.

## 1. Start with the small status surface

```powershell
git pull
npm install
npm run check
npm test
npm run agent:status
```

Do **not** begin by reading the whole repository, README, every runtime JSON, or all logs. Use `agent:status` to decide what evidence is needed next.

State mapping:

- `COMPLETE` → no action.
- `READY_FOR_GO` → wait for explicit user download authorization.
- `REVIEW_REQUIRED` → `npm run review`.
- `PATCH_REVIEW_REQUIRED` → inspect only `patch-discovery-tasks.tsv` and matching discovery entries.
- `ATTENTION` → use the listed errorCode, then matching diagnostics.
- `IN_PROGRESS_OR_ABORTED` → inspect the latest run's logs before rerunning anything.

## 2. Browser and environment

Use only the project-managed automation browser:

```powershell
npm run browser:start
npm run browser:status
```

Then optionally:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --diagnose
```

Do not assume a Skyrim runtime/platform/body/resolution from old examples. UNKNOWN is valid and safer than a false default.

## 3. Audit before download

Default:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --force-refresh
```

This produces a run under:

```text
.runtime/runs/<timestamp>/
```

Important artifacts are discovered through `agent:status`; normally you should not read every file.

Real download requires explicit user authorization:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --go
```

`--go` is download-only unless the user separately authorizes installation/enabling/sorting.

## 4. Main File decisions

A Main target must be grounded in local `installationFile`, `meta.ini`, or installed fileId and checked against variant evidence.

Never choose a file only because it is:

- newest upload;
- largest/newest fileId;
- labelled AE/NG/Patch by name alone;
- adjacent to the old file in Nexus Files.

If multiple mutually exclusive Main branches are credible (for example Vanilla / KS Hairdos / KS Hairdos HDT), return `HOLD_VARIANT_REVIEW`. Do not migrate branches automatically.

## 5. Patch and translation closure

Patch Discovery checks same-page files, Requirements reverse links, Description/Compatibility, learned `patch-relations.tsv`, installed MO2 context, and FOMOD clues.

For each discovered Patch family tied to the exact target mainFileId, resolve to:

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

`REQUIRED` must identify exact aux modId/fileId/version/name and pass registry audit. Coverage failure or unresolved candidates mean `HOLD_PATCH_DISCOVERY`.

Translation is an independent closure chain. A translation page may use a Main File whose filename does not contain Chinese/CHS/汉化; rely on verified relationship evidence, not keywords alone.

## 6. Review Center

Complex/ambiguous items are intentionally deferred:

```powershell
npm run review
```

The page shows the automatic-stage report and exact allowed Main/Patch candidates. User selection authorizes a known exact candidate only.

The Review Center cannot bypass:

- incomplete Patch Discovery coverage;
- arbitrary fileId validation;
- preflight;
- single executor lock;
- submission ledger / in-flight detection;
- MO2 UI Guard;
- final VERIFIED checks.

## 7. Download execution and recovery

Execution is transaction-based:

```text
MAIN → VERIFIED → PATCH(es) → VERIFIED → TRANSLATION → VERIFIED
```

If a target is already COMPLETE/INFLIGHT/SUBMITTED, wait and verify instead of submitting another NXM. Do not use `--force-resubmit` without explicit user permission and evidence that the old submission does not exist.

Useful status commands:

```powershell
npm run queue:status
npm run mo2:status
npm run agent:status
```

MO2 duplicate dialogs are handled conservatively: safe OK/No only when identity is reliable. Never automatically choose Yes/Re-download.

## 8. Failure triage

Use the smallest evidence surface possible:

1. `npm run agent:status`.
2. The listed errorCode.
3. Matching entry in `diagnostics/failed-items.json`.
4. Matching item in `execution-state.json` or submission ledger if needed.
5. Browser screenshot/diagnostic only for Browser/NXM failures.
6. Patch discovery artifacts only for Patch failures.

Do not rerun the whole batch because one exact target failed. Keep already VERIFIED items untouched.

For detailed diagnostics:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --go --debug
```

## 9. Privacy and scope

Never expose or commit Nexus API keys, cookies, Authorization headers, signed NXM URLs, or private browser-session data. Runtime artifacts stay under ignored `.runtime/` unless the user explicitly asks for a sanitized report.

Default scope is audit/download. Installation, activation, disabling, cleanup, and sorting require separate explicit authorization.

## 10. Maintenance map

When a code bug genuinely requires source inspection, read only the relevant subsystem:

```text
Main/variant selection      scripts/lib/file-selector.js, variant-review.js
Patch discovery             scripts/discover-patches.js, lib/patch-discovery.js
Closure/registry            scripts/closure-gate.js, lib/aux-registry.js
Browser isolation           scripts/browser-manager.js, lib/browser-session.js
NXM/Nexus handoff           scripts/nexus-autodl.js (targeted search first)
Queue/idempotency           scripts/execute-plan.js, lib/download-guard.js
MO2 UI guard                scripts/mo2-ui.js, lib/mo2-ui-guard.js, *.ps1
Human review                scripts/lib/review-center-model.js, web/review/*, review-*.js
Agent summary               scripts/agent-status.js
Shared infrastructure       scripts/lib/cli.js, fs-json.js, manifest.js, process-runner.js, runtime.js
```

Search for the errorCode/function first; do not load large files wholesale unless the targeted search is insufficient.
