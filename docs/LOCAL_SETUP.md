# Local Setup Contract

GitHub stores code and policy. The Windows machine stores runtime state and secrets. A new AI agent must understand this boundary before running network or MO2 actions.

## Required local software

- Windows with the user's Skyrim SE/AE + Mod Organizer 2 installation.
- Git available on PATH.
- Node.js / npm compatible with CI (CI currently uses Node 22.14.0).
- 7-Zip available at the configured path or the default Windows location.
- Project-managed Chromium/Chrome profile created by `npm run browser:start` when network automation is needed.

## Expected project-local/runtime state

The repository intentionally ignores `.runtime/`. Typical runtime content includes:

```text
.runtime/
  browser/
  state/
    browser-port.json
    submission-ledger.json
    variant-policies.json
  runs/<timestamp>/
```

A fresh clone therefore may contain no `.runtime`. `START_REVIEW.cmd` and runtime helpers can recover a recent Review Center run from a sibling repository copy in the same Skyrim workspace. Do not copy secrets into GitHub to make a clone self-contained.

## Nexus API key

The normal local key file is external to the repository, commonly:

```text
E:\SkyrimAE\tools\.nexus_api_key
```

Environment variable `NEXUS_API_KEY` may take precedence where supported. Never paste the key into issues, commits, logs, chat transcripts, or test fixtures.

## MO2 paths

The current code can carry paths through generated `review-center-config.json` and workflow arguments. Typical local locations include:

```text
E:\SkyrimAE\mo2\mods
E:\SkyrimAE\mo2\downloads
```

Do not hard-code a new path merely because the examples above exist. Use existing runtime/config evidence when present.

## Active profile

Profile evidence priority is:

1. explicit `MO2_PROFILE_DIR` / CLI profile-dir;
2. explicit `MO2_PROFILE_NAME` / CLI profile-name;
3. selected profile in `ModOrganizer.ini`;
4. unique sole profile.

If multiple profiles remain unresolved, keep `PROFILE_UNRESOLVED`. Never infer compatibility from absent/disabled mods in that state.

## Managed browser

Use only the project-managed automation browser:

```bash
npm run browser:start
npm run browser:status
```

Do not attach CDP to the user's normal browser profile. Browser/profile mismatch is a hard gate.

## First local takeover

From a clean `main` checkout:

```bash
node scripts/agent-bootstrap.js
```

Then choose exactly one task path from `docs/TASK_ENTRY.md`.

## Windows one-click entry points

For the user, not for an AI shell:

```text
START_AGENT.cmd   sync/check/show compact agent state
START_REVIEW.cmd  sync/open the latest recoverable Review Center
```

Both are designed to fail safely rather than reset local work.
