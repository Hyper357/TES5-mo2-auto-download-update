# Task Entry — Low-Token Mode

Use this file as the default task entry point. Do **not** preload full historical reports into agent context.

## First command

```bash
npm run agent:brief
```

If one MOD needs inspection:

```bash
npm run agent:mod -- <modId>
```

Only read `docs/AGENT_HANDOFF.md` when changing architecture/safety rules. Only read `docs/CURRENT_STATE.md` when a task explicitly needs historical handoff context.

## Task types

- **RUN**: `git status` → `npm run agent:brief` → `npm run update` → `npm run agent:brief` → report → stop. Do not run `npm test` when code did not change.
- **FIX**: inspect only files implicated by the defect; run targeted tests while editing; run full `npm test` once before PR/merge.
- **INVESTIGATE**: read-only; use compact commands and bounded excerpts; do not mutate or run a full suite unless needed to reproduce the defect.

## Hard limits

- Never print full `plan.json`, `review-center.json`, ledger, or large JSONL logs into chat.
- Same probe/command maximum twice. Same result twice = conclude and move on.
- One missing path = resolve latest run/path once; never loop over guessed `reports/plan*.json` locations.
- Normal `npm run update` is non-debug. Add `-- --debug` only for a focused diagnosis.
- One Task = one objective. No spontaneous new Phase/audit/redesign.
- Put bulky evidence under `.runtime/`; final chat output should be counts, exact IDs, concise errors, and artifact paths.
