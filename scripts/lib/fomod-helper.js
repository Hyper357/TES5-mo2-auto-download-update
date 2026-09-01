// scripts/lib/fomod-helper.js
// FOMOD 安装备忘与预选配置展示模块

function generateFomodReport(localMods, downloadedList) {
  const reports = [];

  for (const dl of downloadedList) {
    const matched = localMods.find(m => String(m.modId) === String(dl.modId));
    if (matched && matched.fomodPlugins && matched.fomodPlugins.length > 0) {
      reports.push({
        name: matched.folderName,
        modId: matched.modId,
        selectedPlugins: matched.fomodPlugins
      });
    }
  }

  return reports;
}

function formatFomodTips(reports) {
  if (!reports || reports.length === 0) return '';
  let out = '\n======================================================\n';
  out += '💡 FOMOD 安装历史选择备忘 (重装时对照使用):\n';
  out += '======================================================\n';
  for (const r of reports) {
    out += `\n📦 [${r.modId}] ${r.name}:\n`;
    r.selectedPlugins.forEach(p => {
      out += `   ✓ ${p}\n`;
    });
  }
  out += '======================================================\n';
  return out;
}

module.exports = {
  generateFomodReport,
  formatFomodTips
};
