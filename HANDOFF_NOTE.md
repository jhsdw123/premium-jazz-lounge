# Premium Jazz Lounge — 인계 노트

> 새 세션에서 어디서 다시 시작할 것인지. **이거 먼저 읽고 작업 시작.**

마지막 업데이트: 2026-04-30

---

## 📍 현재 상태

- **Pool 탭 100% 완성.** 업로드 / 자동 분석 / Gemini 제목 생성 / 9개 필터 / 일괄 액션 / 오디오 미리듣기 모두 동작.
- **Phase 3 전체 완료, Phase 4 (Builder 탭) 진입 직전.**
- 마지막 커밋: `e5a6fe8` — Phase 3-C-3 final: Audio preview with sticky player
- 트랙 적재 가능 — 형님이 Suno 곡을 미리 모아두면 Phase 4 작업하면서 바로 테스트 데이터로 쓸 수 있음.

---

## ⏭ 다음 작업 — Phase 4: Builder 탭

영상 빌더 — Pool 에서 13~15곡 선택 → 순서 정하기 → 템플릿 적용 → Remotion 렌더 → 30분 영상.

### Sub-phase 계획

#### 4-A: 템플릿 시스템

JSON 기반 비주얼라이저 설정. 첫 템플릿 1개부터 시작.

- `assets/templates/jazz-classic.json` (또는 DB `pjl_video_projects.template_json`)
- 필드: `background_color`, `accent_color`, `font_family`, `visualizer_style`, `track_card_layout`
- 빌더 UI 에서 드롭다운으로 선택

**결정 대기:** 첫 템플릿 디자인 — 현재 jazz `index.html` 비주얼라이저 그대로 옮기기로 OK?

#### 4-B: Builder 탭 UI

- 곡 선택 (Pool 에서 다중 선택 → Builder 로 전송 또는 inline 선택)
- 순서 정하기 (drag handle, prefix 1~5 자동 상단 고정, 나머지 셔플 버튼)
- 템플릿 dropdown
- 총 길이 미리 계산 표시 (선택된 곡 duration 합)
- "렌더 시작" 버튼

#### 4-C: Remotion 컴포지션

- `video/src/Root.tsx` — 컴포지션 등록
- `video/src/JazzVideo/index.tsx` — 메인 컴포넌트
  - props: `tracks[]`, `template`, `loopVideoUrl`
  - `<Audio src={track.signed_url} />` × N (sequential timing)
  - 비주얼라이저 (현재 `index.html` Canvas → Remotion Canvas)
- `video/remotion.config.ts` — fps, dimensions (1920x1080)

**참고:** 현재 `video/` 폴더 비어있음 (`.gitkeep` 만). Phase 4-C 시작할 때 `npm install remotion @remotion/cli` 부터.

#### 4-D: 렌더 파이프라인

- `POST /api/builds` — `pjl_video_projects` insert + `pjl_video_tracks` 매핑
- `POST /api/builds/:id/render` — Remotion CLI 호출 (`npx remotion render ...`)
- `GET /api/builds/:id/progress` — SSE (Server-Sent Events) 진행률 스트림
- 출력: `data/renders/<build_id>.mp4`
- DB 상태 갱신: `draft → rendering → done` (실패 시 `failed`)

---

## 🚦 Phase 4 시작 전 형님이 결정해야 할 것

1. **첫 템플릿 디자인** — 현재 jazz `index.html` 비주얼라이저 그대로 Remotion 으로 옮기기?
   - Yes → 4-A 가 빨라짐 (디자인 그대로 포팅만)
   - No → 디자인 mockup 부터 다시
2. **영상 길이** — 자연스러운 25~35분 (정확히 30분 안 맞춤). 곡 개수로 컨트롤. 확정?
3. **Loop 영상 합성 방식** — Filmora 수동 유지 (Remotion 자동 합성 X). 확정?
   - 즉, Remotion 은 오디오+비주얼라이저만 렌더, Loop 배경은 별도 합성 단계.

---

## 🐛 발견된 버그 & 해결 (참고용)

다음 작업에서 비슷한 패턴 만나면 여기서 먼저 확인.

### `.env.local` 자동 로드 안 됨
- **증상:** `npm run dev` 다른 폴더에서 실행 시 `SUPABASE_URL undefined`
- **원인:** dotenv 가 CWD 기준으로 찾아서 (`process.cwd()/.env.local`)
- **해결:** `lib/supabase.mjs` 에서 `import.meta.url` 기준 절대경로로 명시 로드. ESM 호이스팅으로 어떤 모듈이 `process.env` 읽기 전에 평가됨.
- **교훈:** Node 모듈은 시스템 쉘 위치에 의존하면 안 됨. 항상 모듈 자기 위치 기준.

### file_hash 중복 검사 시 deleted 트랙과 충돌
- **증상:** Soft-delete 한 트랙 다시 업로드해도 "duplicate" 처리됨
- **원인:** `file_hash` UNIQUE 인데 soft-delete 는 row 안 지움
- **해결:** 중복 체크 쿼리에 `.eq('is_active', true)` 추가
- **교훈:** soft-delete 컬럼 있으면 모든 unique check 에 같이.

### Windows curl 업로드 — application/octet-stream MIME
- **증상:** Windows curl 로 mp3 업로드 시 "지원하지 않는 형식: application/octet-stream"
- **원인:** Windows curl 이 audio MIME 못 잡음
- **해결:** `isAllowedAudio()` 에서 octet-stream/empty MIME 일 때 확장자로 fallback (`AUDIO_EXTS` 리스트)
- **교훈:** MIME sniffing 은 클라이언트별로 다름. extension fallback 항상 준비.

### Gemini 모델 deprecated
- **증상:** 2026년 들어와서 `gemini-2.0-flash-exp` 호출 시 404
- **해결:** `gemini-2.5-flash` 로 변경 (`lib/llm.mjs:7`)
- **교훈:** `*-exp` suffix 모델은 언제든 죽음. stable suffix 만 쓰기.

### parseTitlesJson 잘못된 fallback
- **증상:** Gemini 응답이 `{"titles": [...]}` 가 아닌 다른 shape 일 때, 정규식 fallback 이 JSON key 이름 ("titles", "title") 까지 후보로 잡음
- **해결:** structure miss 시 즉시 `[]` 반환 (`lib/llm.mjs:78`). Regex fallback 은 JSON.parse 자체가 실패한 경우에만.
- **교훈:** Fallback 은 cascading 하지 말 것. 명확한 trigger 조건.

### 긴 Suno 프롬프트 잘림
- **증상:** UI 의 prompt input 이 `<input>` 이라 긴 프롬프트 잘림 + 줄바꿈 안 됨
- **해결:** `<textarea>` 로 교체
- **교훈:** Suno 프롬프트 길이 길어질 수 있음 (수백~천 자). 항상 textarea.

### Supabase nested embed + RPC 동시 호출 불가
- **증상:** `select('*, title:pjl_titles(*)')` + `.rpc()` 같은 쿼리에서 silently 빈 결과
- **해결:** 2-step query 로 분리 — 먼저 RPC 로 ID 받고, 그 다음 nested select 로 채우기
- **교훈:** Supabase JS 클라이언트는 builder 가 mutually exclusive 한 조합 있음. Postgres 직접 SQL 보다 보수적.

---

## 📚 Phase 4 시작 시 참고할 quiz 프로젝트 파일

quiz 레포의 Remotion 패턴이 가장 가까움. raw URL:

- https://raw.githubusercontent.com/jhsdw123/youtube-quiz/main/video/src/Root.tsx

그 외 (`Composition.tsx`, `audio/`, `scenes/`, `remotion.config.ts` 등) — 형님이 raw URL 추가로 제공해야 할 수도 있음. Phase 4-C 들어갈 때 미리 받아두기.

---

## 🔮 Phase 5 미리보기 (참고)

Builder 끝나고 들어갈 영역. 지금 결정 안 해도 됨.

- **Uploader 탭** — 16개 언어 자동 번역 (Gemini Pro), 톱4국 (JP/US/FR/IT) 해시태그 자동 재사용
- **YouTube Data API 인증** — OAuth 2.0 flow, refresh token 보관
- **과거 영상 메타데이터 수집** — 기존 채널 영상 가져와서 hashtag archive 채우기
- **예약 업로드** — `pjl_video_uploads.scheduled_at`, node-cron 으로 처리

---

## ▶️ 새 세션 시작 시 첫 단계

1. `CLAUDE.md` 읽기 (프로젝트 전체 이해)
2. 이 문서 (`HANDOFF_NOTE.md`) 읽기
3. `PROGRESS_NOTE.md` 읽기 (지금까지 무엇을 만들었나)
4. `npm run dev` → `http://localhost:4001` 열어서 현재 상태 확인
5. 형님에게 위의 **결정 대기 3건** (템플릿 / 길이 / Loop 합성) 확인 받고 Phase 4-A 시작
