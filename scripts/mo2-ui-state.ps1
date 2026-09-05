param(
  [ValidateSet('snapshot','invoke')]
  [string]$Action = 'snapshot',
  [int]$WindowHandle = 0,
  [string]$ButtonPattern = '',
  [int]$MaxElements = 1400
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

function Get-Mo2Process {
  $all = Get-Process ModOrganizer -ErrorAction SilentlyContinue | Sort-Object StartTime
  if (-not $all) { return $null }
  $visible = $all | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($visible) { return $visible }
  return $all | Select-Object -First 1
}

function Get-ProcessWindows([int]$Pid) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $Pid
  )
  $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $out = @()
  for ($i = 0; $i -lt $nodes.Count; $i++) { $out += $nodes.Item($i) }
  return $out
}

function Get-ElementSummary($el, [int]$Limit = 1400) {
  $texts = New-Object System.Collections.Generic.List[string]
  $buttons = New-Object System.Collections.Generic.List[string]
  $queueItems = New-Object System.Collections.Generic.List[object]
  $all = $el.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $count = [Math]::Min($all.Count, $Limit)
  for ($i = 0; $i -lt $count; $i++) {
    $node = $all.Item($i)
    $name = ''
    try { $name = [string]$node.Current.Name } catch {}
    $type = ''
    try { $type = [string]$node.Current.ControlType.ProgrammaticName } catch {}
    if ($name -and $name.Trim()) {
      $clean = ($name -replace '\s+', ' ').Trim()
      if (-not $texts.Contains($clean)) { $texts.Add($clean) }
      if ($type -eq 'ControlType.Button' -and -not $buttons.Contains($clean)) { $buttons.Add($clean) }
    }

    if ($type -in @('ControlType.TreeItem','ControlType.ListItem','ControlType.DataItem')) {
      $rowTexts = New-Object System.Collections.Generic.List[string]
      if ($name -and $name.Trim()) { $rowTexts.Add(($name -replace '\s+', ' ').Trim()) }
      try {
        $children = $node.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          [System.Windows.Automation.Condition]::TrueCondition
        )
        $childCount = [Math]::Min($children.Count, 40)
        for ($j = 0; $j -lt $childCount; $j++) {
          $cn = [string]$children.Item($j).Current.Name
          if ($cn -and $cn.Trim()) {
            $cc = ($cn -replace '\s+', ' ').Trim()
            if (-not $rowTexts.Contains($cc)) { $rowTexts.Add($cc) }
          }
        }
      } catch {}
      if ($rowTexts.Count -gt 0) {
        $queueItems.Add([pscustomobject]@{
          name = $rowTexts[0]
          texts = @($rowTexts)
          controlType = $type
        })
      }
    }
  }
  return [pscustomobject]@{
    texts = @($texts)
    buttons = @($buttons)
    queueItems = @($queueItems)
    scanned = $count
    truncated = ($all.Count -gt $count)
  }
}

$proc = Get-Mo2Process
if (-not $proc) {
  [pscustomobject]@{
    ok = $false
    error = 'MO2_NOT_RUNNING'
    process = $null
    windows = @()
    queueItems = @()
  } | ConvertTo-Json -Depth 8 -Compress
  exit 2
}

$windows = @(Get-ProcessWindows -Pid $proc.Id)

if ($Action -eq 'invoke') {
  if ($WindowHandle -le 0 -or -not $ButtonPattern) {
    throw 'invoke requires -WindowHandle and -ButtonPattern'
  }

  $target = $null
  foreach ($w in $windows) {
    $h = 0
    try { $h = [int]$w.Current.NativeWindowHandle } catch {}
    if ($h -eq $WindowHandle) { $target = $w; break }
  }
  if (-not $target) {
    [pscustomobject]@{ ok = $false; error = 'WINDOW_NOT_FOUND'; handle = $WindowHandle } | ConvertTo-Json -Compress
    exit 3
  }

  $all = $target.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $matches = @()
  for ($i = 0; $i -lt $all.Count; $i++) {
    $node = $all.Item($i)
    $type = ''
    try { $type = [string]$node.Current.ControlType.ProgrammaticName } catch {}
    if ($type -ne 'ControlType.Button') { continue }
    $name = ''
    try { $name = [string]$node.Current.Name } catch {}
    if ($name -match $ButtonPattern) { $matches += $node }
  }

  # Fail closed: never invoke if the regex maps to multiple controls.
  if ($matches.Count -ne 1) {
    [pscustomobject]@{
      ok = $false
      error = 'BUTTON_MATCH_NOT_UNIQUE'
      handle = $WindowHandle
      matchCount = $matches.Count
      pattern = $ButtonPattern
    } | ConvertTo-Json -Compress
    exit 4
  }

  $invoke = $null
  if (-not $matches[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
    [pscustomobject]@{ ok = $false; error = 'BUTTON_NOT_INVOKABLE'; handle = $WindowHandle } | ConvertTo-Json -Compress
    exit 5
  }
  $buttonName = [string]$matches[0].Current.Name
  $invoke.Invoke()
  Start-Sleep -Milliseconds 250
  [pscustomobject]@{
    ok = $true
    invoked = $true
    handle = $WindowHandle
    button = $buttonName
  } | ConvertTo-Json -Compress
  exit 0
}

$windowOut = New-Object System.Collections.Generic.List[object]
$queueOut = New-Object System.Collections.Generic.List[object]
foreach ($w in $windows) {
  $sum = Get-ElementSummary -el $w -Limit $MaxElements
  $handle = 0
  $title = ''
  $className = ''
  try { $handle = [int]$w.Current.NativeWindowHandle } catch {}
  try { $title = [string]$w.Current.Name } catch {}
  try { $className = [string]$w.Current.ClassName } catch {}
  $isMain = ($handle -eq [int]$proc.MainWindowHandle)
  $windowOut.Add([pscustomobject]@{
    handle = $handle
    title = $title
    className = $className
    isMain = $isMain
    isDialog = (-not $isMain)
    texts = $sum.texts
    buttons = $sum.buttons
    scanned = $sum.scanned
    truncated = $sum.truncated
  })
  if ($isMain) {
    foreach ($q in $sum.queueItems) { $queueOut.Add($q) }
  }
}

[pscustomobject]@{
  ok = $true
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  process = [pscustomobject]@{
    pid = $proc.Id
    name = $proc.ProcessName
    mainWindowHandle = [int]$proc.MainWindowHandle
  }
  windows = @($windowOut)
  queueItems = @($queueOut)
} | ConvertTo-Json -Depth 10 -Compress
