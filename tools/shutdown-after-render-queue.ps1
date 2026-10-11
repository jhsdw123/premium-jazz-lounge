# Watch the render queue and shut the PC down once the given jobs are fully saved.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\shutdown-after-render-queue.ps1 -Ids 5e55a7a7,64f9ba54
#
# Every -IntervalSec (default 600 = 10 min) it reads GET /api/render-queue and checks each job:
#   status = done, the mp4 exists and its length matches the planned length,
#   and (when the job has extend on) ext.status = done and the extended mp4 exists with ~N hours.
# All good            -> "shutdown /s /t 300" (5 minutes to cancel with: shutdown /a)
# Any failed/stopped  -> no shutdown, the script ends (the PC stays on so you can look)
# Panel unreachable   -> keeps trying; after 6 misses in a row (1 hour) it ends without shutdown
#
# ASCII only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
param(
  [Parameter(Mandatory = $true)][string[]]$Ids,
  [int]$IntervalSec = 600,
  [string]$Base = 'http://localhost:4001',
  [string]$Log = "$env:USERPROFILE\Desktop\PJL-shutdown-watch.log"
)

function Say([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
  Write-Host $line
}

function DurationOf([string]$file) {
  try {
    $out = & ffprobe -v error -show_entries format=duration -of csv=p=0 $file
    return [double]($out | Select-Object -First 1)
  } catch { return 0 }
}

Say "watch start: ids=$($Ids -join ',') every ${IntervalSec}s"
$misses = 0
while ($true) {
  $q = $null
  try { $q = Invoke-RestMethod -Uri "$Base/api/render-queue" -TimeoutSec 20 } catch { $q = $null }
  if (-not $q -or -not $q.ok) {
    $misses++
    Say "panel not reachable ($misses/6)"
    if ($misses -ge 6) { Say 'giving up - NO shutdown'; exit 2 }
    Start-Sleep -Seconds $IntervalSec
    continue
  }
  $misses = 0
  $hours = [double]$q.extendHours
  $allDone = $true
  $broken = $false
  $parts = @()
  foreach ($id in $Ids) {
    $it = $q.items | Where-Object { $_.id -eq $id }
    if (-not $it) { Say "job $id is gone from the queue - NO shutdown"; exit 3 }
    $ext = $it.ext
    $state = "$($it.templateName): $($it.status)"
    if ($ext -and $ext.status) { $state += " / ext $($ext.status)" }
    $parts += $state

    if ($it.status -eq 'failed' -or $it.status -eq 'stopped' -or ($ext -and $ext.status -eq 'failed')) { $broken = $true; continue }
    if ($it.status -ne 'done') { $allDone = $false; continue }

    # recorded file
    if (-not $it.file -or -not (Test-Path -LiteralPath $it.file)) { Say "job ${id}: recorded file missing ($($it.file))"; $broken = $true; continue }
    $dur = DurationOf $it.file
    if ($dur -lt ([double]$it.durationSec * 0.97)) { Say ("job ${id}: recorded file too short ({0:n0}s of {1:n0}s)" -f $dur, $it.durationSec); $broken = $true; continue }

    # extended file
    if ($it.extend) {
      if (-not $ext -or $ext.status -ne 'done') { $allDone = $false; continue }
      if (-not $ext.file -or -not (Test-Path -LiteralPath $ext.file)) { Say "job ${id}: extended file missing ($($ext.file))"; $broken = $true; continue }
      $edur = DurationOf $ext.file
      if ($edur -lt ($hours * 3600 * 0.85)) { Say ("job ${id}: extended file too short ({0:n0}s, expected about {1}h)" -f $edur, $hours); $broken = $true; continue }
      $parts[-1] += (" [ok {0:n0}s + {1:n1}h]" -f $dur, ($edur / 3600))
    } else {
      $parts[-1] += (" [ok {0:n0}s]" -f $dur)
    }
  }
  Say ($parts -join ' | ')
  if ($broken) { Say 'a job failed or a file is wrong - NO shutdown'; exit 1 }
  if ($allDone) {
    Say 'all jobs saved - shutting down in 5 minutes (cancel: shutdown /a)'
    & shutdown.exe /s /t 300 /c "PJL render queue finished. Shutting down in 5 minutes. Cancel: shutdown /a"
    exit 0
  }
  Start-Sleep -Seconds $IntervalSec
}
