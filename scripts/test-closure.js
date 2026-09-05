'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const script = path.join(__dirname,'closure-gate.js');
const today = new Date().toISOString().slice(0,10);

function runCase({registry,plan,discovery,audit={rules:{}}}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'closure-test-'));
  const manifest=path.join(dir,'manifest.tsv'); const registryFile=path.join(dir,'registry.tsv');
  const planFile=path.join(dir,'plan.json'); const discoveryFile=path.join(dir,'discovery.json');
  const auditFile=path.join(dir,'audit.json'); const outFile=path.join(dir,'out.tsv'); const reportFile=path.join(dir,'report.json');
  fs.writeFileSync(manifest,'123\tExample Main\t2.0\tdecision=DOWNLOAD\t456\tDOWNLOAD\n');
  fs.writeFileSync(registryFile,registry); fs.writeFileSync(planFile,JSON.stringify(plan)); fs.writeFileSync(discoveryFile,JSON.stringify(discovery)); fs.writeFileSync(auditFile,JSON.stringify(audit));
  const r=cp.spawnSync(process.execPath,[script,manifest,registryFile,'--plan',planFile,'--component-discovery',discoveryFile,'--registry-audit',auditFile,'--out',outFile,'--report',reportFile],{encoding:'utf8'});
  assert.strictEqual(r.status,0,r.stderr);
  const result={out:fs.readFileSync(outFile,'utf8'),report:JSON.parse(fs.readFileSync(reportFile,'utf8'))};
  fs.rmSync(dir,{recursive:true,force:true});
  return result;
}
const plan={items:[{modId:'123',latestFileId:'456',action:'DOWNLOAD',aux:{patches:[],translations:[],components:[]}}]};

// Requirements coverage cannot be proven -> MAIN must not download.
{
  const registry=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tchecked\tnone\n`;
  const discovery={items:[{modId:'123',mainFileId:'456',complete:false,candidateCount:0,unresolved:[],coverageProblems:[{source:'requirementsForward',status:'SECTION_NOT_PROVEN'}]}]};
  const x=runCase({registry,plan,discovery});
  assert.match(x.out,/HOLD_COMPONENT_DISCOVERY/);
}

// A discovered family cannot be bypassed with blanket PATCH NONE.
{
  const registry=[
    `123\t456\t2.0\tPATCH\tNONE\t\t\t\t\t${today}\tFiles checked\tclaimed none`,
    `123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone`,
  ].join('\n');
  const discovery={items:[{modId:'123',mainFileId:'456',complete:false,candidateCount:1,candidateCountsByKind:{PATCH:1},unresolved:[{kind:'PATCH',key:'mod:999',family:'USSEP',name:'USSEP Patch'}],coverageProblems:[]}]};
  const x=runCase({registry,plan,discovery});
  assert.match(x.out,/HOLD_COMPONENT_DISCOVERY/);
}

// Complete discovery with zero patch/component candidates proves component closure; translation conclusion is still explicit.
{
  const registry=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone\n`;
  const discovery={items:[{modId:'123',mainFileId:'456',complete:true,candidateCount:0,candidateCountsByKind:{},unresolved:[],coverageProblems:[]}]};
  const x=runCase({registry,plan,discovery});
  assert.match(x.out,/\tDOWNLOAD$/m);
}

// Resolved REQUIRED patch family is appended exactly after audit pass.
{
  const patchLine=`123\t456\t2.0\tPATCH\tUSSEP\tREQUIRED\t999\t1001\t1.2\tExample USSEP Patch\t${today}\tRequirements reverse + Files\trequired`;
  const transLine=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone`;
  const patchRuleId='123:456:2.0:PATCH:USSEP:REQUIRED:999:1001:0';
  const discovery={items:[{modId:'123',mainFileId:'456',complete:true,candidateCount:1,candidateCountsByKind:{PATCH:1},unresolved:[],coverageProblems:[],candidates:[{kind:'PATCH',key:'mod:999',family:'USSEP',decision:{resolved:true,status:'REQUIRED'}}]}]};
  const audit={rules:{[patchRuleId]:{status:'PASS'}}};
  const x=runCase({registry:`${patchLine}\n${transLine}\n`,plan,discovery,audit});
  const lines=x.out.trim().split(/\r?\n/);
  assert.strictEqual(lines.length,2);
  assert.match(lines[0],/\tDOWNLOAD$/);
  assert.match(lines[1],/^999\tExample USSEP Patch\t1\.2\t/);
  assert.match(lines[1],/\t1001\tDOWNLOAD$/);
}

// REQUIRED Resource and Physics component families are appended and remain exact-audited.
{
  const resourceLine=`123\t456\t2.0\tRESOURCE\tCUSTOM:FRAMEWORK\tREQUIRED\t700\t701\t3.0\tRequired Framework\t${today}\tForward Nexus Requirements\trequired`;
  const physicsLine=`123\t456\t2.0\tPHYSICS\tCUSTOM:HDT_SMP\tREQUIRED\t123\t702\t2.0\tHDT-SMP Physics Files\t${today}\tSame-page component\trequired`;
  const transLine=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone`;
  const resourceId='123:456:2.0:RESOURCE:CUSTOM:FRAMEWORK:REQUIRED:700:701:0';
  const physicsId='123:456:2.0:PHYSICS:CUSTOM:HDT_SMP:REQUIRED:123:702:1';
  const discovery={items:[{
    modId:'123',mainFileId:'456',complete:true,candidateCount:2,candidateCountsByKind:{RESOURCE:1,PHYSICS:1},unresolved:[],coverageProblems:[],
    candidates:[
      {kind:'RESOURCE',family:'CUSTOM:FRAMEWORK',decision:{resolved:true,status:'REQUIRED'}},
      {kind:'PHYSICS',family:'CUSTOM:HDT_SMP',decision:{resolved:true,status:'REQUIRED'}},
    ],
  }]};
  const audit={rules:{[resourceId]:{status:'PASS'},[physicsId]:{status:'PASS'}}};
  const x=runCase({registry:`${resourceLine}\n${physicsLine}\n${transLine}\n`,plan,discovery,audit});
  assert.match(x.out,/^700\tRequired Framework\t3\.0\t/m);
  assert.match(x.out,/^123\tHDT-SMP Physics Files\t2\.0\t/m);
  assert.strictEqual(x.report.appendedByKind.RESOURCE,1);
  assert.strictEqual(x.report.appendedByKind.PHYSICS,1);
}

// A negative component decision must be family-bound and evidence-backed.
{
  const bodyLine=`123\t456\t2.0\tBODYSLIDE\tCUSTOM:CBBE_3BA\tNOT_APPLICABLE\t\t\t\t\t${today}\tBHUNP profile active\tnot applicable`;
  const transLine=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone`;
  const discovery={items:[{modId:'123',mainFileId:'456',complete:true,candidateCount:1,candidateCountsByKind:{BODYSLIDE:1},unresolved:[],coverageProblems:[],candidates:[{kind:'BODYSLIDE',family:'CUSTOM:CBBE_3BA',decision:{resolved:true,status:'NOT_APPLICABLE'}}]}]};
  const x=runCase({registry:`${bodyLine}\n${transLine}\n`,plan,discovery});
  assert.match(x.out,/\tDOWNLOAD$/m);
  assert.doesNotMatch(x.out,/BodySlide.*DOWNLOAD/);
}

console.log('closure tests: OK');
