---
name: skyrim-mo2-safe-update
description: "Safely audit and download Skyrim SE/AE Nexus mod updates through MO2 with active-profile Environment Graph, exact file IDs, variant memory, component closure, deferred human review, queue idempotency, diagnostics, and VERIFIED completion."
---

# Skyrim MO2 Safe Update Skill

`AGENTS.md` contains mandatory safety rules. Start from small status surfaces; do not load historical docs or the whole repository by default.

## 1. Startup

```powershell
git pull
npm install
npm run check
npm test
npm run agent:status
```

State mapping:

- `COMPLETE` → no action.
- `READY_FOR_GO` → wait for explicit user download authorization.
- `REVIEW_REQUIRED` → `npm run review`.
- `COMPONENT_REVIEW_REQUIRED` → inspect only matching component task/discovery items.
- `ATTENTION` → follow errorCode/sourceHints.
- `IN_PROGRESS_OR_ABORTED` → inspect latest run before rerunning.

## 2. Active MO2 Environment Graph

Check the current Profile when environment/applicability matters:

```powershell
npm run environment:status
```

v4.0 reads:

```text
modlist.txt
plugins.txt
loadorder.txt
mods/*/meta.ini
plugin files
```

Profile selection priority: explicit `MO2_PROFILE_DIR`, `MO2_PROFILE_NAME`, `ModOrganizer.ini` selected profile, then a unique sole profile. Multiple unresolved profiles mean `PROFILE_UNRESOLVED`; do not infer absence/disabled applicability in that state.

If a profile is resolved, only **enabled** mods describe current runtime/body/compatibility context. Disabled mods may still be checked for updates but must not contaminate the active environment model.

### Do not trust MO2 red exclamation marks as update evidence

MO2/Nexus metadata warnings may come from author-entered version metadata. A red exclamation mark alone must never trigger download, update, branch migration, corruption diagnosis, or force-resubmit.

Authoritative identity is exact local/Nexus evidence: `meta.ini`, `installationFile`, `fileId`, Files API, verified relationships.

## 3. Browser and Audit

Use only the managed automation browser:

```powershell
npm run browser:start
npm run browser:status
```

Audit first:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --force-refresh
```

Real download requires explicit user authorization:

```powershell
node index.js "<mods-dir>" "<api-key-file>" --go
```

## 4. Main + Variant Memory

Main must be grounded in `installationFile/meta.ini/installed fileId`, then checked against platform/body/resolution/CC/semantic branch evidence.

Never choose by newest upload or largest fileId alone. Mutually exclusive branches go to Review Center. Explicit user Main choices may be remembered as semantic `branchKey`; changed/disappeared/conflicting branches become `HOLD_VARIANT_POLICY_CHANGED`, never automatic fallback.

```powershell
npm run variant:status
npm run variant:forget -- <modId>
```

## 5. Component Discovery + Environment Applicability

Discovery covers same-page Files, forward Requirements, reverse Requirements, Description, known relationships, active MO2 profile, and FOMOD clues.

Kinds:

```text
RESOURCE MESH TEXTURE PHYSICS BODYSLIDE CONFIG
HOTFIX PATCH TRANSLATION OPTIONAL_COMPONENT
```

Every discovered `kind + family` needs `REQUIRED / NOT_APPLICABLE / ALREADY_INCLUDED / OBSOLETE`. Only REQUIRED creates an exact audited download.

Environment Graph may auto-resolve only this narrow case:

```text
PATCH or HOTFIX
+ recognized compatibility family
+ resolved active Profile
+ counterpart definitely disabled-only or absent
→ high-confidence NOT_APPLICABLE
```

It must **not** auto-resolve required resources or other components merely because they are absent. A forward requirement that is disabled/absent stays HOLD (`REQUIRED_DEPENDENCY_DISABLED/ABSENT`).

## 6. Review Center

```powershell
npm run review
```

Review Center shows active Profile, mod profile state, Main options, Component families, exact candidates, Requirements hints, and Environment reason/evidence.

A DOWNLOAD decision can only use a server-generated exact `modId:fileId`; Review cannot bypass discovery coverage, preflight, lock, ledger, UI Guard or VERIFIED checks.

## 7. Execution safety

Only `VERIFIED` is success. NXM extraction, handler submission, queue appearance and SUBMITTED are intermediate states.

Already COMPLETE/INFLIGHT/SUBMITTED targets are waited/verified, not blindly handed to MO2 again.

```powershell
npm run queue:status
npm run mo2:status
npm run agent:status
```

MO2 duplicate dialogs allow safe OK/No only on reliable identity; never automatic Yes/Re-download.

## 8. Failure triage

Use the smallest evidence surface:

1. `npm run agent:status`;
2. profile issue → `npm run environment:status`;
3. errorCode/sourceHints;
4. matching diagnostics/state/ledger entry;
5. browser artifacts only for browser/NXM failures;
6. component artifacts only for component failures.

Do not rerun VERIFIED items or the entire batch for one exact failure.

## 9. Privacy and scope

Never expose/commit API keys, cookies, Authorization, signed NXM URLs or private browser-session data. Default scope is audit/download. Installation, FOMOD operation, activation, disabling, cleanup and sorting need separate authorization.

## 10. Maintenance map

```text
MO2 environment             scripts/lib/mo2-environment.js, scripts/environment-status.js
Main/variant                scripts/check-outdated.js, lib/file-selector.js, variant-*.js
Component discovery         scripts/discover-patches.js, lib/component-discovery.js
Closure/registry            scripts/closure-gate.js, lib/aux-registry.js
Browser                     scripts/browser-manager.js, lib/browser-session.js
NXM/Nexus                   scripts/nexus-autodl.js (targeted search first)
Queue/idempotency           scripts/execute-plan.js, lib/download-guard.js
MO2 UI guard                scripts/mo2-ui.js, lib/mo2-ui-guard.js, *.ps1
Human review                scripts/lib/review-center-model.js, web/review/*, review-*.js
Agent summary               scripts/agent-status.js
```

Search the errorCode/function first; do not load large files wholesale unless targeted inspection is insufficient.
