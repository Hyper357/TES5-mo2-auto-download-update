'use strict';

const assert = require('assert');
const { assessUpdateEligibility, mo2UpdateHint, UPDATE_STATES } = require('./lib/update-eligibility');

function f(id, version, uploaded, name='Example Main', category='MAIN') {
  return {
    file_id: String(id),
    version,
    uploaded_time: uploaded,
    name,
    file_name: `${name}-${version}-${id}.7z`,
    category_name: category,
    category_id: category === 'MAIN' ? 1 : 2,
    is_primary: category === 'MAIN',
  };
}

const mine = f(100, '1.0', '2026-01-01T00:00:00Z');
const newer = f(200, '1.1', '2026-02-01T00:00:00Z');

// Yellow-arrow-like metadata + exact newer file => confirmed update.
{
  const x = assessUpdateEligibility({ files:[mine,newer], mine, localName:'Example Main', meta:{installedVersion:'1.0', newestVersion:'1.1'} });
  assert.strictEqual(x.state, UPDATE_STATES.UPDATE);
  assert.strictEqual(x.eligible, true);
  assert.strictEqual(x.mo2Hint.wouldShowUpdateArrow, true);
  assert.strictEqual(x.mo2Agreement, 'AGREES');
  assert.strictEqual(x.newerCandidates[0].fileId, '200');
}

// No yellow arrow, but exact same-lane file chronology proves a real update.
{
  const x = assessUpdateEligibility({ files:[mine,newer], mine, localName:'Example Main', meta:{installedVersion:'1.0', newestVersion:'1.0'} });
  assert.strictEqual(x.state, UPDATE_STATES.UPDATE);
  assert.strictEqual(x.mo2Hint.wouldShowUpdateArrow, false);
  assert.strictEqual(x.mo2Agreement, 'MO2_MISSED_EXACT_UPDATE');
}

// Author/MO2 version metadata says newer, but exact installed lane has no newer file => false positive, never download.
{
  const x = assessUpdateEligibility({ files:[mine], mine, localName:'Example Main', meta:{installedVersion:'1.0', newestVersion:'9.9'} });
  assert.strictEqual(x.state, UPDATE_STATES.FALSE_POSITIVE);
  assert.strictEqual(x.eligible, false);
}

// User ignored the newest version in MO2 => report but respect the ignore; no automatic update.
{
  const x = assessUpdateEligibility({ files:[mine,newer], mine, localName:'Example Main', meta:{installedVersion:'1.0', newestVersion:'1.1', ignoredVersion:'1.1'} });
  assert.strictEqual(x.state, UPDATE_STATES.IGNORED);
  assert.strictEqual(x.eligible, false);
  assert.strictEqual(x.mo2Hint.ignoredMatches, true);
}

// Current exact file => current even without relying on MO2 metadata.
{
  const x = assessUpdateEligibility({ files:[mine], mine, localName:'Example Main', meta:{installedVersion:'1.0', newestVersion:'1.0'} });
  assert.strictEqual(x.state, UPDATE_STATES.CURRENT);
}

// Generic multi-Main pages with no strong lexical lane must HOLD rather than guessing another branch.
{
  const current = f(300, '1.0', '2026-01-01T00:00:00Z', 'Vanilla Pack');
  const other = f(400, '2.0', '2026-03-01T00:00:00Z', 'Completely Different HDT Variant');
  const x = assessUpdateEligibility({ files:[current,other], mine:current, localName:'Vanilla Pack', meta:{installedVersion:'1.0', newestVersion:'2.0'} });
  assert.ok([UPDATE_STATES.UNCERTAIN, UPDATE_STATES.FALSE_POSITIVE].includes(x.state));
  assert.strictEqual(x.eligible, false);
}

// The MO2 hint is metadata evidence only and never a download authorization.
{
  const h = mo2UpdateHint({ installedVersion:'1.0', newestVersion:'2.0' });
  assert.strictEqual(h.wouldShowUpdateArrow, true);
  assert.strictEqual(h.metadataOnly, true);
}

console.log('update eligibility tests: OK');
