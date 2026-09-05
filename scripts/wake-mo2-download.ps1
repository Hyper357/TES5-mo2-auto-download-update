param(
  [Parameter(Mandatory = $true)]
  [string]$Pattern
)

Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

function Invoke-SafeMo2DialogGuard([int]$WatchMs = 0) {
  try {
    $node = Get-Command node -ErrorAction Stop
    $guard = Join-Path $PSScriptRoot 'mo2-ui.js'
    if (-not (Test-Path $guard)) { return }
    $args = @($guard, '--name', $Pattern, '--dismiss-safe')
    if ($WatchMs -gt 0) { $args += @('--watch-ms', [string]$WatchMs, '--interval-ms', '250') }
    # The guard is deliberately fail-closed. Non-zero means unsupported/ambiguous;
    # wake logic continues, but no unsafe UI button is pressed.
    & $node.Source @args 2>$null | Out-Null
  } catch {
    # UI guard is best-effort; disk/ledger/verify remain the authoritative safety layers.
  }
}

# NXM handoff can immediately raise either "already in queue" or "re-download?".
# Observe briefly before touching the Downloads row. Safe policy can only press OK/No.
Invoke-SafeMo2DialogGuard -WatchMs 2200

$deadline = (Get-Date).AddSeconds(12)
$midGuardDone = $false
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

  # If a modal appeared slightly after nxmhandler returned, clear only a safe duplicate dialog.
  if (-not $midGuardDone -and ((Get-Date) -gt $deadline.AddSeconds(-7))) {
    Invoke-SafeMo2DialogGuard -WatchMs 500
    $midGuardDone = $true
  }
  Start-Sleep -Milliseconds 500
}

# Last best-effort cleanup so an informational duplicate popup is not left blocking MO2.
Invoke-SafeMo2DialogGuard -WatchMs 300
Write-Output 'ROW_NOT_FOUND'
exit 2
