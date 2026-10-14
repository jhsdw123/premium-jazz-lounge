#!/bin/bash
# PJL 영상 작업 도구 — 맥북 설치 (한 번만. 다시 돌려도 안전: 있는 것은 건너뛰고 코드는 최신으로 받는다)
#
#   맥 터미널에서:  bash 맥-설치.sh
#
#   하는 일
#   ① 도구 설치: Homebrew · node · ffmpeg · python · gh · syncthing
#   ② 깃허브 로그인(처음 한 번) → 코드 받기 (윈도우와 같은 자리, 바탕화면)
#        ~/Desktop/Premium-jazz-lounge/premium-jazz-lounge   PJL 컨트롤 패널 (4001)
#        ~/Desktop/ClipLoop-Studio                           루프 만들기 (4010)
#        ~/Desktop/PNL-3D-Studio                             3시간 늘리기 도구 (+ PNL 패널 4002)
#   ③ USB 로 가져온 비밀 파일 넣기 (이 스크립트 옆 '비밀' 폴더 → 각 자리. 이미 있으면 안 덮어씀)
#   ④ npm install · 늘리기용 파이썬 환경(.venv-mac: numpy·pillow)
#   ⑤ Syncthing: 윈도우 PC 와 루프 영상 폴더 맞추기
#        실제 폴더 ~/PJLLoopvideo  +  바탕화면 바로가기 ~/Desktop/PJLLoopvideo
#        (맥은 백그라운드 프로그램이 '바탕화면' 폴더를 못 건드리게 막아서 실제 폴더는 홈에 둔다)
#   ⑥ 바탕화면 실행 파일 3개
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/Desktop"
PC_ID="X6E7VFM-LNOMU6M-XONAHTY-GBAMNJ6-GKOFIVA-MV4IOS7-GPHOVIQ-2YWD7AI"   # 윈도우 PC 의 Syncthing ID
FOLDER_ID="pjl-loopvideo"
LOOP_REAL="$HOME/PJLLoopvideo"
PJL="$D/Premium-jazz-lounge/premium-jazz-lounge"
CLIP="$D/ClipLoop-Studio"
PNL="$D/PNL-3D-Studio"

say()  { printf '%s\n' "$*"; }
step() { printf '\n━━ %s\n' "$*"; }
warn() { printf '   ⚠️  %s\n' "$*"; WARNS=$((WARNS+1)); }
die()  { printf '\n❌ %s\n' "$*"; exit 1; }
WARNS=0

[ "$(uname)" = Darwin ] || die "맥에서 실행하세요."

# ── ① 도구 ──────────────────────────────────────────────
step "① 도구 설치"
if ! command -v brew >/dev/null; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
if ! command -v brew >/dev/null; then
  say "   Homebrew 를 설치합니다 — 맥 로그인 비밀번호를 물으면 입력하세요 (화면에 안 보이는 게 정상)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "Homebrew 설치 실패"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  # 새 터미널에서도 brew 가 보이게
  grep -q 'brew shellenv' "$HOME/.zprofile" 2>/dev/null || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
fi
for pkg in node ffmpeg python gh syncthing; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then say "   - $pkg 이미 있음"
  else say "   - $pkg 설치 중…"; brew install "$pkg" >/dev/null || die "$pkg 설치 실패"; fi
done

# ── ② 깃허브 → 코드 ──────────────────────────────────────
step "② 코드 받기"
if ! gh auth status >/dev/null 2>&1; then
  say "   깃허브 로그인이 필요합니다. 브라우저가 열리면 화면의 8자리 코드를 넣고 승인하세요."
  gh auth login --hostname github.com --git-protocol https --web || die "깃허브 로그인 실패"
fi
gh auth setup-git >/dev/null 2>&1
get_repo() {   # $1 = 깃허브 이름, $2 = 넣을 자리
  if [ -d "$2/.git" ]; then
    git -C "$2" pull --ff-only -q && say "   - $(basename "$2") 최신으로 갱신" || warn "$(basename "$2") 갱신 실패 (그 폴더에 고친 파일이 있나요?)"
  else
    mkdir -p "$(dirname "$2")"
    gh repo clone "jhsdw123/$1" "$2" -- -q && say "   - $(basename "$2") 받음" || die "$1 받기 실패"
  fi
}
get_repo premium-jazz-lounge "$PJL"
get_repo cliploop-studio "$CLIP"
get_repo pnl-3d-studio "$PNL"

# ── ③ 비밀 파일 ──────────────────────────────────────────
step "③ 비밀 파일 (USB 의 '비밀' 폴더)"
put_secret() {   # $1 = '비밀' 안 경로, $2 = 넣을 자리
  if [ -e "$2" ]; then say "   - $(basename "$2") 이미 있음"
  elif [ -e "$HERE/비밀/$1" ]; then cp -R "$HERE/비밀/$1" "$2" && say "   - $(basename "$2") 넣음"
  else warn "$1 이 없습니다 — USB 의 '비밀' 폴더를 이 스크립트 옆에 두고 다시 돌리세요"; fi
}
put_secret premium-jazz-lounge/.env.local "$PJL/.env.local"
put_secret premium-jazz-lounge/secrets    "$PJL/secrets"
put_secret PNL-3D-Studio/data             "$PNL/data"

# ── ④ 의존성 ────────────────────────────────────────────
step "④ npm install · 파이썬 환경"
for d in "$PJL" "$PNL"; do
  ( cd "$d" && npm install --no-audit --no-fund --loglevel=error >/dev/null ) && say "   - $(basename "$d") npm install 끝" || warn "$(basename "$d") npm install 실패"
done
if [ ! -x "$PNL/.venv-mac/bin/python" ]; then python3 -m venv "$PNL/.venv-mac" || warn "파이썬 환경을 못 만들었습니다"; fi
"$PNL/.venv-mac/bin/pip" install -q --upgrade numpy pillow && say "   - 늘리기용 numpy·pillow 준비됨" || warn "numpy·pillow 설치 실패 (3시간 늘리기의 인트로가 안 됩니다)"

# ── ⑤ Syncthing ─────────────────────────────────────────
step "⑤ Syncthing — 루프 영상 폴더"
mkdir -p "$LOOP_REAL"
if [ -L "$D/PJLLoopvideo" ] || [ ! -e "$D/PJLLoopvideo" ]; then ln -sfn "$LOOP_REAL" "$D/PJLLoopvideo"
else warn "바탕화면에 진짜 'PJLLoopvideo' 폴더가 이미 있습니다 — 그 안의 영상을 ~/PJLLoopvideo 로 옮기고 지운 뒤 다시 돌리세요"; fi
# 무시 목록은 동기화되지 않으므로 윈도우와 같은 내용을 여기서 만든다
cat > "$LOOP_REAL/.stignore" <<'EOF'
// PC·맥 사이에 루프 영상만 맞춘다 — 완성본(수십 GB)과 재생용 캐시는 각자 컴퓨터에만.
// 이 파일은 동기화되지 않는다: 윈도우 쪽에도 같은 내용이 있다.
/30분완성본
/.cache
(?d).DS_Store
(?d)._*
(?d)Thumbs.db
(?d)desktop.ini
EOF
brew services start syncthing >/dev/null 2>&1 || brew services restart syncthing >/dev/null 2>&1
CFG="$HOME/Library/Application Support/Syncthing/config.xml"
KEY=""
for i in $(seq 1 30); do
  [ -f "$CFG" ] && KEY=$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$CFG" | head -1)
  [ -n "$KEY" ] && curl -fs -H "X-API-Key: $KEY" http://127.0.0.1:8384/rest/system/ping >/dev/null 2>&1 && break
  sleep 1
done
api() { curl -fs -H "X-API-Key: $KEY" -H 'Content-Type: application/json' "$@"; }
if [ -z "$KEY" ] || ! api http://127.0.0.1:8384/rest/system/ping >/dev/null; then
  warn "Syncthing 이 켜지지 않았습니다 — 'brew services start syncthing' 후 이 스크립트를 다시 돌리세요"
else
  MAC_ID=$(api http://127.0.0.1:8384/rest/system/status | python3 -c 'import json,sys; print(json.load(sys.stdin)["myID"])')
  if ! api "http://127.0.0.1:8384/rest/config/devices/$PC_ID" >/dev/null 2>&1; then
    api -X POST http://127.0.0.1:8384/rest/config/devices \
      -d "{\"deviceID\":\"$PC_ID\",\"name\":\"윈도우 PC\",\"addresses\":[\"dynamic\"]}" >/dev/null && say "   - 윈도우 PC 를 장치로 추가"
  fi
  if ! api "http://127.0.0.1:8384/rest/config/folders/$FOLDER_ID" >/dev/null 2>&1; then
    api -X POST http://127.0.0.1:8384/rest/config/folders -d "{\"id\":\"$FOLDER_ID\",\"label\":\"PJLLoopvideo\",\"path\":\"$LOOP_REAL\",\"type\":\"sendreceive\",\"devices\":[{\"deviceID\":\"$MAC_ID\"},{\"deviceID\":\"$PC_ID\"}],\"fsWatcherEnabled\":true,\"rescanIntervalS\":3600,\"versioning\":{\"type\":\"trashcan\",\"params\":{\"cleanoutDays\":\"30\"}}}" >/dev/null \
      && say "   - 루프 폴더(~/PJLLoopvideo)를 윈도우 PC 와 공유하도록 설정"
  fi
  say "   - 이 맥의 Syncthing ID: $MAC_ID"
fi

# ── ⑥ 바탕화면 실행 파일 ────────────────────────────────
step "⑥ 바탕화면 실행 파일"
mk_launcher() {   # $1 = 바탕화면 파일 이름, $2 = 실제로 실행할 파일
  printf '#!/bin/bash\nexec bash "%s"\n' "$2" > "$D/$1" && chmod +x "$D/$1" && say "   - $1"
}
mk_launcher "프리미엄재즈-패널시작.command" "$PJL/start-jazz.command"
mk_launcher "ClipLoop-Studio-시작.command"   "$CLIP/ClipLoop-Studio-시작.command"
mk_launcher "PJL-영상-길게-늘리기.command"    "$PNL/PJL-영상-길게-늘리기.command"

# ── 끝 ──────────────────────────────────────────────────
step "끝"
[ $WARNS -gt 0 ] && say "⚠️  위에 ⚠️ 표시가 ${WARNS}개 있습니다. 확인해 주세요." || say "✅ 모두 준비됐습니다."
say ""
say "남은 한 가지: 윈도우 PC 쪽에서 이 맥을 '허락'해야 루프 영상이 넘어옵니다."
say "  → PC 의 Claude 에게 '맥 설치 끝났어' 라고 말하거나,"
say "    PC 브라우저에서 http://127.0.0.1:8384 를 열어 위쪽 '새 장치' 알림의 [장치 추가] → 공유 폴더 PJLLoopvideo 체크 → 저장."
say ""
say "처음 쓸 때 '터미널이 바탕화면 폴더에 접근하려고 합니다' 가 뜨면 [허용]."
