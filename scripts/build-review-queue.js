#!/usr/bin/env node
'use strict';

const fs = require('fs');
function argValue(name, fallback='') { const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : fallback; }
function load(file,fallback) { if(!file || !fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file,'utf8')); }
function compactCandidates(items) { return (items||[]).map(x=>`${x.kind||'PATCH'}:${x.fileId||x.auxModId||x.key||''}:${x.version||''}:${x.family||''}:${x.name||''}`).join(' | '); }

function main() {
  const planFile=process.argv[2];
  const closureFile=process.argv[3];
  const discoveryFile=argValue('--component-discovery',argValue('--patch-discovery'));
  const outFile=argValue('--out');
  const tsvFile=argValue('--tsv');
  if(!planFile || !closureFile){ console.error('Usage: node build-review-queue.js <plan.json> <closure.json> [--component-discovery discovery.json] --out review.json [--tsv review.tsv]'); process.exit(2); }
  const plan=load(planFile,{items:[]});
  const closure=load(closureFile,{items:[]});
  const discovery=load(discoveryFile,{items:[]});
  const closureByKey=new Map((closure.items||[]).map(x=>[`${x.modId}:${x.fileId}`,x]));
  const discoveryByKey=new Map((discovery.items||[]).map(x=>[`${x.modId}:${x.mainFileId}`,x]));
  const queue=[];

  for(const item of plan.items||[]){
    const targetFileId=item.latestFileId||item.fileId||'';
    const k=`${item.modId}:${targetFileId}`;
    const c=closureByKey.get(k);
    const pd=discoveryByKey.get(k);
    const mainHold=/^HOLD_/.test(item.action||'');
    const closureHold=c && c.closure==='FAILED';
    const discoveryHold=pd && !pd.complete;
    if(!mainHold && !closureHold && !discoveryHold) continue;

    const next=[];
    if(['HOLD_REVIEW','HOLD_AMBIGUOUS','HOLD_LOW_CONFIDENCE','HOLD_SAME_VERSION_REPLACEMENT'].includes(item.action)) next.push('核对 Files 页面与当前安装来源，明确正确 Main File/变体；禁止按上传时间直接选');
    if(item.action==='HOLD_UPDATE_ELIGIBILITY') next.push(`先解决“是否真的需要更新”：${item.updateEligibility?.reason||item.reason||'证据不足'}；MO2 黄色箭头/版本字段只是提示，不能直接授权下载`);
    if(item.action==='HOLD_UPDATE_TARGET_MISMATCH') next.push('exact update evidence 与下游目标选择不一致；核对当前 exact fileId、同分支后续文件及 Main selector，不得静默 SKIP');
    if(item.action==='HOLD_VARIANT_POLICY_CHANGED') next.push(`已记住的 Main 分支 ${item.variantPolicy?.branchKey||'UNKNOWN'} 无法安全复用；打开 Review Center 重新确认，禁止自动回退到其他分支`);
    if(item.action==='HOLD_MULTI_SOURCE') next.push('核对该 MO2 条目实际由哪个 fileId/归档构成，拆分或明确来源');
    if(item.action==='HOLD_UNRESOLVED_LOCAL') next.push('从 meta.ini / downloads .meta / installationFile 恢复精确本地 fileId');
    if(pd?.coverageProblems?.length) next.push(`补齐 Component discovery 覆盖: ${pd.coverageProblems.map(x=>`${x.source}:${x.status}`).join(', ')}`);
    if(pd?.unresolved?.length) next.push(`逐个解释 ${pd.unresolved.length} 个 Component 候选族：REQUIRED / NOT_APPLICABLE / ALREADY_INCLUDED / OBSOLETE`);
    if(c?.missingKinds?.length) next.push(`补齐 registry: ${c.missingKinds.join(', ')}`);
    if(c?.staleRules?.length) next.push('重新核验过期的 Component/汉化结论，并更新 checkedAt/evidence');
    if(c?.conflicts?.length) next.push('Discovery 证据与 registry 冲突，必须逐个解释候选，不得直接写 NONE');
    if(c?.invalidRules?.length) next.push('修复 registry 记录，并确保 REQUIRED 附属 fileId 已通过 registry audit');

    queue.push({
      priority: /^HOLD_UPDATE_/.test(item.action||'') ? 'P0-UPDATE-ELIGIBILITY' : (discoveryHold ? 'P0-COMPONENT-DISCOVERY' : (item.action==='DOWNLOAD' ? 'P1-CLOSURE':'P0-MAIN')),
      modId:item.modId, localName:item.name,
      localFileId:item.localFileId||item.fileId||'', localVersion:item.localApiVersion||item.installedVersion||'',
      targetFileId, targetVersion:item.latestVersion||'', targetName:item.latestName||'',
      mainAction:item.action, confidence:item.confidence, margin:item.margin,
      updateEligibility:item.updateEligibility||null,
      variantPolicy:item.variantPolicy||null,
      topCandidates:item.candidates||[],
      componentCandidates:item.aux?.components||[], patchCandidates:item.aux?.patches||[], translationCandidates:item.aux?.translations||[],
      componentDiscovery:pd||null, patchDiscovery:pd||null, closure:c||null, nextActions:next,
    });
  }
  queue.sort((a,b)=>a.priority.localeCompare(b.priority)||Number(a.modId)-Number(b.modId));
  const payload={generatedAt:new Date().toISOString(),plan:planFile,closure:closureFile,componentDiscovery:discoveryFile||null,patchDiscovery:discoveryFile||null,count:queue.length,items:queue};
  if(outFile) fs.writeFileSync(outFile,JSON.stringify(payload,null,2),'utf8');
  if(tsvFile){
    const header=['priority','modId','localName','localFileId','localVersion','targetFileId','targetVersion','targetName','mainAction','confidence','updateEligibility','mo2ArrowHint','variantPolicy','componentDiscovery','unresolvedComponents','samePageComponents','translationCandidates','nextActions'];
    const lines=[header.join('\t')];
    for(const q of queue) lines.push([
      q.priority,q.modId,q.localName,q.localFileId,q.localVersion,q.targetFileId,q.targetVersion,q.targetName,q.mainAction,q.confidence,
      q.updateEligibility?.state||'',q.updateEligibility?.mo2Hint?.wouldShowUpdateArrow?'YES':'NO',q.variantPolicy?.branchKey||'',
      q.componentDiscovery ? (q.componentDiscovery.complete?'COMPLETE':`HOLD coverage=${q.componentDiscovery.coverageProblems?.length||0} unresolved=${q.componentDiscovery.unresolvedCount||0}`):'',
      compactCandidates(q.componentDiscovery?.unresolved),compactCandidates(q.componentCandidates),compactCandidates(q.translationCandidates),q.nextActions.join(' / '),
    ].map(x=>String(x||'').replace(/[\t\r\n]+/g,' ')).join('\t'));
    fs.writeFileSync(tsvFile,lines.join('\n')+'\n','utf8');
  }
  console.log(JSON.stringify({count:queue.length,outFile,tsvFile},null,2));
}
main();
