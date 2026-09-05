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
  const r=cp.spawnSync(process.execPath,[script,manifest,registryFile,'--plan',planFile,'--patch-discovery',discoveryFile,'--registry-audit',auditFile,'--out',outFile,'--report',reportFile],{encoding:'utf8'});
  assert.strictEqual(r.status,0,r.stderr);
  return {out:fs.readFileSync(outFile,'utf8'),report:JSON.parse(fs.readFileSync(reportFile,'utf8'))};
}
const plan={items:[{modId:'123',latestFileId:'456',action:'DOWNLOAD',aux:{patches:[],translations:[]}}]};

// Requirements coverage cannot be proven -> MAIN must not download.
{
  const registry=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tchecked\tnone\n`;
  const discovery={items:[{modId:'123',mainFileId:'456',complete:false,candidateCount:0,unresolved:[],coverageProblems:[{source:'requirementsReverse',status:'SECTION_NOT_PROVEN'}]}]};
  const x=runCase({registry,plan,discovery});
  assert.match(x.out,/HOLD_PATCH_DISCOVERY/);
}

// A discovered family cannot be bypassed with blanket PATCH NONE.
{
  const registry=[
    `123\t456\t2.0\tPATCH\tNONE\t\t\t\t\t${today}\tFiles checked\tclaimed none`,
    `123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone`,
  ].join('\n');
  const discovery={items:[{modId:'123',mainFileId:'456',complete:false,candidateCount:1,unresolved:[{key:'mod:999',family:'USSEP',name:'USSEP Patch'}],coverageProblems:[]}]};
  const x=runCase({registry,plan,discovery});
  assert.match(x.out,/HOLD_PATCH_DISCOVERY/);
}

// Complete discovery with zero patch candidates proves PATCH closure; only translation conclusion is needed.
{
  const registry=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone\n`;
  const discovery={items:[{modId:'123',mainFileId:'456',complete:true,candidateCount:0,unresolved:[],coverageProblems:[]}]};
  const x=runCase({registry,plan,discovery});
  assert.match(x.out,/\tDOWNLOAD$/m);
}

// Resolved REQUIRED patch family is appended exactly after audit pass.
{
  const patchLine=`123\t456\t2.0\tPATCH\tUSSEP\tREQUIRED\t999\t1001\t1.2\tExample USSEP Patch\t${today}\tRequirements reverse + Files\trequired`;
  const transLine=`123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tnone`;
  const patchRuleId='123:456:2.0:PATCH:USSEP:REQUIRED:999:1001:0';
  const discovery={items:[{modId:'123',mainFileId:'456',complete:true,candidateCount:1,unresolved:[],coverageProblems:[],candidates:[{key:'mod:999',family:'USSEP',decision:{resolved:true,status:'REQUIRED'}}]}]};
  const audit={rules:{[patchRuleId]:{status:'PASS'}}};
  const x=runCase({registry:`${patchLine}\n${transLine}\n`,plan,discovery,audit});
  const lines=x.out.trim().split(/\r?\n/);
  assert.strictEqual(lines.length,2);
  assert.match(lines[0],/\tDOWNLOAD$/);
  assert.match(lines[1],/^999\tExample USSEP Patch\t1\.2\t/);
  assert.match(lines[1],/\t1001\tDOWNLOAD$/);
}
console.log('closure tests: OK');
