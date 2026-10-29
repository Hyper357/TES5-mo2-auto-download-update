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
function summarizeCoverageDegradation({
  browserUnavailable = false,
  browserErrored = 0,
  browserTargets = 0,
  targets = 0,
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
  return { degraded: false, kind: '', affected: 0 };
}

module.exports = { summarizeCoverageDegradation };
