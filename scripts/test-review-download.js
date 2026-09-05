'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateAndBuild, persistRememberedPolicies } = require('./review-download');
const { loadVariantPolicies, getVariantPolicy } = require('./lib/variant-policy');

const review = {
  items: [{
    id: 'mod:160675', modId: '160675', localFileId: '100', blockers: [],
    mainOptions: [
      { fileId: '100', name: 'Vanilla', version: '1.0', current: true, selectable: true, branchKey: 'VANILLA', tags: ['VANILLA'] },
      { fileId: '300', name: 'KS Hairdos HDT', version: '1.02.1', current: false, selectable: true, branchKey: 'HDT_SMP+KS_HAIRDOS', tags: ['HDT_SMP', 'KS_HAIRDOS'] },
    ],
    componentFamilies: [{
      key: 'HOTFIX:KS_HAIRDOS_HDT_HOTFIX', kind: 'HOTFIX', family: 'KS_HAIRDOS_HDT_HOTFIX',
      candidates: [{ kind: 'HOTFIX', modId: '160675', fileId: '301', name: 'HDT Hotfix', version: '1.02.1', selectable: true }],
    }],
    patchFamilies: [],
  }],
};

{
  const x = validateAndBuild(review, {
    'mod:160675': {
      mainFileId: '300',
      components: { 'HOTFIX:KS_HAIRDOS_HDT_HOTFIX': { decision: 'OBSOLETE', kind: 'HOTFIX', family: 'KS_HAIRDOS_HDT_HOTFIX' } },
    },
  });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(x.rows.length, 1);
  assert.strictEqual(x.rows[0].fileId, '300');
  assert.strictEqual(x.accepted[0].rememberMain, false);
}

{
  const x = validateAndBuild(review, {
    'mod:160675': {
      mainFileId: '300', rememberMain: true,
      components: { 'HOTFIX:KS_HAIRDOS_HDT_HOTFIX': { decision: 'DOWNLOAD', kind: 'HOTFIX', family: 'KS_HAIRDOS_HDT_HOTFIX', modId: '160675', fileId: '301' } },
    },
  });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(x.rows.length, 2);
  assert.match(x.rows[1].note, /closure:HOTFIX/);
  assert.strictEqual(x.accepted[0].rememberMain, true);
  assert.strictEqual(x.accepted[0].mainSelection.branchKey, 'HDT_SMP+KS_HAIRDOS');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tes5-review-policy-'));
  try {
    const policyFile = path.join(dir, 'variant-policies.json');
    const updates = persistRememberedPolicies(x, policyFile);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].saved, true);
    assert.strictEqual(getVariantPolicy(loadVariantPolicies(policyFile), '160675').branchKey, 'HDT_SMP+KS_HAIRDOS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const x = validateAndBuild(review, { 'mod:160675': { mainFileId: '999999', components: {} } });
  assert.ok(x.errors.some(e => e.code === 'REVIEW_SELECTION_INVALID'));
}

{
  const x = validateAndBuild(review, { 'mod:160675': { mainFileId: '300', components: {} } });
  assert.ok(x.errors.some(e => e.code === 'REVIEW_COMPONENT_DECISION_REQUIRED'));
}

// If Main was already high-confidence and only component closure held it, reviewed download must restore Main + selected components.
{
  const componentOnly = { items: [{
    id: 'mod:42', modId: '42', localFileId: '400', targetMainFileId: '500', targetMainVersion: '2.0', targetMainName: 'Example Main 2.0', blockers: [],
    mainOptions: [],
    componentFamilies: [
      { key: 'RESOURCE:CUSTOM:FRAMEWORK', kind: 'RESOURCE', family: 'CUSTOM:FRAMEWORK', candidates: [{ kind: 'RESOURCE', modId: '77', fileId: '701', version: '3.0', name: 'Required Framework', selectable: true }] },
      { key: 'BODYSLIDE:CUSTOM:CBBE', kind: 'BODYSLIDE', family: 'CUSTOM:CBBE', candidates: [{ kind: 'BODYSLIDE', modId: '42', fileId: '702', version: '2.0', name: 'CBBE BodySlide', selectable: true }] },
    ],
  }] };
  const x = validateAndBuild(componentOnly, { 'mod:42': { components: {
    'RESOURCE:CUSTOM:FRAMEWORK': { decision: 'DOWNLOAD', kind: 'RESOURCE', family: 'CUSTOM:FRAMEWORK', modId: '77', fileId: '701' },
    'BODYSLIDE:CUSTOM:CBBE': { decision: 'NOT_APPLICABLE', kind: 'BODYSLIDE', family: 'CUSTOM:CBBE' },
  } } });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(x.rows.length, 2);
  assert.strictEqual(x.rows[0].fileId, '500', 'held exact Main must be restored after component decisions');
  assert.match(x.rows[0].note, /planner-main-released-after-component-review/);
  assert.strictEqual(x.rows[1].fileId, '701');
  assert.match(x.rows[1].note, /closure:RESOURCE/);
  assert.strictEqual(x.accepted[0].automaticMain, true);
}

// Legacy patch-only review payload remains supported.
{
  const legacy = { items: [{
    id:'mod:9',modId:'9',localFileId:'8',targetMainFileId:'10',targetMainVersion:'2',targetMainName:'Legacy Main',blockers:[],mainOptions:[],
    patchFamilies:[{family:'USSEP',candidates:[{modId:'99',fileId:'100',name:'Patch',version:'1',selectable:true}]}],
  }]};
  const x=validateAndBuild(legacy,{'mod:9':{patches:{USSEP:{decision:'DOWNLOAD',modId:'99',fileId:'100'}}}});
  assert.deepStrictEqual(x.errors,[]);
  assert.strictEqual(x.rows.length,2);
  assert.match(x.rows[1].note,/closure:PATCH/);
}

// Update eligibility is upstream of Component Closure. A review click must never generate a direct Main download.
{
  const eligibilityHold = { items: [{
    id:'mod:88',modId:'88',action:'HOLD_UPDATE_ELIGIBILITY',localFileId:'800',blockers:[],
    updateEligibility:{status:'HOLD_UPDATE_ELIGIBILITY',reason:'SAME_VERSION_NEWER_FILE_REPLACEMENT'},
    mainOptions:[{modId:'88',fileId:'801',name:'Replacement Main',version:'1.0',current:false,selectable:true,recommended:true}],
    componentFamilies:[],patchFamilies:[],
  }]};
  const x=validateAndBuild(eligibilityHold,{'mod:88':{mainFileId:'801'}});
  assert.strictEqual(x.rows.length,0);
  assert.ok(x.errors.some(e=>e.code==='REVIEW_UPDATE_ELIGIBILITY_REAUDIT_REQUIRED'));
}

console.log('review download tests: OK');
