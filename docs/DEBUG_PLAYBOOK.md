# Debug Playbook — exact evidence first

Use this only after `npm run agent:brief` or Review Center exposes a concrete error/status. Diagnose one exact target at a time. Never weaken a safety gate just to make a batch pass.

| Error / symptom | Meaning | First evidence | Normal response |
|---|---|---|---|
| `REVIEW_SELECTION_INVALID` / `undefined:undefined` | stale/invalid saved selection | Review state + current allow-list | current UI should migrate/drop it; do not weaken server allow-list |
| `NEXUS_API` 401/403 | key exists but is rejected/forbidden | preflight detail | fix credentials/policy; never paste key into chat |
| `NEXUS_API` 429 | Nexus rate limit | preflight detail / response metadata | wait/back off; do not bypass API validation |
| `NEXUS_API` timeout / DNS / 5xx | transient network/service failure | exact network error | retry conservatively; do not rotate a valid key without evidence |
| `LOCAL_MULTI_VERSION_IDENTITY` | several local folders from one Nexus mod page disagree | `localExecutionGuard` | automatic Main replacement stays HOLD; explicit Review exact picks use the scoped review executor |
| `DIRECT_EXACT_FILE_NOT_FOUND` | requested fileId absent from Files API | exact `modId:fileId` | re-audit; do not substitute newest/largest fileId |
| `DIRECT_TARGET_ARCHIVED` | exact target is archived | Files API metadata | require a new evidence-backed target |
| `NXM_DOWNLOAD_CONTROL_MISSING` | Nexus page did not expose expected control | browser/session evidence | inspect managed browser/login/page state |
| `NXM_EXTRACT_FAILED` | control clicked but signed exact URL not captured | browser/network evidence | inspect one target; retry boundedly |
| `NEXUS_DOWNLOAD_LINK_*` | download-link API failure | exact error/status | classify auth/rate/server/network before retry |
| `CDN_*` | direct CDN transfer failure | attempt error + disk state | retry exact target only; respect in-flight record |
| `ARCHIVE_TEST_FAILED` | payload failed 7-Zip integrity test | archive test result | keep NOT VERIFIED; do not publish as success |
| `VERIFY_FAILED` | final exact disk verification failed | `verify` object | inspect published archive/meta identity |
| `HOLD_EXISTING_INFLIGHT` | unfinished exact archive already exists | download guard | do not duplicate submission; resolve/wait for inflight |
| `CONCURRENT_EXECUTOR` | another executor owns the lock | executor lock owner | do not start a second executor |
| `PROFILE_UNRESOLVED` | active MO2 profile cannot be proven | environment status | resolve profile before absence-based compatibility inference |

## Review Center live evidence

While a job runs, the HTML live-log panel is the preferred surface. It shows safe fields only:

```text
planned / verified / pending / active
exact modId:fileId
name
status
errorCode
attempt count / last failure
local identity reason
verify status
```

It intentionally does not expose API keys, signed NXM URLs, cookies, or Authorization.

## Persistent evidence after a job

Prefer these in order:

```text
review-jobs/<job>/review-failures.json
review-jobs/<job>/review-failures.log
review-jobs/<job>/execution-state.json
review-failure-history.jsonl
logs/errors.jsonl
```

The JSON failure report is best for an AI agent; the `.log` is best for a user screenshot/copy.

## Retry discipline

- Do not rerun VERIFIED items.
- Retry exact `tx + modId:fileId`, not the whole library.
- The same probe/command maximum twice. Same result twice means stop probing and conclude.
- Never use `git reset --hard`, delete `.runtime`, clear the submission ledger, or delete `.unfinished` merely to silence an error.
- Never transform a HOLD into DOWNLOAD without new evidence.
