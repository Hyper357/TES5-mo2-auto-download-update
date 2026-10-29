'use strict';

const assert = require('assert');
const { inferFamily, mergeCandidates, installedContext, assessDiscovery, normalizeFamilyKey } = require('./lib/patch-discovery');
const { summarizeCoverageDegradation } = require('./lib/coverage-degradation');

assert.strictEqual(inferFamily('Example Mod - USSEP Compatibility Patch','Example Mod'),'USSEP');
assert.strictEqual(inferFamily('Example Mod - Lux Orbis Patch','Example Mod'),'LUX_ORBIS');
assert.strictEqual(inferFamily('USSEP - Lux compatibility patch','Unofficial Skyrim Special Edition Patch - USSEP'),'LUX','main mod family must not be mistaken for counterpart');
assert.strictEqual(normalizeFamilyKey('Lux Orbis'),'LUX_ORBIS');

const merged=mergeCandidates([
  {source:'REQUIREMENTS_REVERSE',auxModId:'900',name:'Example - USSEP Patch',mainName:'Example'},
  {source:'DESCRIPTION_LINK',auxModId:'900',name:'Example USSEP compatibility',mainName:'Example'},
  {source:'SAME_PAGE_FILE',fileId:'901',name:'Example - Lux Patch',mainName:'Example'},
]);
assert.strictEqual(merged.length,2,'same independent page should merge across sources');
assert(merged.find(x=>x.auxModId==='900').sources.length>=2);
const ussep=merged.find(x=>x.auxModId==='900');
const ctx=installedContext(ussep,['Unofficial Skyrim Special Edition Patch - USSEP','SkyUI']);
assert.strictEqual(ctx.installedContextMatch,true);
const coverage={samePageFiles:{required:true,complete:true,status:'COMPLETE'},requirementsReverse:{required:true,complete:true,status:'COMPLETE'},description:{required:true,complete:true,status:'COMPLETE'}};
const rules=[{kind:'PATCH',family:'USSEP',status:'REQUIRED',auxModId:'900',auxFileId:'999'}];
const one=assessDiscovery({candidates:[ussep],patchRules:rules,coverage});
assert.strictEqual(one.complete,true);assert.strictEqual(one.unresolved.length,0);
const unresolved=assessDiscovery({candidates:[ussep],patchRules:[],coverage});
assert.strictEqual(unresolved.complete,false);assert.strictEqual(unresolved.unresolved.length,1);
const badCoverage=assessDiscovery({candidates:[],patchRules:[],coverage:{requirementsReverse:{required:true,complete:false,status:'SECTION_NOT_PROVEN'}}});
assert.strictEqual(badCoverage.complete,false);assert.strictEqual(badCoverage.coverageProblems.length,1);

// --- Degraded-coverage policy -------------------------------------------------
// Two browser failures both silence coverage, and the first fix only handled the
// first, so a run with 6/14 targets unscraped still exited 0 (2026-10-29). Both
// kinds must mark the run degraded, and a healthy run must not.
{
  // 1. Browser never reached: 2026-10-18, 17/17 targets, reported as clean.
  const lost=summarizeCoverageDegradation({browserUnavailable:true,browserTargets:17,targets:17});
  assert.strictEqual(lost.degraded,true);
  assert.strictEqual(lost.kind,'BROWSER_UNAVAILABLE');
  assert.strictEqual(lost.affected,17);

  // 2. Browser reached but page loads threw: 2026-10-29, 6/14 targets.
  const scraped=summarizeCoverageDegradation({browserUnavailable:false,browserErrored:6,targets:14});
  assert.strictEqual(scraped.degraded,true,'partial page-scrape failure must not look clean');
  assert.strictEqual(scraped.kind,'PAGE_SCRAPE_FAILED');
  assert.strictEqual(scraped.affected,6);

  // 3. A single failed page is still a failed page.
  assert.strictEqual(summarizeCoverageDegradation({browserErrored:1,targets:3}).degraded,true);

  // 4. Healthy run stays healthy.
  const ok=summarizeCoverageDegradation({browserUnavailable:false,browserErrored:0,targets:14});
  assert.strictEqual(ok.degraded,false);
  assert.strictEqual(ok.affected,0);

  // 5. Older callers that do not pass the new fields must not be flagged.
  assert.strictEqual(summarizeCoverageDegradation({}).degraded,false);
}

console.log('patch discovery tests: OK');
