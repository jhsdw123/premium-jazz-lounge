# 🍎 맥북에서 PJL 영상 작업 도구 쓰기

윈도우 PC 와 똑같이 맥북(M4 Pro)에서도 PJL 영상을 만든다. 데이터(곡·제목·템플릿·영상 기록·"사용됨" 표시)는
전부 클라우드(Supabase·R2)라 두 컴퓨터가 같은 것을 본다. 컴퓨터마다 따로인 것은 **배경 루프 영상 파일**뿐이고,
이건 Syncthing 이 두 컴퓨터의 폴더를 자동으로 똑같이 맞춘다.

| 도구 | 깃허브 (비공개) | 맥 위치 | 바탕화면 실행 파일 |
|---|---|---|---|
| PJL 컨트롤 패널 (4001) | jhsdw123/premium-jazz-lounge | `~/Desktop/Premium-jazz-lounge/premium-jazz-lounge` | 프리미엄재즈-패널시작.command |
| ClipLoop Studio (4010) | jhsdw123/cliploop-studio | `~/Desktop/ClipLoop-Studio` | ClipLoop-Studio-시작.command |
| 3시간 늘리기 (+PNL 패널 4002) | jhsdw123/pnl-3d-studio | `~/Desktop/PNL-3D-Studio` | PJL-영상-길게-늘리기.command |
| UHD60 업스케일러 | jhsdw123/mac-uhd60-upscaler | (앱) | UHD60 업스케일러.app |

## 설치 — `tools/mac/맥-설치.sh` 한 번

1. 윈도우 PC 에서 USB 에 **`PJL-맥-이사`** 폴더를 담는다 (안에 `맥-설치.sh` + `비밀` 폴더:
   `.env.local`·`secrets/`·PNL `data/`). 비밀번호 파일이라 카톡·메일 말고 USB 로.
2. 맥 터미널: `bash ` 치고 USB 의 `맥-설치.sh` 를 끌어다 놓고 Enter.
3. 스크립트가 알아서: Homebrew·node·ffmpeg·python·gh·syncthing 설치 → 깃허브 로그인(처음 한 번) →
   코드 3개 받기 → 비밀 파일 넣기 → npm install·늘리기용 파이썬 환경(`.venv-mac`) →
   Syncthing 설정 → 바탕화면 실행 파일 3개.
4. 윈도우 PC 쪽에서 맥을 허락 (PC 의 Claude 에게 "맥 설치 끝났어", 또는 PC 브라우저 http://127.0.0.1:8384 의
   '새 장치' 알림 → [장치 추가] → 공유 폴더 PJLLoopvideo 체크).

다시 돌려도 안전하다 — 있는 것은 건너뛰고 코드는 최신으로 받는다. **코드를 고친 뒤 맥에 반영할 때도 이걸 다시 돌리면 된다.**

## 루프 영상 폴더 (Syncthing)

- 윈도우 `C:\Users\User\Desktop\PJLLoopvideo` ⇄ 맥 `~/PJLLoopvideo` (바탕화면 `PJLLoopvideo` 는 바로가기).
  맥은 백그라운드 프로그램이 '바탕화면' 폴더를 못 건드리게 막아서 실제 폴더를 홈에 둔다. 패널은 바로가기 경로로 읽는다.
- 맞추는 것: 루프 영상(원본+업스케일본)과 `.last-number`(루프 번호). **안 맞추는 것**: `30분완성본/`(수십 GB)·`.cache/`
  — 양쪽 `.stignore` 에 적혀 있다(이 파일은 동기화되지 않으니 양쪽에 같은 내용).
- 한쪽에서 지우면 다른 쪽도 지워진다. 실수 대비로 지워진 파일은 `.stversions/` 에 30일 보관.
- "사용됨" 판정은 DB 의 사용 시각과 **파일 수정 시각**을 비교한다 → Syncthing 은 수정 시각을 그대로 옮겨서 괜찮지만,
  손으로 복사하면 시각이 바뀌어 쓴 루프가 안 쓴 것으로 보일 수 있다. **루프는 Syncthing 으로만 옮길 것.**
- 두 컴퓨터가 동시에 켜져 있을 때 맞춰진다.

## 윈도우와 다른 점

- 녹화 창 '최상위 고정'은 윈도우 전용 — 맥에선 녹화 중 창을 가리지 않게 둘 것(브라우저는 백그라운드 절전을 끈 채로 켜진다).
- 예약 렌더 후 **전원 끄기**는 윈도우 전용.
- 서버가 켜져 있는 동안 맥은 잠들지 않는다(caffeinate). **뚜껑을 닫으면 잠드니** 밤샘 렌더는 뚜껑을 열어 둘 것.
- 처음 쓸 때 "터미널이 바탕화면 폴더(또는 USB)에 접근하려고 합니다" → [허용].

## 고칠 때 지킬 것 (코드)

- 경로는 `os.homedir()` 기준으로 — `C:\` 를 박지 말 것. 실행 명령은 `process.platform` 으로 갈라
  (`python`↔`python3`(맥은 `PNL-3D-Studio/.venv-mac` 우선), 휴지통, 폴더 열기 `explorer`↔`open -R`, 브라우저 `start`↔`open`).
- 맥에서 실행하는 `.command`/`.sh` 는 LF + 실행 권한(`git update-index --chmod=+x`).

## 트러블슈팅

| 증상 | 해결 |
|---|---|
| `❌ Supabase 설정 누락` | `.env.local` 이 패널 폴더에 없음 → USB 의 `비밀` 폴더를 `맥-설치.sh` 옆에 두고 다시 실행 |
| 루프 고르기 창이 비어 있음 | PC 에서 맥을 허락했는지, 두 컴퓨터가 켜져 있는지. 맥 http://127.0.0.1:8384 에서 진행률 확인 |
| 3시간 늘리기에서 numpy 오류 | `맥-설치.sh` 다시 실행 (`.venv-mac` 를 다시 만든다) |
| `.command` 더블클릭이 안 됨 | 터미널에서 `bash 파일이름.command` |
| YouTube 탭 "인증 필요" | Uploader 탭 → "YouTube 인증" (토큰은 기기마다 따로 발급돼도 된다) |
| 포트 4001 사용 중 | `lsof -i :4001` 로 확인 후 종료 |
