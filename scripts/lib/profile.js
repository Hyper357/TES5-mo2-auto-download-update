// scripts/lib/profile.js
// 本地整合包画像与兼容性决策引擎 (Context Fingerprint Engine)

class ModProfile {
  constructor(options = {}) {
    this.platform = options.platform || 'AE'; // AE | SE | VR
    this.bodyType = options.bodyType || '3BA'; // 3BA | CBBE | BHUNP | UNP
    this.textureTier = options.textureTier || '2K'; // 2K | 4K
  }

  // 自动从本地 mods 列表统计并推导画像指纹
  static analyzeFromMods(mods) {
    let seCount = 0, aeCount = 0, vrCount = 0;
    let cbbe3baCount = 0, bhunpCount = 0;

    for (const m of mods) {
      const text = (m.folderName + ' ' + (m.installationFile || '')).toLowerCase();
      if (text.includes('vr')) vrCount++;
      if (text.includes('ae') || text.includes('1.6.')) aeCount++;
      if (text.includes('se') || text.includes('1.5.97')) seCount++;

      if (text.includes('3ba') || text.includes('cbbe')) cbbe3baCount++;
      if (text.includes('bhunp') || text.includes('unp')) bhunpCount++;
    }

    const platform = vrCount > aeCount && vrCount > seCount ? 'VR' : (aeCount >= seCount ? 'AE' : 'SE');
    const bodyType = bhunpCount > cbbe3baCount ? 'BHUNP' : '3BA';

    return new ModProfile({ platform, bodyType });
  }

  // 判断目标 Nexus 文件是否与本地画像兼容
  isCompatible(nexusFile, localMod = {}) {
    const fn = (nexusFile.name + ' ' + (nexusFile.file_name || '')).toLowerCase();
    const loc = ((localMod.folderName || '') + ' ' + (localMod.installationFile || '')).toLowerCase();

    // 1. 平台互斥门禁
    const isLocVR = loc.includes('vr');
    const isFileVR = /\bvr\b|\(vr\)/i.test(fn);
    if (!isLocVR && this.platform !== 'VR' && isFileVR) {
      return false; // 非 VR 环境严禁匹配 VR 插件
    }

    // 2. 身形互斥门禁
    const isLoc3BA = loc.includes('3ba') || loc.includes('cbbe');
    const isLocBHUNP = loc.includes('bhunp') || loc.includes('unp');
    const isFile3BA = fn.includes('3ba') || fn.includes('cbbe');
    const isFileBHUNP = fn.includes('bhunp') || fn.includes('unp');

    if (isLoc3BA && isFileBHUNP && !isFile3BA) return false;
    if (isLocBHUNP && isFile3BA && !isFileBHUNP) return false;

    // 3. 补丁与本体隔离
    const isLocPatch = /patch|fix|addon|hotfix/i.test(loc);
    const isFilePatch = /patch|fix|addon|hotfix/i.test(fn);
    if (!isLocPatch && isFilePatch && nexusFile.category_id !== 1) {
      return false; // 本地是本体，拒绝可选第三方兼容补丁
    }

    return true;
  }
}

module.exports = ModProfile;
