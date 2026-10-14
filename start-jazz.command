#!/bin/bash
# Premium Jazz Lounge 패널 시작 — 맥용 (윈도우의 pjl-start.ps1 과 같은 일)
#
# 렌더(Studio)는 브라우저 안에서 실시간으로 녹화한다 → 서버 + "안 졸게 켠 브라우저" 가 조건.
#   - 서버: localhost:4001 (이미 켜져 있으면 건드리지 않는다 — 재시작하면 진행 중 작업이 끊긴다)
#   - 브라우저: Comet (없으면 Chrome) + 백그라운드 절전 끄는 옵션 3개.
#     이 옵션은 브라우저가 "꺼져 있다가 새로 켜질 때만" 먹는다.
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
PORT=4001
URL="http://localhost:$PORT"
FLAGS=(--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # 더블클릭으로 열면 brew 경로가 빠져 있을 수 있다

printf '\033]0;PJL 컨트롤패널 서버 - 끄지 마세요\007'
echo ""
echo "[1/3] 렌더에 필요한 것 점검..."
problems=0
command -v node    >/dev/null || { echo "   ! node 가 없습니다 → brew install node"; problems=1; }
[ -d "$ROOT/node_modules" ] || { echo "   - node_modules 없음 → npm install 합니다"; npm install || problems=1; }
[ -f "$ROOT/.env.local" ]   || { echo "   ! .env.local 없음 (Supabase / R2 / Gemini 키) — 윈도우 PC 에서 USB 로 복사"; problems=1; }
command -v ffmpeg  >/dev/null || { echo "   ! ffmpeg 없음 → brew install ffmpeg"; problems=1; }
command -v ffprobe >/dev/null || { echo "   ! ffprobe 없음 → brew install ffmpeg"; problems=1; }
command -v python3 >/dev/null || echo "   ! python3 없음 (3시간 늘리기 불가) → brew install python"
[ -d "$HOME/Desktop/PJLLoopvideo" ] || echo "   ! ~/Desktop/PJLLoopvideo 없음 — 배경 루프 영상 폴더 (Syncthing 으로 맞춤)"
[ $problems = 0 ] && echo "   - node / node_modules / .env.local / ffmpeg / ffprobe 모두 OK"

echo "[2/3] 컨트롤 패널 서버 (포트 $PORT)"
SERVER_PID=""
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "   - 이미 켜져 있어서 건너뜁니다"
else
  echo "   - 이 창이 서버 창이 됩니다 — 작업 끝날 때까지 닫지 마세요!"
  npm run dev &
  SERVER_PID=$!
  # 서버가 켜져 있는 동안 맥이 잠들지 않게 (밤샘 예약 렌더용 — 뚜껑을 닫으면 그래도 잠든다)
  caffeinate -dims -w "$SERVER_PID" &
fi
ready=0
for i in $(seq 1 40); do
  curl -fs "$URL/api/health" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ $ready = 1 ] && echo "   - 서버 응답 확인" || echo "   ! 40초 안에 서버가 대답하지 않았습니다. 위 오류를 확인하세요."

echo "[3/3] 브라우저"
open_browser() {   # $1 = 앱 이름
  if pgrep -xq "$1"; then
    open -a "$1" "$URL"
    echo "   - $1 이 이미 켜져 있어 새 탭으로만 열었습니다."
    echo "     (백그라운드 절전 끄기 옵션은 $1 을 완전히 끈 뒤(⌘Q) 이 파일로 켤 때만 적용 — 긴 렌더 전엔 껐다 켜기)"
  else
    open -na "$1" --args "${FLAGS[@]}" "$URL"
    echo "   - $1 을 렌더용 옵션(백그라운드 절전 끔)으로 켰습니다"
  fi
}
if [ -d "/Applications/Comet.app" ] || [ -d "$HOME/Applications/Comet.app" ]; then open_browser Comet
elif [ -d "/Applications/Google Chrome.app" ]; then open_browser "Google Chrome"
else echo "   ! Comet·Chrome 을 못 찾아 기본 브라우저로 엽니다 (렌더용 옵션 없음)"; open "$URL"; fi

echo ""
echo "완료! 컨트롤 패널 = $URL"
if [ -n "$SERVER_PID" ]; then
  echo "이 창은 서버입니다. 끝내려면 Control+C 또는 창 닫기."
  wait "$SERVER_PID"
fi
