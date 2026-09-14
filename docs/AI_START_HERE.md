# AI START HERE — authoritative operational entry

This file is the shortest safe path for a new AI agent taking over this repository.

## Source of truth

Two truths exist and must not be confused:

1. **Code truth:** GitHub `main`.
2. **Runtime truth:** the local `.runtime/` tree on the Windows/MO2 machine.

Do not infer live runtime state from historical docs. Do not treat `docs/CURRENT_STATE.md` as a live snapshot. The first live state surface is `npm run agent:brief`.

## First command on a clean checkout

```bash
node scripts/agent-bootstrap.js
```

The bootstrap is intentionally conservative. It:

- requires the current branch to be `main`;
- refuses to overwrite a dirty worktree;
- runs `git pull --ff-only origin main`;
- checks the npm dependency tree and runs `npm ci` only when needed;
- runs syntax checks;
- prints the compact live `agent:brief` state.

It never hard-resets, force-checkouts, deletes `.runtime`, changes MO2 state, or starts a download.

If bootstrap reports `AGENT_BOOTSTRAP_DIRTY_WORKTREE` or `AGENT_BOOTSTRAP_NOT_MAIN`, stop and preserve the worktree. Do not reset it just to continue.

## Then classify the task

### RUN — user asked for a real full update

Examples: `开始项目`, `开始更新`, `跑完整流程`, `更新我的 MOD`, `开始完整更新`.

```bash
npm run update
```

Do not stop after audit and ask for a second download authorization. The update command still enforces Update Eligibility, Main/Variant, Component Closure, browser/API preflight, exact identity, idempotency, and VERIFIED completion.

### AUDIT — user explicitly asked to inspect only

```bash
npm run audit
```

Use `npm run audit:fresh` only when stale Nexus cache is specifically suspected or a hard refresh was requested.

### REVIEW — user is resolving held/ambiguous items

```bash
npm run review
```

On the user's Windows machine, `START_REVIEW.cmd` is the one-click equivalent and first fast-forwards `main`.

### FIX — code defect

Read only the implicated modules. Run targeted tests while editing, then run full `npm test` once before PR/merge. Do not use runtime failures as a reason to weaken safety gates globally.

## Current architecture to know before editing

The current execution path is:

```text
MO2 active profile / meta.ini
→ Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ automatic safe transactions OR Review Center exact selections
→ Nexus API + isolated browser obtains signed exact identity
→ direct Nexus CDN download
→ archive integrity test
→ publish into MO2 downloads
→ disk verification
→ VERIFIED
```

Important current behavior:

- Review Center re-renders old review JSON with the **current UI**, so historical generated HTML cannot freeze an old frontend.
- saved Review Center selections are normalized/migrated and invalid `undefined:undefined` selections are dropped before submission;
- manual exact Review Center picks are scoped so unrelated local folders sharing one Nexus mod page do not cause `LOCAL_MULTI_VERSION_IDENTITY` false blocks;
- this exception applies only to explicit exact file-picker downloads, not automatic Main replacement;
- Nexus preflight reports exact API failure classes such as 401/403, 429, timeout/DNS, and 5xx;
- Review Center shows **live per-MOD progress/failures** while the executor is running;
- final failures are persisted to `review-failures.json`, `review-failures.log`, and append-only `review-failure-history.jsonl`;
- only `VERIFIED` is success.

## Small status surfaces

Use these before opening large artifacts:

```bash
npm run agent:brief
npm run agent:mod -- <modId>
npm run updates:status
npm run environment:status
npm run browser:status
npm run queue:status
npm run mo2:status
```

Do not dump whole `plan.json`, `review-center.json`, ledgers, or JSONL logs into model context unless a specific field cannot be obtained from compact status tools.

## Runtime evidence for a failed Review Center job

Prefer, in order:

```text
Review Center live log panel
review-jobs/<job>/review-failures.json
review-jobs/<job>/review-failures.log
review-jobs/<job>/execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

A single failure should be diagnosed by exact `tx + modId:fileId`. Do not blindly rerun VERIFIED items or the full batch.

## Local-only dependencies

These are intentionally not stored in GitHub:

- Nexus API key;
- Nexus login/browser session;
- MO2 installation/profile state;
- Skyrim/MO2 paths;
- `.runtime/` history and ledgers.

See `docs/LOCAL_SETUP.md` for the expected local contract. Never commit or print secrets.

## Mandatory safety invariants

- exact `modId:fileId` identity beats names/version strings;
- MO2 red warning icons are not update evidence;
- yellow update metadata is a candidate signal, not a download authorization;
- unresolved active profile means no absence-based applicability inference;
- `HOLD_UPDATE_ELIGIBILITY` cannot be bypassed from Review Center;
- default scope is audit/download only: no automatic install, FOMOD operation, enable/disable, load-order sorting, or archive deletion;
- never expose API keys, cookies, Authorization headers, signed NXM URLs, or browser-session secrets;
- never replace a HOLD with a guess;
- success means `VERIFIED`, not clicked/submitted/queued.

For the complete mandatory policy, read root `AGENTS.md`. For debugging patterns, read `docs/DEBUG_PLAYBOOK.md` only after an actual error code is known.
