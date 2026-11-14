'use strict';

// Decide whether a component-discovery run produced trustworthy coverage.
//
// Two different browser failures both degrade coverage silently, and both used to
// look like a clean audit:
//
//   1. BROWSER_UNAVAILABLE - the managed browser could not be reached at all, so
//      every target got BROWSER_UNAVAILABLE. (2026-10-18: 17/17 targets, 0 auto
//      items reported, errors.jsonl empty, exit 0.)
//   2. PAGE_SCRAPE_FAILED  - the browser was reached but individual page loads
//      threw, so browserDiscover stamped requirementsForward/Reverse/description
//      as BROWSER_ERROR. (2026-10-29: 6/14 targets; five net::ERR_CONNECTION_CLOSED
//      plus one 45s navigation timeout, exit 0.)
//
// Case 2 was missed by the first fix because it only checked case 1. Kept as a
// pure function so the policy is unit-testable without a real browser.
// Case 3 (2026-11-14): the Nexus API itself rate-limited us -- HTTP 429 with
// Cloudflare "error code: 1015" -- so ~1/3 of the library was never analysed.
// Those rows land in HOLD_API_ERROR, the up-to-date count silently collapses
// and the remaining auto list still looks confident. An API error is the same
// class of silent failure as a browser one: the verdict must be marked
// untrustworthy instead of being reported as clean.
function summarizeCoverageDegradation({
  browserUnavailable = false,
  browserErrored = 0,
  browserTargets = 0,
  targets = 0,
  apiErrors = 0,
  totalRows = 0,
} = {}) {
  if (browserUnavailable) {
    return {
      degraded: true,
      kind: 'BROWSER_UNAVAILABLE',
      affected: Number(browserTargets) || Number(targets) || 0,
    };
  }
  const errored = Number(browserErrored) || 0;
  if (errored > 0) {
    return { degraded: true, kind: 'PAGE_SCRAPE_FAILED', affected: errored };
  }
  const api = Number(apiErrors) || 0;
  const rows = Number(totalRows) || 0;
  if (api > 0 && (api >= 50 || (rows > 0 && api / rows > 0.05))) {
    return { degraded: true, kind: 'API_RATE_LIMITED', affected: api };
  }
  return { degraded: false, kind: '', affected: 0 };
}

module.exports = { summarizeCoverageDegradation };
