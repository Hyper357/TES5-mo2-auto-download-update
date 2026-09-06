'use strict';

const assert = require('assert');
const {
  installationFileMatchesTarget,
  localTargetVersionConflict,
  assessUpdateEligibility,
} = require('./lib/update-eligibility');

const target = {
  file_id: 800720,
  file_name: 'Papyrus Extender 22854 6.5.2 2026-09-05T12-53Z Sx9oEwOl7.7z',
  name: 'Papyrus Extender',
  version: '6.5.2',
  category_id: 1,
  category_name: 'MAIN FILES',
  uploaded_time: '2026-09-05T12:53:00.000Z',
};
const old = {
  file_id: 795000,
  file_name: 'Papyrus Extender 22854 6.5.1.7z',
  name: 'Papyrus Extender',
  version: '6.5.1',
  category_id: 1,
  category_name: 'MAIN FILES',
  uploaded_time: '2026-08-20T00:00:00.000Z',
};

assert.strictEqual(installationFileMatchesTarget(
  'Papyrus Extender 22854 6.5.2 2026-09-05T12-53Z Sx9oEwOl7.7z', target), true);
assert.strictEqual(installationFileMatchesTarget('some-other-archive.7z', target), false);

const drift = localTargetVersionConflict({
  installedVersion: '6.5.2.0',
  instFile: target.file_name,
}, old, target);
assert.strictEqual(drift.reason, 'HIGH_CONFIDENCE_METADATA_DRIFT_UP_TO_DATE');
assert.strictEqual(drift.metadataDrift, true);

const uncertain = localTargetVersionConflict({
  installedVersion: '6.5.2.0',
  instFile: 'Papyrus Extender custom repack.7z',
}, old, target);
assert.strictEqual(uncertain.reason, 'LOCAL_VERSION_MATCHES_TARGET_FILE_ID_CONFLICT');

const eligibility = assessUpdateEligibility({
  files: [old, target],
  fileUpdates: [{ old_file_id: 795000, new_file_id: 800720 }],
  mine: old,
  meta: {
    installedVersion: '6.5.2.0',
    instFile: target.file_name,
    newestVersion: '6.5.2',
    nexusFileStatus: 1,
  },
  localName: 'powerofthree Papyrus Extender',
  installationFile: target.file_name,
  profile: null,
});
assert.strictEqual(eligibility.status, 'SKIP_UP_TO_DATE');
assert.strictEqual(eligibility.reason, 'HIGH_CONFIDENCE_METADATA_DRIFT_UP_TO_DATE');
assert.strictEqual(eligibility.updateNeeded, false);
assert.ok(eligibility.evidence.includes('INSTALLATION_FILE_MATCHES_EXACT_TARGET'));

console.log('metadata drift tests: OK');
