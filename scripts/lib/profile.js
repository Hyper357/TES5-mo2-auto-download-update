// scripts/lib/profile.js
// 本地整合包画像与兼容性决策引擎。
// 原则：证据不足时返回 UNKNOWN，绝不把“默认 AE/3BA/2K”伪装成事实。

class ModProfile {
  constructor(options = {}) {
    this.platform = options.platform || 'UNKNOWN'; // AE | SE | VR | GOG | UNKNOWN
    this.bodyType = options.bodyType || 'UNKNOWN'; // 3BA | CBBE | BHUNP | UNP | UNKNOWN
    this.textureTier = options.textureTier || 'UNKNOWN'; // 1K | 2K | 4K | 8K | UNKNOWN
    this.confidence = options.confidence || { platform: 'low', bodyType: 'low', textureTier: 'low' };
    this.evidence = options.evidence || {};
  }

  static _pick(counts, minEvidence = 2, minMargin = 1) {
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [bestName, bestCount] = ranked[0] || ['UNKNOWN', 0];
    const secondCount = ranked[1]?.[1] || 0;
    if (bestCount < minEvidence || bestCount - secondCount < minMargin) {
      return { value: 'UNKNOWN', confidence: 'low', ranked };
    }
    return {
      value: bestName,
      confidence: bestCount >= 5 && bestCount - secondCount >= 3 ? 'high' : 'medium',
      ranked,
    };
  }

  // 自动从本地 mods 列表统计并推导画像指纹。
  // 只统计明确 token，不再使用 text.includes('se') 这类会命中普通单词的宽松规则。
  static analyzeFromMods(mods) {
    const platformCounts = { AE: 0, SE: 0, VR: 0, GOG: 0 };
    const bodyCounts = { '3BA': 0, CBBE: 0, BHUNP: 0, UNP: 0 };
    const textureCounts = { '1K': 0, '2K': 0, '4K': 0, '8K': 0 };

    for (const m of mods || []) {
      const text = `${m.folderName || ''} ${m.installationFile || ''}`.toLowerCase();

      if (/\bvr\b/.test(text)) platformCounts.VR++;
      if (/\bgog\b/.test(text)) platformCounts.GOG++;
      if (/\b1[._ -]?5[._ -]?97\b/.test(text) || /\bskyrim\s*se\b/.test(text)) platformCounts.SE++;
      if (/\b1[._ -]?6(?:[._ -]?\d+){1,2}\b/.test(text) || /\bskyrim\s*ae\b/.test(text) || /\banniversary\s+edition\b/.test(text)) platformCounts.AE++;

      if (/\b3ba\b/.test(text)) bodyCounts['3BA']++;
      if (/\bcbbe\b/.test(text)) bodyCounts.CBBE++;
      if (/\bbhunp\b/.test(text)) bodyCounts.BHUNP++;
      if (/\bunp\b/.test(text) && !/\bbhunp\b/.test(text)) bodyCounts.UNP++;

      for (const tier of ['1k', '2k', '4k', '8k']) {
        if (new RegExp(`\\b${tier}\\b`, 'i').test(text)) textureCounts[tier.toUpperCase()]++;
      }
    }

    const p = ModProfile._pick(platformCounts, 2, 1);
    const b = ModProfile._pick(bodyCounts, 2, 1);
    // 纹理包经常混用不同分辨率，门槛更高；证据不足时宁可 UNKNOWN。
    const t = ModProfile._pick(textureCounts, 4, 2);

    return new ModProfile({
      platform: p.value,
      bodyType: b.value,
      textureTier: t.value,
      confidence: { platform: p.confidence, bodyType: b.confidence, textureTier: t.confidence },
      evidence: { platform: platformCounts, bodyType: bodyCounts, textureTier: textureCounts },
    });
  }

  // 兼容性只在画像已知时作为硬门禁；UNKNOWN 不做猜测性排除。
  isCompatible(nexusFile, localMod = {}) {
    const fn = `${nexusFile?.name || ''} ${nexusFile?.file_name || ''}`.toLowerCase();
    const loc = `${localMod.folderName || ''} ${localMod.installationFile || ''}`.toLowerCase();

    const isLocVR = /\bvr\b/.test(loc);
    const isFileVR = /\bvr\b|\(vr\)/i.test(fn);
    if (!isLocVR && this.platform !== 'UNKNOWN' && this.platform !== 'VR' && isFileVR) return false;

    const isLoc3BA = /\b3ba\b|\bcbbe\b/.test(loc);
    const isLocBHUNP = /\bbhunp\b|\bunp\b/.test(loc);
    const isFile3BA = /\b3ba\b|\bcbbe\b/.test(fn);
    const isFileBHUNP = /\bbhunp\b|\bunp\b/.test(fn);

    if (isLoc3BA && isFileBHUNP && !isFile3BA) return false;
    if (isLocBHUNP && isFile3BA && !isFileBHUNP) return false;

    if (!isLoc3BA && !isLocBHUNP && this.bodyType !== 'UNKNOWN') {
      if (['3BA', 'CBBE'].includes(this.bodyType) && isFileBHUNP && !isFile3BA) return false;
      if (['BHUNP', 'UNP'].includes(this.bodyType) && isFile3BA && !isFileBHUNP) return false;
    }

    const isLocPatch = /\b(patch|fix|addon|hotfix)\b/i.test(loc);
    const isFilePatch = /\b(patch|fix|addon|hotfix)\b/i.test(fn);
    if (!isLocPatch && isFilePatch && Number(nexusFile?.category_id) !== 1) return false;

    return true;
  }
}

module.exports = ModProfile;
