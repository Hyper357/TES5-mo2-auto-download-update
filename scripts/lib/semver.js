// scripts/lib/semver.js
// 语义化版本清洗与比对模块

function normalizeVer(v) {
  if (!v) return '';
  let s = String(v).trim().toLowerCase();
  s = s.replace(/^v/i, '').trim();
  s = s.replace(/\.0+$/g, '');
  s = s.replace(/(\.0+)+$/g, '');
  return s;
}

function compareVersions(v1, v2) {
  const n1 = normalizeVer(v1);
  const n2 = normalizeVer(v2);
  if (n1 === n2) return 0;

  const parts1 = n1.split(/[-._+]/).map(p => isNaN(p) ? p : Number(p));
  const parts2 = n2.split(/[-._+]/).map(p => isNaN(p) ? p : Number(p));
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] !== undefined ? parts1[i] : 0;
    const p2 = parts2[i] !== undefined ? parts2[i] : 0;
    if (typeof p1 === 'number' && typeof p2 === 'number') {
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    } else {
      const s1 = String(p1);
      const s2 = String(p2);
      if (s1 > s2) return 1;
      if (s1 < s2) return -1;
    }
  }
  return 0;
}

module.exports = {
  normalizeVer,
  compareVersions
};
