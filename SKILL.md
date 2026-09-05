---
name: skyrim-mo2-safe-update
description: "Safely audit and download Skyrim SE/AE Nexus mod updates through MO2 with exact file IDs, persistent variant memory, generalized component closure, deferred human review, queue idempotency, diagnostics, and VERIFIED completion."
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
- `COMPONENT_REVIEW_REQUIRED` → inspect only the component discovery task file and matching discovery entries.
- `ATTENTION` → use the listed errorCode, then matching diagnostics.
- `IN_PROGRESS_OR_ABORTED` → inspect the latest run's status/log evidence before rerunning anything.

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

This produces a run under `.runtime/runs/<timestamp>/`. Important artifacts are surfaced through `agent:status`; normally do not read every file.

Real download requires explicit user authorization:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --go
```

`--go` is download-only unless the user separately authorizes installation/enabling/sorting.

## 4. Main File + remembered variant decisions

A Main target must be grounded in local `installationFile`, `meta.ini`, or installed fileId and checked against variant evidence.

Never choose a file only because it is newest, has the largest fileId, or is adjacent to the old file in Nexus Files.

If multiple mutually exclusive Main branches are credible (for example Vanilla / KS Hairdos / KS Hairdos HDT), use Review Center. A Main branch is remembered only after an explicit user click, and the policy stores semantic `branchKey`, not transient fileId.

If the remembered branch disappears, becomes ambiguous, or conflicts with the current runtime/body/resolution/CC environment:

```text
HOLD_VARIANT_POLICY_CHANGED
```

Never silently fall back to another branch.

Useful controls:

```powershell
npm run variant:status
npm run variant:forget -- <modId>
```

## 5. Generalized Component Discovery + Closure

Before Main is released, discovery considers:

- same-page Nexus Files;
- **forward Nexus Requirements** for resources/frameworks/dependencies required by the Main;
- reverse `Mods requiring this file` relationships for independent patches/add-ons;
- Description links/text;
- learned Patch relationship registry;
- installed MO2 context;
- local FOMOD option names.

Component kinds include:

```text
RESOURCE
MESH
TEXTURE
PHYSICS
BODYSLIDE
CONFIG
HOTFIX
PATCH
TRANSLATION
OPTIONAL_COMPONENT
```

**Discovered does not mean Required.** For every discovered `kind + family` tied to the exact target `mainFileId`, resolve to:

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

Only `REQUIRED` creates a download and it must identify exact aux modId/fileId/version/name and pass registry audit.

Coverage failure or unresolved candidate means:

```text
HOLD_COMPONENT_DISCOVERY
```

Stale/missing/invalid/conflicting registry evidence means:

```text
HOLD_COMPONENT_CLOSURE
HOLD_CLOSURE_CONFLICT
```

Do not infer that an Optional Files entry should be downloaded merely because it exists. `requiredHint` from forward Requirements is evidence, not permission to bypass exact identity validation.

Translation remains an explicit independent closure chain.

## 6. Review Center

Complex/ambiguous items are intentionally deferred:

```powershell
npm run review
```

The page shows the automatic-stage report, Main choices, and unresolved Component families. Each Component family can be resolved as:

```text
DOWNLOAD
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
SKIP_FOR_NOW
```

A DOWNLOAD selection can only use a server-generated exact `modId:fileId`. Candidates without exact identity cannot be downloaded from the page.

Review Center cannot bypass incomplete discovery coverage, exact candidate validation, preflight, single executor lock, submission ledger, MO2 UI Guard, or final VERIFIED checks.

If the deterministic planner had already selected the Main and only Component Closure held it, reviewed download must restore that exact Main target together with selected components. It must not download only the companion file and leave the held Main behind.

## 7. Download execution and recovery

All exact download rows in a transaction are verified individually. A failure blocks later rows in that transaction.

Page click, NXM extraction, nxmhandler handoff, SUBMITTED, or MO2 queue appearance are not success. Only:

```text
VERIFIED
```

is success.

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
2. The listed errorCode / nextActions.
3. Matching entry in `diagnostics/failed-items.json` if needed.
4. Matching item in `execution-state.json` or submission ledger if needed.
5. Browser screenshot/diagnostic only for Browser/NXM failures.
6. Component discovery artifacts only for Component failures.

Do not rerun the whole batch because one exact target failed. Keep already VERIFIED items untouched.

## 9. Privacy and scope

Never expose or commit Nexus API keys, cookies, Authorization headers, signed NXM URLs, or private browser-session data. Runtime artifacts stay under ignored `.runtime/` unless the user explicitly asks for a sanitized report.

Default scope is audit/download. Installation, FOMOD operation, activation, disabling, cleanup, and sorting require separate explicit authorization.

## 10. Maintenance map

When a code bug genuinely requires source inspection, read only the relevant subsystem:

```text
Main/variant selection       scripts/lib/file-selector.js, variant-review.js, variant-policy.js
Component discovery          scripts/discover-patches.js, lib/component-discovery.js
Legacy Patch helpers         scripts/lib/patch-discovery.js
Closure/registry             scripts/closure-gate.js, lib/aux-registry.js
Browser isolation            scripts/browser-manager.js, lib/browser-session.js
NXM/Nexus handoff            scripts/nexus-autodl.js (targeted search first)
Queue/idempotency            scripts/execute-plan.js, lib/download-guard.js
MO2 UI guard                 scripts/mo2-ui.js, lib/mo2-ui-guard.js, *.ps1
Human review                 scripts/lib/review-center-model.js, web/review/*, review-*.js
Agent summary                scripts/agent-status.js
Shared infrastructure        scripts/lib/cli.js, fs-json.js, manifest.js, process-runner.js, runtime.js
```

Search for the errorCode/function first; do not load large files wholesale unless targeted inspection is insufficient.
