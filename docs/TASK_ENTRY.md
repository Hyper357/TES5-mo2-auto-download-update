# Task Entry — current low-context operating mode

Use this file after root `AGENTS.md`. Do not preload historical reports or large runtime JSON into model context.

## First takeover command

From a clean `main` checkout:

```bash
node scripts/agent-bootstrap.js
```

This synchronizes to `origin/main` with fast-forward-only semantics, checks dependencies/syntax, and prints compact live state. It refuses dirty/non-main worktrees rather than resetting them.

After bootstrap, the normal compact state command is:

```bash
npm run agent:brief
```

For one MOD:

```bash
npm run agent:mod -- <modId>
```

## Task types

### RUN — real update already authorized

```bash
npm run agent:brief
npm run update
npm run agent:brief
```

Report results and stop. Do not run the full regression suite when code did not change.

### AUDIT — explicit no-download inspection

```bash
npm run agent:brief
npm run audit
npm run agent:brief
```

### REVIEW — resolve held/ambiguous exact targets

```bash
npm run review
```

The current HTML shows live exact progress/failures and final disk-persisted failure evidence.

### FIX — code defect

1. identify exact error/status and implicated module;
2. inspect only relevant code/evidence;
3. run targeted tests while editing;
4. run full `npm test` once before PR/merge;
5. preserve safety gates unless new evidence proves the gate itself is wrong.

### INVESTIGATE — read-only

Use compact commands and bounded evidence. Do not mutate runtime or run the full suite unless reproduction truly requires it.

## Cache policy

Normal runs are cache-first:

```bash
npm run update
npm run audit
```

Hard refresh is deliberate:

```bash
npm run update:fresh
npm run audit:fresh
```

Use `*:fresh` only when stale cache is suspected or explicitly requested.

## Failure evidence order

For Review Center download problems, prefer:

```text
HTML live log panel
review-jobs/<job>/review-failures.json
review-jobs/<job>/review-failures.log
review-jobs/<job>/execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

Use exact `tx + modId:fileId`. Never blindly rerun a whole batch because one target failed.

## Hard limits

- Never print full `plan.json`, `review-center.json`, ledger, or large JSONL logs into chat.
- Same probe/command maximum twice. Same result twice = conclude and move on.
- One missing path = resolve latest runtime path once; do not loop over guesses.
- Debug is opt-in and targeted.
- One task = one objective.
- Bulky evidence stays under `.runtime/`; report counts, exact IDs, error codes, and artifact paths.
- Never `git reset --hard`, delete `.runtime`, or clear ledgers to make a run pass.
