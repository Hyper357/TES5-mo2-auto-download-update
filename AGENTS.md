# AI Agent Mandatory Protocol — current authoritative entry

This repository automates evidence-bound Skyrim SE/AE Nexus downloads for Mod Organizer 2. The governing rule is simple:

> **Prefer HOLD over guessing. Only `VERIFIED` is success.**

A new agent should be able to take over from this file without replaying chat history.

## 0. First takeover action

On a clean checkout of `main`, run exactly:

```bash
node scripts/agent-bootstrap.js
```

That command safely fast-forwards `origin/main`, repairs npm dependencies only when needed, runs syntax checks, and prints compact live state with `agent:brief`. It refuses dirty worktrees and non-main branches; it never hard-resets or deletes local state.

Then read `docs/TASK_ENTRY.md` and execute **one** task path.

Do not use `docs/CURRENT_STATE.md` as live runtime truth. GitHub `main` is code truth; local `.runtime/` is runtime truth.

## 1. User intent routing

The following phrases authorize a real full update:

```text
开始项目
开始更新
跑完整流程
更新我的 MOD
开始完整更新
```

Run:

```bash
npm run update
```

Do not stop after audit and ask for a second authorization. The update command itself still enforces every safety gate.

The following phrases mean audit only:

```text
检查一下
扫描一下
看看有哪些更新
只审计
不要下载
```

Run:

```bash
npm run audit
```

Use `update:fresh` / `audit:fresh` only when cache staleness is actually suspected or explicitly requested.

If the task is human review, run:

```bash
npm run review
```

## 2. Fixed decision chain

Never reorder or bypass this chain:

```text
Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ Preflight
→ exact Download
→ archive/disk verification
→ VERIFIED
```

Before discussing Main or Patch, first prove that the MOD actually needs an update.

Update-evidence priority:

1. exact Nexus `file_updates` chain (`old_file_id -> new_file_id`);
2. clearly newer compatible upload relative to the installed exact file;
3. MO2 yellow-arrow-equivalent metadata signal;
4. version/newestVersion strings;
5. MO2 red warning icons / author metadata warnings.

Item 5 is observational only and must not authorize an update.

Expected eligibility states include:

```text
UPDATE_CONFIRMED
HOLD_UPDATE_ELIGIBILITY
SKIP_METADATA_FALSE_POSITIVE
SKIP_UP_TO_DATE
SKIP_IGNORED_UPDATE
```

`HOLD_UPDATE_ELIGIBILITY` is an upstream HOLD and cannot be released by simply clicking an exact file in Review Center.

## 3. Active MO2 Environment Graph

Environment facts come from the active MO2 profile:

```text
modlist.txt
plugins.txt
loadorder.txt
mods/*/meta.ini
top-level esp/esm/esl files
```

Profile evidence priority:

1. explicit `MO2_PROFILE_DIR` / profile-dir;
2. explicit `MO2_PROFILE_NAME` / profile-name;
3. selected profile in `ModOrganizer.ini`;
4. unique sole profile.

Multiple unresolved profiles → `PROFILE_UNRESOLVED`.

When profile resolution is not trustworthy, never infer `NOT_APPLICABLE` merely because a counterpart is absent/disabled. Only enabled mods define current runtime/body/compatibility context; disabled mods may still be scanned for their own updates.

## 4. Main and Variant rules

Main selection is anchored to local exact identity:

```text
meta.ini
installationFile
installed fileId
Nexus Files API
runtime/body/role/semantic branch evidence
```

Never choose Main by newest upload date, largest fileId, or name similarity alone.

Mutually exclusive plausible branches go to Review Center. Explicit user branch choices may persist as semantic `branchKey` in `.runtime/state/variant-policies.json`; branch disappearance or conflict becomes `HOLD_VARIANT_POLICY_CHANGED`, never automatic fallback.

## 5. Component Discovery / Closure

Supported component kinds include:

```text
RESOURCE MESH TEXTURE PHYSICS BODYSLIDE CONFIG
HOTFIX PATCH TRANSLATION OPTIONAL_COMPONENT
```

Discovery may use same-page Files, forward Requirements, reverse Requirements, Description, known relationships, FOMOD clues, and the active MO2 environment.

A discovered candidate is not automatically required. Each `kind + family` must resolve to:

```text
REQUIRED
NOT_APPLICABLE
ALREADY_INCLUDED
OBSOLETE
```

A REQUIRED component must have exact `auxModId + auxFileId + auxVersion + auxName` and API audit evidence.

Automatic environment-based `NOT_APPLICABLE` is limited to narrow PATCH/HOTFIX compatibility cases with a reliably resolved active profile. Missing/disabled forward requirements remain HOLD, not automatic exclusion.

## 6. Browser, Nexus and exact download safety

Use only the project-managed browser:

```bash
npm run browser:start
npm run browser:status
```

Browser/profile mismatch is a hard gate. Never attach automation CDP to the user's normal browser profile.

Current exact download architecture is:

```text
Nexus Files API exact target
→ isolated browser obtains signed exact NXM identity
→ Nexus download-link API
→ direct Nexus CDN transfer
→ 7-Zip archive integrity test
→ atomic publish to MO2 downloads
→ exact disk verification
→ VERIFIED
```

Do not bypass Nexus API validation, exact fileId matching, archive testing, or disk verification.

## 7. Review Center current behavior

Review Center (`npm run review`) is an exact-file staging UI, not a safety bypass.

Current invariants/features:

- historical review JSON is rendered with the current frontend, so stale generated HTML cannot freeze old UI logic;
- saved selection state is normalized/migrated; invalid `undefined:undefined` entries are dropped before submission;
- exact user-selected `modId:fileId` targets must still exist in the immutable server allow-list;
- explicit exact file-picker downloads use a scoped local replacement context so unrelated same-modId local folders do not create false `LOCAL_MULTI_VERSION_IDENTITY` blocks;
- that exception is **only** for explicit Review Center exact picks; automatic Main replacement retains the strict local identity guard;
- Nexus preflight exposes useful 401/403, 429, timeout/DNS and 5xx detail;
- the HTML shows live per-MOD progress and failures while the executor runs;
- final failures persist to `review-failures.json`, `review-failures.log`, and `review-failure-history.jsonl`.

The UI may authorize only exact targets already produced by server-side review evidence.

## 8. Idempotency and success

Clicked download, signed NXM capture, CDN start, MO2 queue appearance, `SUBMITTED`, or `PUBLISHED` are not success.

Only:

```text
VERIFIED
```

is success.

Before exact submission/download, honor downloads `.meta/.unfinished`, submission ledger, executor lock, and exact disk state. COMPLETE/INFLIGHT/recent SUBMITTED targets must be waited/verified, not blindly duplicated.

Never rerun VERIFIED items because one sibling target failed.

## 9. Failure handling

Start small:

```bash
npm run agent:brief
npm run agent:mod -- <modId>
```

Then, only as needed:

```bash
npm run updates:status
npm run environment:status
npm run browser:status
npm run queue:status
npm run mo2:status
```

For Review Center failures, prefer:

```text
HTML live log panel
review-jobs/<job>/review-failures.json
review-jobs/<job>/review-failures.log
review-jobs/<job>/execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

Diagnose one `tx + modId:fileId` at a time. Do not paste whole large JSON/JSONL artifacts into model context. Do not run the same probe more than twice if it returns the same result.

See `docs/DEBUG_PLAYBOOK.md` after a concrete errorCode is known.

## 10. Task discipline

`RUN`: bootstrap/brief → `npm run update` → brief/report. Do not run full tests when code did not change.

`AUDIT`: bootstrap/brief → `npm run audit` → report. No download.

`FIX`: inspect only implicated files → targeted tests → full `npm test` once before PR/merge.

`INVESTIGATE`: read-only and bounded. Do not mutate or run full regression unless reproduction requires it.

One task = one objective. Do not spontaneously start a redesign or unrelated audit.

## 11. Privacy and scope boundaries

Never commit, print, or expose:

```text
Nexus API key
cookies
Authorization headers
full signed NXM URLs
browser-session secrets
```

`.runtime/` stays local and ignored.

Default scope is audit/download only. Unless explicitly authorized, do not install MODs, operate FOMOD, enable/disable MODs, change MO2 priority/load order, sort plugins, or delete archives.

Never use `git reset --hard`, force checkout, deletion of `.runtime`, or ledger clearing merely to make a run pass.

## 12. Where to read next

- single operational handoff: `docs/AI_START_HERE.md`
- task routing: `docs/TASK_ENTRY.md`
- local machine contract: `docs/LOCAL_SETUP.md`
- known error handling: `docs/DEBUG_PLAYBOOK.md`
- architecture details: `docs/AGENT_HANDOFF.md`

Core principle:

> **First prove whether an update is needed; then prove the exact file; preserve HOLD when evidence is insufficient; finish only at VERIFIED.**
