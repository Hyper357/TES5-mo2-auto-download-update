Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process ModOrganizer -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    if ($root) {
      $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      for ($i = 0; $i -lt $all.Count; $i++) {
        $el = $all.Item($i)
        $aid = $el.Current.AutomationId
        $name = $el.Current.Name
        if (($aid -like '*downloadTab.btnRefreshDownloads*') -or ($name -match '刷新|refresh')) {
          $invoke = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
            $invoke.Invoke()
            Write-Output 'REFRESHED'
            exit 0
          }
        }
      }
    }
  }
  Start-Sleep -Milliseconds 500
}

Write-Output 'REFRESH_NOT_FOUND'
exit 2
