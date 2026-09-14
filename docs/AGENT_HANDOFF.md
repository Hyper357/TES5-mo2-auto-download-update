# Agent Handoff — current architecture map

Use root `AGENTS.md` for mandatory policy. Use this file only when a task needs architecture context beyond `agent:brief`.

## 1. System mission

The repository safely audits and downloads Skyrim SE/AE Nexus updates for Mod Organizer 2 using exact file identity, active-profile evidence, deterministic safety gates, human review for ambiguity, and final archive/disk verification.

Default scope is audit/download only. Installation, FOMOD operation, enable/disable, priority/load-order changes, plugin sorting, and archive deletion are outside default scope.

## 2. Pipeline

```text
MO2 Environment Graph
        ↓
Update Eligibility
        ↓
Main / Variant
        ↓
Component Discovery / Closure
        ↓
┌───────────────────────────────┐
│ safe automatic transaction   │
│ or Review Center exact pick  │
└───────────────────────────────┘
        ↓
Preflight: browser + Nexus API + MO2/runtime
        ↓
Exact target verification through Nexus Files API
        ↓
Managed browser obtains signed exact NXM identity
        ↓
Nexus download-link API
        ↓
Direct Nexus CDN transfer
        ↓
7-Zip integrity test
        ↓
Atomic publish to MO2 downloads + metadata
        ↓
Exact disk verification
        ↓
VERIFIED
```

## 3. Core modules

```text
index.js                              top-level pipeline coordinator
scripts/run-workflow.js               update/audit command orchestration
scripts/check-outdated.js             eligibility + Main/variant planning
scripts/lib/update-eligibility.js     deterministic update gate
scripts/lib/mo2-environment.js        active profile Environment Graph
scripts/lib/file-selector.js          exact Main/file selection evidence
scripts/lib/variant-policy.js         semantic branch memory
scripts/lib/component-discovery.js    generalized component discovery
scripts/closure-gate.js               component closure gate
scripts/lib/aux-registry.js           known auxiliary relationships
scripts/review-server.js              local Review Center server/API
scripts/review-download.js            reviewed exact manifest builder + preflight
scripts/review-exact-execute.js       scoped executor for explicit exact review picks
scripts/execute-plan.js               transaction executor / VERIFIED state machine
scripts/lib/direct-session.js         exact Nexus API/browser/CDN session
scripts/lib/direct-nexus-download.js  download-link/CDN/archive publish helpers
scripts/lib/download-guard.js         exact download idempotency / disk state
scripts/lib/review-failure-log.js     durable reviewed-job failure artifacts
scripts/lib/runtime.js                runtime/review-run discovery + summaries
web/review/*                          current Review Center frontend
scripts/agent-brief.js                compact default agent state
scripts/agent-status.js               expanded agent diagnostics
scripts/agent-bootstrap.js            safe latest-main takeover/bootstrap
```

## 4. Current Review Center design

Review Center is a staging UI, not a way around upstream gates.

Key current invariants:

- old `review-center.json` can be reopened, but the server renders it with the **current** frontend assets;
- saved selections are repaired to exact `{modId,fileId}` identities and invalid/stale entries are removed;
- server-side exact allow-list validation remains authoritative;
- `HOLD_UPDATE_ELIGIBILITY` cannot be released directly from review;
- explicit exact file-picker rows carry `user-selected-nexus-file` and are routed through `review-exact-execute.js`;
- that scoped review executor uses an empty replacement context solely to avoid false `LOCAL_MULTI_VERSION_IDENTITY` conflicts caused by unrelated local folders sharing one Nexus mod page;
- automatic/legacy Main replacement still uses the strict local identity guard;
- `/api/job` exposes safe live progress/failure snapshots derived from `execution-state.json`;
- final reviewed-job failures persist to structured and human-readable artifacts.

## 5. Runtime state and artifacts

`.runtime/` is local and intentionally ignored by Git.

Typical important files:

```text
.runtime/state/submission-ledger.json
.runtime/state/variant-policies.json
.runtime/state/browser-port.json
.runtime/runs/<timestamp>/review-center.json
.runtime/runs/<timestamp>/review-center-config.json
.runtime/runs/<timestamp>/review-jobs/<job>/job.json
.runtime/runs/<timestamp>/review-jobs/<job>/execution-state.json
.runtime/runs/<timestamp>/review-jobs/<job>/review-failures.json
.runtime/runs/<timestamp>/review-jobs/<job>/review-failures.log
.runtime/runs/<timestamp>/review-failure-history.jsonl
.runtime/runs/<timestamp>/logs/errors.jsonl
```

A fresh clone may have no `.runtime`. Do not misdiagnose that as project failure. See `docs/LOCAL_SETUP.md`.

## 6. Operational entry points

First takeover on clean `main`:

```bash
node scripts/agent-bootstrap.js
```

Compact status:

```bash
npm run agent:brief
npm run agent:mod -- <modId>
```

Real user-authorized update:

```bash
npm run update
```

Audit only:

```bash
npm run audit
```

Review:

```bash
npm run review
```

Focused diagnostics:

```bash
npm run updates:status
npm run environment:status
npm run browser:status
npm run queue:status
npm run mo2:status
```

## 7. Non-negotiable safety properties

- exact identity wins over names/version strings;
- active profile resolution controls applicability reasoning;
- MO2 red warning is not update truth;
- yellow metadata is only a candidate signal;
- update eligibility precedes Main/components;
- a discovered component is not automatically required;
- API/browser/download safety failures are not bypassed;
- COMPLETE/INFLIGHT/recent SUBMITTED targets are not blindly duplicated;
- only `VERIFIED` completes a transaction;
- one exact failure does not justify rerunning already VERIFIED items;
- no secrets in Git/logs/chat.

## 8. Development workflow

For a FIX:

```text
bootstrap on clean main
→ create task branch
→ reproduce with smallest evidence
→ targeted tests
→ edit
→ targeted tests
→ npm test once
→ PR / CI
→ merge
```

Do not refactor unrelated modules during a focused defect fix. Keep failure evidence structured and bounded for later agents.
