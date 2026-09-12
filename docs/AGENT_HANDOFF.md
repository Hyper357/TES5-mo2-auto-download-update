# Agent Handoff Protocol & Architecture Standards

## 1. Core Mission & Scope
This repository (`skyrim-mo2-safe-update`) provides deterministic, safe, automated Nexus download orchestration and update eligibility analysis for Skyrim Special Edition / Anniversary Edition (AE 1.6.1170) managed via Mod Organizer 2 (MO2).

**Non-Negotiable Scope Boundary:**
- No mod scanning, network crawling, download dispatching, file extraction, or metadata writes may occur unless explicitly requested by the user.
- Any inspection, diagnostics, or status reporting tasks must remain strictly non-mutating and read-only.

---

## 2. Architecture & Pipeline Overview

```
[MO2 Environment & Profiles]
           │
           ▼
[Eligibility & Relevance Gate] ─── (Rejects metadata false-positives & irrelevant variants)
           │
     ┌─────┴──────────────────┐
     ▼                        ▼
[Confirmed Updates]    [Review / Hold Queue] ─── (Review Center HTML / Policy Memory)
     │
     ▼
[Submission Ledger] ─── (Deduplication, idempotency tx key `modId:fileId`)
     │
     ▼
[Automated Nexus Pipeline] ─── (CDP session / Slow-download 5s wait / nxmhandler)
     │
     ▼
[MO2 Downloads Directory] ─── (Physical verification via 7z t test)
```

### Core Subsystems
1. **MO2 Environment Graph (`lib/mo2-environment.js`)**:
   - Resolves active profiles, modlist priority, enabled/disabled state, and plugin ownership.
   - Treats UI warning flags with strict skepticism (e.g., MO2 red exclamation mark is often metadata formatting drift, not an actionable update).
2. **Update Eligibility & Relevance Gate (`lib/update-eligibility-gate.js`, `lib/component-relevance-gate.js`)**:
   - Differentiates true updates (lightning bolt ⚡) from versioning artifacts.
   - Enforces runtime compatibility targeting AE 1.6.1170 (rejects incompatible 1.5.97 / VR builds).
   - Gates components and optional patches against actual enabled profile plugins.
3. **Review Center & Variant Memory (`lib/review-center.js`, `lib/variant-memory.js`)**:
   - Surfaces ambiguous variant choices, optional components, and patch dependencies for explicit resolution.
   - Persists choices in `.runtime/state/variant-policies.json` to prevent re-prompting.
4. **Idempotent Submission Ledger (`lib/submission-ledger.js`)**:
   - Prevents duplicate downloads using transaction keys `modId:fileId`.
   - Records state transitions: `SEEN` -> `ATTEMPTING` -> `SUBMITTED` -> `VERIFIED` / `FAILED`.
5. **Browser Lifecycle & CDP Engine (`lib/browser-manager.js`, `lib/nxm-submitter.js`)**:
   - Connects to isolated Chrome/Edge instance via Chrome DevTools Protocol (CDP, port 9222).
   - Safely triggers 5-second slow-download countdown and dispatches signed NXM URIs to `nxmhandler.exe`.

---

## 3. Safety Rules (Ironclad Invariants)

1. **Zero Direct Binary Edits**:
   - Never directly modify `.esp`, `.esm`, `.esl`, `.bsa`, or `.ba2` binaries.
   - Changes must go through structured tooling (Spriggit YAML, xelib, or houseCARL).
2. **Pre-Modification Backups**:
   - Before modifying any INI, load order (`plugins.txt`, `loadorder.txt`), or config, create a snapshot backup.
3. **Read-Only Inspection by Default**:
   - Status checks, task handoffs, and verification queries must never trigger mutations on MO2 state or download queues.
4. **No Full In-Memory Logging or Context Flooding**:
   - Never dump multi-megabyte logs or stdout directly into agent context or unbuffered tools.
   - Utilize bounded readers, targeted slices, and structured diagnostics (`failed-items.json`, `agent-status.json`).
5. **Strict Circuit Breaker on 403 / Auth Errors**:
   - On encountering Nexus HTTP 403 Forbidden or session token expiration, immediately halt execution. Do not retry in tight loops.
6. **Physical Archive Integrity Check**:
   - A download is only marked `VERIFIED` after passing archive integrity verification (`7z t` exit code 0).

---

## 4. Known Failure Modes & Mitigations

| Failure Mode | Symptoms | Root Cause | Standard Mitigation |
| :--- | :--- | :--- | :--- |
| **Capture Buffer Overflow** | Node child process `ENOBUFS` during full runs | Unbounded stdout collection exceeding default buffer limit | Fixed in v4.1.15 by raising shared capture buffer to 16 MiB; run diagnostics with bounded filters. |
| **Metadata False Positives** | MO2 red warning ⚠️, author tag mismatch (e.g. `v1.0` vs `1.0.0`) | MO2 compares disparate version strings or unaligned sub-files | Filtered via `SKIP_METADATA_FALSE_POSITIVE`; rely on `UPDATE_CONFIRMED` only. |
| **Inapplicable Patches** | FOMOD patch download requested for inactive plugins | Missing dependency gating against profile plugins | Gated via `lib/component-relevance-gate.js`; held under `HOLD_UPDATE_ELIGIBILITY`. |
| **Browser CDP Hang** | Automation stalls waiting for CDP response | Orphaned browser tabs or lost DevTools connection | Check browser state with `npm run browser:status`; restart via `npm run browser:start`. |
| **Duplicate NXM Submissions** | MO2 queue congestion, duplicate archive downloads | Submission ledger missed or bypassed | Check `submission-ledger.json` before submission; enforce transaction key checks. |

---

## 5. Standard Agent Operational Commands

```bash
# Compact entry point for normal tasks. Use this FIRST.
npm run agent:brief

# Query one MOD without loading plan.json into context.
npm run agent:mod -- 73381

# Detailed status only when the brief identifies a real operational failure.
npm run agent:status -- --compact

# Run unit & integration test suite (FIX tasks only; do not run on every normal RUN task)
npm test

# Inspect update eligibility & review holds when specifically required
npm run updates:status

# Open Review Center for human file selection
npm run review

# Managed browser lifecycle
npm run browser:status
npm run browser:start
npm run browser:stop
```

---

## 6. Agent Token Budget Protocol

The repository, not the chat transcript, is the source of operational state. Normal tasks must minimize model context and shell output.

1. **Status-first, bounded by default**
   - Start every RUN/INVESTIGATE task with `npm run agent:brief`.
   - Do not open or print full `plan.json`, `review-center.json`, execution ledgers, or JSONL logs unless a specific field is unavailable from the compact tools.
   - For one MOD, use `npm run agent:mod -- <modId>` instead of ad-hoc Python/PowerShell JSON parsing.
2. **Debug is opt-in**
   - `npm run update` runs without `--debug` by default.
   - Use `npm run update -- --debug` only in a focused FIX/INVESTIGATE task for a confirmed bug.
3. **No repeated probes**
   - The same command or factual question may be probed at most twice.
   - If two probes return the same result, record the conclusion and return to the stated task objective.
4. **Missing paths are resolved once**
   - After one `FileNotFoundError`, stop guessing historical report paths. Use the latest run directory and repository runtime helpers/compact commands.
   - Never retry the same nonexistent `reports/plan*.json` path in a loop.
5. **Tests are proportional to task type**
   - RUN: do not run the full regression suite unless code changed.
   - FIX: run targeted tests while editing, then run the full suite once before merge/PR.
   - INVESTIGATE: read-only; no full test run unless required to reproduce the reported defect.
6. **Task termination rule**
   - A task performs one objective: inspect → execute/fix → verify → report → stop.
   - Do not start a new audit, phase, redesign, or side investigation after the objective is satisfied.
7. **Output budget**
   - Normal task summaries should stay under ~100 lines.
   - Large machine artifacts remain under `.runtime/`; report counts, exact IDs, and paths rather than pasting whole files.
