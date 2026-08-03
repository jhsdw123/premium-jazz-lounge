# 🍎 맥북 셋업 지시서 — Premium Jazz Lounge

> **맥북 Claude Code에게:** 이 파일을 처음부터 끝까지 읽고, 아래 단계를 **네가 알아서 순서대로 실행**해라.
> 목표는 "형님이 윈도우 데스크탑에서 쓰던 이 프로젝트를 맥북에서 100% 똑같이 돌아가게 만드는 것"이다.
> 중간에 **형님(사용자)의 입력이 필요한 지점**은 `🙋 [형님 확인]` 으로 표시해뒀다. 그 지점에서는 멈추고 물어봐라.
> 나머지는 네가 알아서 진행하고, 각 단계 끝나면 결과를 한 줄로 보고해라. 한국어로, 본론부터.

---

## 0. 이 프로젝트가 뭔지 (배경)

- Node.js(Express) 기반 YouTube 재즈 채널 자동화 컨트롤 패널. 포트 **4001**.
- **데이터(곡 / 제목 / 프로젝트 / 업로드 기록)는 전부 클라우드(Supabase)에 있다.** 로컬 DB 없음.
  → 그래서 맥북에서 띄우면 **데스크탑과 똑같은 데이터가 그대로 보인다.** 이게 정상이고, 셋업 성공의 증거다.
- 윈도우 의존 코드 없음(ffmpeg는 PATH로 호출, 경로는 전부 `node:path`). 맥에서 그대로 돈다.
- 코드 작업 규칙은 clone 후 생기는 `CLAUDE.md` / `HANDOFF_NOTE.md` / `PROGRESS_NOTE.md` 에 있다. 셋업 끝나면 그것도 읽어둬라.

---

## 1. 필수 도구 설치/확인

아래를 순서대로 확인하고, 없는 것만 설치해라.

```bash
brew -v          # Homebrew (없으면 아래 한 줄로 설치)
node -v          # v18 이상이어야 함
ffmpeg -version  # 곡 길이/무음 분석에 필수
ffprobe -version
git --version
```

- **Homebrew 없으면:**
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
- **Node 18+ 없으면:** `brew install node`
- **ffmpeg 없으면:** `brew install ffmpeg`  ← **이거 빼먹으면 곡 분석 기능이 죽는다. 꼭 확인.**

---

## 2. 코드 가져오기

```bash
cd ~/Desktop          # 원하는 위치 (형님이 다른 곳 원하면 거기로)
git clone https://github.com/jhsdw123/premium-jazz-lounge.git
cd premium-jazz-lounge
```

🙋 **[형님 확인]** 이 레포가 **private** 일 수 있다. `Authentication failed` 또는 권한 오류가 나면:
- 형님에게 "맥북에서 GitHub 로그인이 필요하다"고 알리고, 터미널에 `! gh auth login` 을 직접 실행하라고 안내해라 (없으면 `brew install gh` 먼저).
- 또는 형님이 데스크탑 폴더를 통째로 옮겼다면 clone 생략하고 그 폴더로 진입.

---

## 3. 의존성 설치

```bash
npm install
```

- ⚠️ **윈도우의 `node_modules` 를 복사해 오지 마라.** 반드시 맥에서 새로 설치한다.
- 설치 후 에러 없으면 통과.

---

## 4. 🔑 비밀 파일 배치 + 잘린 키 복원  ← **여기가 핵심, 형님 개입 필요**

형님이 **이메일로** 비밀 정보를 보냈다. **보안을 위해 각 키 값의 맨 앞 2~3글자를 일부러 지운 채로** 보냈다.
→ 그 빠진 앞부분은 **형님이 외우고 있고, 직접 입력**한다.

### 4-1. `.env.local` 배치
형님이 보낸 `.env.local` 내용을 프로젝트 루트(`premium-jazz-lounge/.env.local`)에 저장해라.
형님이 텍스트로만 줬으면 네가 파일을 만들어라.

### 4-2. 잘린 값 채우기
`.env.local` 을 열어서, **값의 앞부분이 잘려 있는 키**들을 찾아라. 보통 아래 민감 키들이 잘려 있다:

| 채워야 할 가능성 높은 키 (시크릿) | 안 건드려도 되는 키 (공개/고정값) |
|---|---|
| `SUPABASE_SERVICE_KEY` | `SUPABASE_URL` (보통 그대로) |
| `S3_SECRET_ACCESS_KEY` (R2 시크릿) | `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_BUCKET` (R2, 보통 그대로) |
| `GEMINI_API_KEY` | `SUPABASE_STORAGE_BUCKET=pjl-jazz-tracks` |
| `OPENAI_API_KEY` (있으면) | `PORT=4001` |
| `YOUTUBE_CLIENT_ID` | `YOUTUBE_REDIRECT_URI=http://localhost:4001/auth/youtube/callback` |
| `YOUTUBE_CLIENT_SECRET` | `YOUTUBE_TOKEN_PATH=secrets/youtube-token.json` |

처리 방법 — **형님이 편한 쪽 하나** 골라서 진행:
- **(A) 형님이 직접 편집:** `nano .env.local` 또는 편집기로 열어서 각 잘린 값의 앞부분을 직접 채운다. (형님이 "이게 편하다" 하면 이 방식)
- **(B) 네가 도와서 채움:** 잘린 키를 하나씩 짚어주고("`SUPABASE_SERVICE_KEY` 값이 `Jhb…` 로 시작하는데 앞에 뭐가 빠졌어?") 형님 답을 받아 앞에 붙여 저장.

⚠️ **주의:** 채우는 동안 키 전체 값을 터미널에 `echo` 하거나 어디로도 전송하지 마라. 로컬 파일 편집만.
💡 참고: Supabase service key 는 `eyJ…` (JWT 표준 prefix) 로 시작한다. 형님이 `eyJ` 가 아니라 그 **뒤쪽 의미있는 글자**를 뺐을 수 있으니, 어디가 빠졌는지 형님에게 확인해라.

### 4-3. YouTube 인증 토큰 (`secrets/`)
**기본 권장 = 맥에서 재인증** (토큰 파일을 안 받아도 됨):
- 6번에서 서버를 띄운 뒤 브라우저 `localhost:4001` → **Uploader 탭 → "YouTube 인증" 버튼** → 구글 로그인/동의 →
  자동으로 `secrets/youtube-token.json` 이 생성된다. (데스크탑 토큰에는 영향 없다. 기기별로 따로 발급됨)
- 전제: 4-2에서 `YOUTUBE_CLIENT_ID/SECRET` 가 제대로 채워져 있어야 한다.
- redirect URI 는 데스크탑과 동일한 `http://localhost:4001/...` 이라 Google Cloud Console에 **추가 등록 불필요**.

🙋 **[형님 확인]** 만약 형님이 `secrets/youtube-token.json` (그리고 `youtube-oauth.json`)도 이메일로 보냈다면:
- 그 파일들을 `premium-jazz-lounge/secrets/` 안에 그대로 넣어라(폴더 없으면 `mkdir -p secrets`).
- 단, 토큰 파일도 앞글자가 잘려 있으면 JSON이 깨지기 쉽다 → 그럴 땐 **그냥 위의 재인증 방식**으로 가라.
- `secrets/yt-backups/` 는 과거 업로드 메타 백업이라 **작동에 필수 아님**. 있으면 같이 넣고, 없어도 무방.

---

## 5. 검증 (셋업이 진짜 됐는지 확인)

서버를 백그라운드로 띄우고 확인해라:

```bash
npm run dev    # 포트 4001
```

다른 셸에서:
```bash
curl http://localhost:4001/api/health    # ok / 200 이면 통과
curl http://localhost:4001/api/stats     # 트랙 수·제목 수 등이 나오면 = 클라우드 DB 연결 성공
```

- `/api/stats` 숫자가 나오면 **데스크탑과 같은 데이터에 붙은 것** = 성공.
- ffmpeg 확인: `which ffmpeg && which ffprobe` 둘 다 경로가 나오면 OK.
- 브라우저로 `http://localhost:4001` 열어서 Pool / Builder / Uploader 3개 탭이 정상 표시되는지 봐라.

---

## 6. 실행 (평소 사용법)

```bash
npm run dev
# 또는:
chmod +x start-jazz.command   # 최초 1회 권한 부여
./start-jazz.command          # 더블클릭으로도 실행 가능
```
→ 브라우저에서 **http://localhost:4001**

> 데스크탑과 맥북을 **동시에 켜도 된다** (둘 다 같은 클라우드 DB). 같은 영상을 동시에 편집/업로드만 피하면 충돌 없음.

---

## 7. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `❌ Supabase 설정 누락` | `.env.local` 이 루트에 없거나 키가 안 채워짐 → 4번 다시 |
| Supabase 401/403 | `SUPABASE_SERVICE_KEY` 앞부분 잘못 채움 → 형님께 재확인 |
| `ffmpeg/ffprobe spawn 실패` | `brew install ffmpeg` 안 됨 → 설치 후 터미널 재시작 |
| 곡 길이/BPM 분석 안 됨 | 위와 동일(ffmpeg PATH 문제) |
| YouTube 탭에서 "인증 필요" | 4-3 재인증 진행 |
| `start-jazz.command` 더블클릭 안 됨 | 윈도우 줄바꿈(CRLF) 문제 → `chmod +x` 하거나 그냥 `npm run dev` |
| `git clone` 권한 오류 | private 레포 → `gh auth login` (2번 참고) |
| 포트 4001 사용 중 | `lsof -i :4001` 로 기존 프로세스 확인 후 종료, 또는 `.env.local` 의 `PORT` 변경 |

---

## 8. 다 끝나면

형님에게 이렇게 보고해라:
- ✅ 설치된 것 (node 버전, ffmpeg 버전)
- ✅ `/api/stats` 결과 (트랙 수 등 — 데스크탑과 일치하는지)
- ✅ YouTube 인증 상태 (재인증 했는지 / 토큰 파일 썼는지)
- ⚠️ 막힌 게 있으면 정확히 어디서 멈췄는지

그리고 **`CLAUDE.md` 를 읽고** 앞으로의 코드 작업 규칙(특히 `pjl_` 테이블 prefix, Gemini RPM throttle 등)을 숙지해라.
