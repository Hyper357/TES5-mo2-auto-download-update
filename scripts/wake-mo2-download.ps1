param(
  [Parameter(Mandatory = $true)]
  [string]$Pattern
)

Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process ModOrganizer -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    if ($root) {
      $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      for ($i = 0; $i -lt $all.Count; $i++) {
        $el = $all.Item($i)
        if ($el.Current.ControlType.ProgrammaticName -eq 'ControlType.TreeItem' -and
            $el.Current.Name -like "*$Pattern*") {
          $invoke = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
            $invoke.Invoke()
            Write-Output 'WOKE'
            exit 0
          }
        }
      }
    }
  }
  Start-Sleep -Milliseconds 500
}

Write-Output 'ROW_NOT_FOUND'
exit 2
