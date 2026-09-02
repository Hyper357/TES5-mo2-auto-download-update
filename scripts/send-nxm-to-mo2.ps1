param(
  [string]$Handler = $env:MO2_NXM_HANDLER
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Handler)) {
  $Handler = 'E:\SkyrimAE\mo2\nxmhandler.exe'
}

if (-not (Test-Path -LiteralPath $Handler -PathType Leaf)) {
  throw "找不到 MO2 NXM handler: $Handler"
}

$nxm = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($nxm)) {
  throw '剪贴板没有文本。请先在 Nexus 的“Start download manually”链接上右键，选择“复制链接地址”。'
}

try {
  $uri = [Uri]$nxm
} catch {
  throw '剪贴板内容不是有效的 NXM 链接。'
}

$allowedGames = @('skyrimspecialedition', 'skyrimse', 'skyrim')
$pathOk = $uri.AbsolutePath -match '^/mods/\d+/files/\d+$'
$signedOk = ($uri.Query -match '(?:[?&])key=') -and
  ($uri.Query -match '(?:[?&])expires=') -and
  ($uri.Query -match '(?:[?&])user_id=')
if ($uri.Scheme -ne 'nxm' -or $allowedGames -notcontains $uri.Host.ToLowerInvariant() -or -not $pathOk -or -not $signedOk) {
  throw '剪贴板不是当前 Nexus Skyrim 文件页生成的完整 NXM 链接；请重新复制“Start download manually”的链接地址。'
}

# 只把完整链接作为一个参数传给 handler；不回显、不写日志、不保存临时 NXM。
& $Handler $nxm *> $null
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw "MO2 NXM handler 返回错误码 $LASTEXITCODE。"
}

Write-Host '已把当前剪贴板中的 NXM 下载指令交给 MO2。请查看 MO2 下载面板。'
