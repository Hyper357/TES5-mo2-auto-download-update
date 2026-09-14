# TES5 MO2 Auto Download Update

Evidence-bound Nexus/MO2 update automation for Skyrim SE/AE.

> **Only evidence-backed exact targets may download, and only `VERIFIED` counts as success.**

Current package line: **v4.1.15-beta.1**. The repository also includes newer post-version Review Center reliability fixes on `main`; use Git HEAD, not this string alone, as code freshness truth.

## AI agent: start here

A new agent taking over the project should read root `AGENTS.md` and then run, from a clean `main` checkout:

```bash
node scripts/agent-bootstrap.js
```

This safely:

- fast-forwards `origin/main` with `git pull --ff-only`;
- refuses a dirty worktree or non-main branch rather than overwriting work;
- repairs npm dependencies only when needed;
- runs syntax checks;
- prints compact live state through `agent:brief`.

Then follow `docs/TASK_ENTRY.md`.

Human Windows convenience:

```text
START_AGENT.cmd   → safe sync/check/compact state
START_REVIEW.cmd  → safe sync/open latest recoverable Review Center
```

## What the project does

The fixed high-level chain is:

```text
MO2 active profile / local exact identity
→ Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ automatic safe transaction OR Review Center exact selection
→ Nexus API + isolated browser exact identity
→ direct Nexus CDN download
→ 7-Zip integrity test
→ publish into MO2 downloads
→ exact disk verification
→ VERIFIED
```

Core capabilities:

- exact `meta.ini / installationFile / fileId` anchoring;
- active MO2 profile Environment Graph from `modlist.txt / plugins.txt / loadorder.txt`;
- Update Eligibility before Main/Variant/component decisions;
- semantic Variant Decision Memory;
- generalized component closure for RESOURCE/MESH/TEXTURE/PHYSICS/BODYSLIDE/CONFIG/HOTFIX/PATCH/TRANSLATION/OPTIONAL_COMPONENT;
- isolated managed browser and Nexus API preflight;
- direct exact Nexus CDN transport with archive validation;
- idempotent exact transaction execution;
- local Review Center for ambiguous/manual exact files;
- live per-MOD Review Center progress/failure logging;
- persistent per-job failure artifacts for later AI debugging.

## Normal commands

Real full update, after the user has explicitly authorized an update:

```bash
npm run update
```

Audit only:

```bash
npm run audit
```

Hard refresh only when cache staleness is specifically suspected:

```bash
npm run update:fresh
npm run audit:fresh
```

Compact state surfaces:

```bash
npm run agent:brief
npm run agent:mod -- <modId>
npm run updates:status
npm run environment:status
npm run browser:status
npm run queue:status
npm run mo2:status
```

Review Center:

```bash
npm run review
```

## Review Center — current behavior

The current Review Center is deliberately defensive:

- old run JSON is rendered with the **current frontend**, preventing stale generated HTML from reviving obsolete UI logic;
- saved selections are repaired/migrated; invalid `undefined:undefined` targets are dropped;
- the server-side exact allow-list remains authoritative;
- explicit exact Review Center picks are not falsely blocked solely because several independent local folders share one Nexus modId;
- automatic Main replacement keeps the strict local identity guard;
- preflight reports detailed Nexus API failure classes;
- the page shows live planned/active/verified/pending/failed exact targets while a job runs;
- final failures remain on disk for later diagnosis.

Persistent failure evidence:

```text
review-jobs/<job>/review-failures.json
review-jobs/<job>/review-failures.log
review-jobs/<job>/execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

## Update truth and safety rules

Update evidence priority:

1. Nexus exact `file_updates` chain;
2. clearly newer compatible upload relative to installed exact file;
3. MO2 yellow-arrow-equivalent metadata signal;
4. version strings;
5. MO2 red warning icon / author metadata warning.

Item 5 is not update truth. Yellow metadata is a candidate signal, not a download authorization.

`HOLD_UPDATE_ELIGIBILITY` cannot be bypassed from Review Center.

If active MO2 profile resolution is ambiguous (`PROFILE_UNRESOLVED`), the program must not infer applicability from absence/disabled state.

Default scope is audit/download only. It does **not** automatically install, operate FOMOD, enable/disable MODs, reorder MO2, sort plugins, or delete archives.

## Success definition

These are intermediate states, not success:

```text
clicked
signed NXM captured
SUBMITTED
PUBLISHED
MO2 queue visible
```

Only:

```text
VERIFIED
```

is success.

## Runtime vs repository truth

GitHub contains code, policy, tests, and documentation.

The user's live machine contains:

```text
.runtime/
Nexus API key
Nexus login/browser session
MO2 paths/profile state
submission ledger
variant policies
historical run artifacts
```

`.runtime/` is intentionally ignored by Git and may be absent in a fresh clone. See `docs/LOCAL_SETUP.md`.

## Agent documentation

Read in this order:

```text
AGENTS.md                 mandatory current protocol
docs/AI_START_HERE.md     shortest operational handoff
docs/TASK_ENTRY.md        RUN / AUDIT / FIX / INVESTIGATE routing
docs/LOCAL_SETUP.md       local Windows/MO2 contract
docs/DEBUG_PLAYBOOK.md    exact error-code triage
docs/AGENT_HANDOFF.md     architecture map
```

Do not treat `docs/CURRENT_STATE.md` as live machine state; it is a repository baseline and points back to the compact runtime commands.

## Privacy

Never commit or expose Nexus API keys, cookies, Authorization, full signed NXM URLs, or private browser-session data.
