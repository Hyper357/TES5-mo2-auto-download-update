# Current State — repository baseline, not live runtime

This file intentionally does **not** hard-code a historical MO2 run as current truth.

## Repository baseline

Current package line:

```text
4.1.15-beta.1
```

Current `main` includes post-version reliability fixes for:

- stale Review Center frontend snapshots;
- saved selection migration / `undefined:undefined` cleanup;
- detailed Nexus API preflight errors;
- exact executor failure reporting;
- explicit Review Center exact downloads in multi-version local mod situations;
- persistent per-job failure artifacts;
- live per-MOD Review Center progress/failure display.

The exact Git commit changes whenever `main` advances. A new agent must obtain it from Git, not this file:

```bash
git rev-parse HEAD
```

## Live runtime truth

Live MO2/Nexus state exists only on the user's machine under local runtime/config sources. A fresh Git clone does not contain it.

The authoritative first live status surface is:

```bash
npm run agent:brief
```

For a first takeover from a clean `main` checkout:

```bash
node scripts/agent-bootstrap.js
```

Do **not** reuse old counts such as number of installed mods, review items, updates, VERIFIED files, or old failed mod IDs from historical commits as if they describe the current machine.

## Current operational architecture

```text
Update Eligibility
→ Main / Variant
→ Component Discovery / Closure
→ Preflight
→ exact automatic transaction OR exact Review Center selection
→ isolated-browser signed identity + Nexus download-link API
→ direct CDN download
→ archive integrity check
→ atomic MO2-downloads publish
→ exact disk verification
→ VERIFIED
```

Only `VERIFIED` is success.

## Review Center current evidence surfaces

During a running job, use the HTML live-log panel first.

After the job, prefer:

```text
review-jobs/<job>/review-failures.json
review-jobs/<job>/review-failures.log
review-jobs/<job>/execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

## Handoff rule

For a new AI agent, the correct reading order is:

```text
AGENTS.md
docs/AI_START_HERE.md
docs/TASK_ENTRY.md
```

Then run the compact status commands. Read architecture/debug/local-setup docs only if the active task requires them.
