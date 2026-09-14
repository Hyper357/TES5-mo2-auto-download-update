---
name: skyrim-mo2-safe-update
description: "Safely audit and download Skyrim SE/AE Nexus mod updates through MO2 with exact update eligibility, active-profile evidence, Review Center exact picks, direct Nexus CDN transport, live failure logs, and VERIFIED completion."
---

# Skyrim MO2 Safe Update Skill

Root `AGENTS.md` is mandatory. GitHub `main` is code truth; local `.runtime/` is runtime truth.

## Startup

On a clean `main` checkout:

```bash
node scripts/agent-bootstrap.js
```

This fast-forwards `origin/main`, checks dependencies/syntax, and prints compact live state. It refuses dirty/non-main worktrees instead of resetting them.

Normal status commands:

```bash
npm run agent:brief
npm run agent:mod -- <modId>
```

## User intent

Explicit full-update intent (`开始项目`, `开始更新`, `跑完整流程`, `更新我的 MOD`, `开始完整更新`):

```bash
npm run update
```

Explicit audit-only intent:

```bash
npm run audit
```

Human review:

```bash
npm run review
```

Do not ask for a second download authorization after `npm run update` has already been authorized; deterministic gates still decide what may actually download.

## Fixed safety chain

```text
Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ Preflight
→ exact Download
→ archive/disk verification
→ VERIFIED
```

Only `VERIFIED` is success.

## Current execution transport

```text
Nexus Files API exact target
→ project-managed isolated browser obtains signed exact identity
→ Nexus download-link API
→ direct CDN transfer
→ 7-Zip archive validation
→ atomic publish to MO2 downloads
→ exact disk verification
```

Do not bypass API validation, exact fileId checks, browser isolation, archive testing, or final disk verification.

## Environment rules

Active profile facts come from `modlist.txt`, `plugins.txt`, `loadorder.txt`, mod `meta.ini`, and plugin files.

Profile evidence priority: explicit profile dir/name → selected profile in `ModOrganizer.ini` → unique sole profile.

`PROFILE_UNRESOLVED` means no absence/disabled-based applicability inference.

MO2 red warning icons are observational only. Yellow update metadata is a candidate signal, not download authorization.

## Review Center

Current Review Center behavior includes:

- reopening historical review JSON with the current frontend;
- migration/cleanup of stale saved selections;
- exact server allow-list validation;
- scoped handling of explicit exact picks when several independent local folders share one Nexus modId;
- strict local identity protection retained for automatic Main replacement;
- detailed Nexus API preflight failures;
- live per-MOD progress/failure display;
- persistent failure artifacts.

Preferred failure evidence:

```text
HTML live log
review-failures.json
review-failures.log
execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

## Failure discipline

Diagnose exact `tx + modId:fileId`. Do not rerun VERIFIED items or the whole library for one failure. Do not run the same probe more than twice if results repeat.

See `docs/DEBUG_PLAYBOOK.md` only after a concrete error/status is known.

## Privacy / scope

Never expose API keys, cookies, Authorization, full signed NXM URLs, or private browser-session data. `.runtime/` stays local.

Default scope is audit/download only. Installation, FOMOD operation, enabling/disabling, load-order changes, plugin sorting, and archive deletion require separate explicit authorization.

## Maintenance map

```text
Agent startup              scripts/agent-bootstrap.js, scripts/agent-brief.js
Eligibility                scripts/lib/update-eligibility.js, scripts/check-outdated.js
MO2 environment            scripts/lib/mo2-environment.js, scripts/environment-status.js
Main / variant             scripts/lib/file-selector.js, scripts/lib/variant-policy.js
Components / closure       scripts/lib/component-discovery.js, scripts/closure-gate.js
Review UI/API              scripts/review-server.js, web/review/*
Reviewed exact execution   scripts/review-download.js, scripts/review-exact-execute.js
Executor                   scripts/execute-plan.js
Nexus/browser/CDN          scripts/lib/direct-session.js, scripts/lib/direct-nexus-download.js
Idempotency                scripts/lib/download-guard.js
Failure artifacts          scripts/lib/review-failure-log.js
Runtime discovery          scripts/lib/runtime.js
```

Search errorCode/function first. Do not load large files wholesale unless targeted inspection is insufficient.
