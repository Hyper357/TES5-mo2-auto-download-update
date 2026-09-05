'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, 'closure-gate.js');
const today = new Date().toISOString().slice(0, 10);

function runCase({ registry, plan, audit = { rules: {} } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-test-'));
  const manifest = path.join(dir, 'manifest.tsv');
  const registryFile = path.join(dir, 'registry.tsv');
  const planFile = path.join(dir, 'plan.json');
  const auditFile = path.join(dir, 'audit.json');
  const outFile = path.join(dir, 'out.tsv');
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(manifest, '123\tExample Main\t2.0\tdecision=DOWNLOAD\t456\tDOWNLOAD\n');
  fs.writeFileSync(registryFile, registry);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.writeFileSync(auditFile, JSON.stringify(audit));
  const r = cp.spawnSync(process.execPath, [
    script, manifest, registryFile,
    '--plan', planFile,
    '--registry-audit', auditFile,
    '--out', outFile,
    '--report', reportFile,
  ], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return {
    out: fs.readFileSync(outFile, 'utf8'),
    report: JSON.parse(fs.readFileSync(reportFile, 'utf8')),
  };
}

// 扫描器已经发现 PATCH 候选时，registry 不允许用 NONE 静默绕过。
{
  const registry = [
    `123\t456\t2.0\tPATCH\tNONE\t\t\t\t\t${today}\tFiles checked\tclaimed none`,
    `123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tno translation`,
  ].join('\n');
  const plan = {
    items: [{
      modId: '123', latestFileId: '456', action: 'DOWNLOAD',
      aux: { patches: [{ fileId: '777', version: '1.0', name: 'Example Patch' }], translations: [] },
    }],
  };
  const x = runCase({ registry, plan });
  assert.match(x.out, /HOLD_CLOSURE_CONFLICT/);
  assert.ok(x.report.items[0].conflicts.length > 0);
}

// REQUIRED 附属项通过 registry audit 后，主文件释放且精确 aux 行被追加。
{
  const patchLine = `123\t456\t2.0\tPATCH\tREQUIRED\t999\t1001\t1.2\tExample Patch\t${today}\tFiles+Requirements\trequired`;
  const translationLine = `123\t456\t2.0\tTRANSLATION\tNONE\t\t\t\t\t${today}\tTranslations checked\tno translation`;
  // rule id 的最后一段是解析顺序 index。
  const patchRuleId = '123:456:2.0:PATCH:REQUIRED:999:1001:0';
  const plan = { items: [{ modId: '123', latestFileId: '456', action: 'DOWNLOAD', aux: { patches: [], translations: [] } }] };
  const audit = { rules: { [patchRuleId]: { status: 'PASS' } } };
  const x = runCase({ registry: `${patchLine}\n${translationLine}\n`, plan, audit });
  const lines = x.out.trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /\tDOWNLOAD$/);
  assert.match(lines[1], /^999\tExample Patch\t1\.2\t/);
  assert.match(lines[1], /\t1001\tDOWNLOAD$/);
}

console.log('closure tests: OK');
