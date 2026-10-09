# Premium Jazz Lounge 패널 시작 스크립트 (바탕화면 프리미엄재즈-패널시작.bat 이 호출)
#
# 렌더(Studio)는 브라우저 안에서 실시간으로 녹화한다 → 서버 + "안 졸게 켠 브라우저" 가 조건.
#   - 서버: localhost:4001 (이미 켜져 있으면 건드리지 않는다 — 재시작하면 진행 중 작업이 끊긴다)
#   - 브라우저: Comet 기본 프로필 (업로더 기본 재생목록 설정이 이 프로필 localStorage 에 있다)
#     + 백그라운드 절전 끄는 옵션 3개. 이 옵션은 Comet 이 "꺼져 있다가 새로 켜질 때만" 먹는다.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Premium Jazz Lounge 시작"
$ROOT  = $PSScriptRoot
$PORT  = 4001
$URL   = "http://localhost:$PORT"
$COMET = "$env:LOCALAPPDATA\Perplexity\Comet\Application\comet.exe"
$RENDER_FLAGS = @(
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'
)

Write-Host "[1/3] 렌더에 필요한 것 점검..."
$problems = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue))    { $problems += "node 가 없습니다" }
if (-not (Test-Path "$ROOT\node_modules"))                    { $problems += "node_modules 없음 → 이 폴더에서 npm install 필요" }
if (-not (Test-Path "$ROOT\.env.local"))                      { $problems += ".env.local 없음 (Supabase / R2 / Gemini 키)" }
if (-not (Get-Command ffmpeg  -ErrorAction SilentlyContinue)) { $problems += "ffmpeg 가 PATH 에 없음 (곡 분석 불가)" }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { $problems += "ffprobe 가 PATH 에 없음 (곡 길이 분석 불가)" }
if ($problems.Count) {
  $problems | ForEach-Object { Write-Host "   ! $_" -ForegroundColor Yellow }
} else {
  Write-Host "   - node / node_modules / .env.local / ffmpeg / ffprobe 모두 OK"
}

Write-Host "[2/3] 컨트롤 패널 서버 (포트 $PORT)"
if (Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "   - 이미 켜져 있어서 건너뜁니다"
} else {
  Write-Host "   - 검은 창 1개가 새로 뜹니다 - 끄면 안 됩니다!"
  Start-Process cmd -ArgumentList "/k chcp 65001 >nul & title PJL 컨트롤패널 서버 - 끄지 마세요 & cd /d `"$ROOT`" & npm run dev"
}

# 고정 대기 대신 서버가 실제로 대답할 때까지 기다린다 (최대 40초)
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $h = Invoke-RestMethod "$URL/api/health" -TimeoutSec 2
    if ($h) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if ($ready) {
  Write-Host "   - 서버 응답 확인"
} else {
  Write-Host "   ! 40초 안에 서버가 대답하지 않았습니다. 서버 창의 오류를 확인하세요." -ForegroundColor Yellow
}

Write-Host "[3/3] 브라우저"
if (Test-Path $COMET) {
  $cometRunning = [bool](Get-Process comet -ErrorAction SilentlyContinue)
  Start-Process $COMET -ArgumentList ($RENDER_FLAGS + $URL)
  if ($cometRunning) {
    Write-Host "   - Comet 이 이미 켜져 있어 새 탭으로만 열었습니다." -ForegroundColor Yellow
    Write-Host "     (백그라운드 절전 끄기 옵션은 Comet 을 완전히 끈 뒤 이 파일로 켤 때만 적용됩니다." -ForegroundColor Yellow
    Write-Host "      긴 렌더 전에는 Comet 을 한 번 껐다 켜는 쪽이 안전 - GPU 프로세스도 새로 뜹니다)" -ForegroundColor Yellow
  } else {
    Write-Host "   - Comet 을 렌더용 옵션(백그라운드 절전 끔)으로 켰습니다"
  }
} else {
  Write-Host "   ! Comet 을 못 찾아 기본 브라우저로 엽니다 (렌더용 옵션 없음)" -ForegroundColor Yellow
  Start-Process $URL
}

Write-Host ""
Write-Host "완료! 컨트롤 패널 = $URL"
Write-Host "이 창은 닫아도 됩니다. (서버 창은 작업 끝날 때까지 유지)"
Start-Sleep -Seconds 12
