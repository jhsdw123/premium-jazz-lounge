# Premium Jazz Lounge — 진척 노트

> 지금까지 무엇을 만들었고 무엇이 작동하는지. Phase 별 정리.

마지막 업데이트: 2026-04-30 (Phase 3-C-3 완료, Phase 4 진입 직전)

---

## 전체 로드맵

| Phase | 이름 | 상태 |
|---|---|---|
| 1 | Setup (레포 + DB) | ✅ 완료 |
| 2 | Bootstrap (Express + Supabase) | ✅ 완료 |
| 3-A | Track Upload API | ✅ 완료 |
| 3-B | Auto Analysis (ffprobe) | ✅ 완료 |
| 3-C-1 | Title Generation (Gemini) | ✅ 완료 |
| 3-C-2-A | Pool UI Bootstrap | ✅ 완료 |
| 3-C-2-B | Filters & Bulk Actions | ✅ 완료 |
| 3-C-2-C | Instruments + Random + Long Prompts | ✅ 완료 |
| 3-C-3 | Audio Preview | ✅ 완료 |
| 4 | Builder 탭 + Remotion 렌더 | ⏭ 다음 |
| 5 | Uploader 탭 + YouTube 자동화 | 📋 미정 |

---

## ✅ Phase 1: Setup

**커밋:** `850e4f0`, `e3abb14`, `3cacf47`

- GitHub 레포 생성 (`jhsdw123/premium-jazz-lounge`)
- 폴더 구조 (`server/`, `lib/`, `tools/`, `video/`, `data/`, `assets/`)
- Supabase 9개 테이블 (`pjl_` prefix) + RLS 정책 + Realtime publication
  - `pjl_prompts`, `pjl_instruments`, `pjl_titles`, `pjl_tracks`,
    `pjl_video_projects`, `pjl_video_tracks`, `pjl_video_translations`,
    `pjl_hashtag_archive`, `pjl_video_uploads`
- Storage bucket `pjl-jazz-tracks` 생성 (private)
- `tools/supabase_schema.sql` — 전체 DDL 단일 파일 (재실행 안전: `if not exists`)
- README.md, .gitignore, .env.local.example

**Why pjl_ prefix:** 같은 Supabase 인스턴스를 quiz / stock 프로젝트와 공유. prefix 없으면 충돌.

---

## ✅ Phase 2: Bootstrap

**커밋:** `1628bb0`, `36ef777`

- `server/control-panel/server.mjs` — Express 4001 포트
- `lib/supabase.mjs` — Service role 클라이언트, URL 정규화 (trailing `/rest/v1` 자동 제거)
- `lib/paths.mjs` — `__dirname` 헬퍼 + 자주 쓰는 경로
- `GET /api/health` — DB ping (head count) + Storage bucket 존재 확인
- `GET /api/stats` — 4개 테이블 카운트 + 제목 있는 트랙 / 사용된 트랙 derived count
- `.env.local` 절대경로 로드 (CWD 무관)
- `package.json` "type":"module", scripts: `dev` / `start` / `studio`

**검증:** `curl http://localhost:4001/api/health` → `{ok:true, db:..., storage:...}`

---

## ✅ Phase 3-A: Track Upload API

**커밋:** `c03cae2`

- `POST /api/tracks/upload` — multer memoryStorage, 5x50MB, 한 번에 여러 파일
  - 파일별 결과 (`uploaded` / `duplicate` / `error`) + 요약
  - `file_hash` 중복 검사 (sha256)
  - Storage 업로드 → DB insert → 실패 시 Storage rollback
- `GET /api/tracks` — 9가지 필터 (search, promptId, hasVocals, instrument, usedFilter, prefixOrder, min/maxDuration, from/toDate)
- `POST /api/tracks/delete` — soft delete (`is_active=false`) + Storage 파일 제거
- `GET /api/prompts`, `POST /api/prompts` — 프롬프트 라이브러리 CRUD
- `lib/storage.mjs` — `uploadTrack`, `deleteTrack`, `deleteTracks`, `getSignedUrl`
- `lib/track-utils.mjs` — `computeFileHash`, `parsePrefixOrder` (`1_`, `2-`, `3.` 패턴)

**핵심 결정:**
- multer memoryStorage (디스크 안 거치고 바로 Supabase Storage)
- prefix 1~5 만 인정 (영상 시작 부 고정 슬롯)
- Soft delete — 나중에 실수 복구 가능

---

## ✅ Phase 3-B: Auto Analysis (ffprobe)

**커밋:** `8fbd6ed`

- `lib/track-meta.mjs`
  - `analyzeTrack(buffer)` — ffprobe 로 duration / bitrate / channels
  - silencedetect 으로 앞/뒤 무음 trim → `duration_actual_sec`
  - BPM 추정 (libxtract 또는 fallback heuristic)
- `POST /api/tracks/backfill` — 분석 누락된 트랙 일괄 처리
  - `{limit: 50}` body 로 배치 크기 제어
  - 분석 실패는 row 별 격리 (전체 롤백 안 함)

**Why backfill:** 업로드 시 분석 실패해도 row 는 적재 (Storage 만 성공). 나중에 정리 가능하도록 `null` 채로 둠.

---

## ✅ Phase 3-C-1: Title Generation

**커밋:** `aeb054c`

- `lib/llm.mjs`
  - `callGemini(prompt, opts)` — `gemini-2.5-flash`, JSON response 강제 (`responseSchema`)
  - `parseTitlesJson(text)` — 코드펜스 제거 + JSON.parse + fallback
  - `generateTitleCandidates({promptText, avoidList, count, attempt})` — N개 후보, 실패 시 1회 재시도 (temperature 점증)
- `lib/title-utils.mjs`
  - `normalizeTitle(s)` — lowercase, stop word 제거, words[] 반환
  - `findCollision(candidate, existing)` — 2개 이상 의미 단어 겹치면 충돌
- `POST /api/titles/generate` — 단일 트랙용, 충돌 없는 제목 1개 할당
- `POST /api/titles/reroll` — 기존 제목 rejected 처리 후 새로 생성
- `POST /api/titles/bulk-generate` — N개 트랙 일괄 (4500ms throttle)

**핵심 결정:**
- `responseSchema` 강제 — 안 그러면 가끔 빈 객체 / null shape 반환
- Gemini 모델 `gemini-2.5-flash` — `2.0-flash-exp` deprecated
- 충돌 기준 "2개 이상 단어" — 1개는 너무 빡셈, 3개는 너무 느슨

**테스트:** `node tools/test-phase3c1.mjs`

---

## ✅ Phase 3-C-2-A: Pool UI Bootstrap

**커밋:** `5d82d4a`

- `server/control-panel/public/index.html` — 다크 배경 (`#0a0a0a`) + gold accent (`#d4af37`)
- 3 탭 레이아웃: **Pool** (active) / Builder / Uploader (skeleton)
- 드롭존 — 드래그&드롭 + 클릭 파일 선택, 다중 파일
- 업로드 진행률 (per-file: pending → uploading → done/dup/error)
- 트랙 리스트 — title, prompt, BPM, duration, instruments chips, 액션 버튼
- `app.js` — vanilla JS, 빌드 도구 없음

**Why vanilla JS:** 빌드 단계 없이 바로 수정 → 새로고침. 외부 의존성 0.

---

## ✅ Phase 3-C-2-B: Filters & Bulk Actions

**커밋:** `6d6c3ad`

- 9개 필터: search, promptId, hasVocals, instrument, usedFilter, prefixOrder, min/maxDuration, from/toDate
- 5개 정렬: newest / oldest / longest / shortest / most-used
- URL 쿼리 sync — 필터 상태 ↔ URL `?search=...&hasVocals=...`
- 일괄 액션: select all → retitle / backfill / delete
- 행별 액션: reroll (제목 재생성) / generate (제목 첫 할당) / delete

**Why URL sync:** 새로고침 후에도 필터 유지, 링크 공유 가능.

---

## ✅ Phase 3-C-2-C: Instruments + Random + Long Prompts

**커밋:** `aa42cbc`, `f8fd207`

- `lib/instruments.mjs` — 프롬프트 텍스트에서 악기 키워드 추출 → `pjl_instruments` aliases 매칭 → canonical_name[] 반환
- `POST /api/tracks/extract-instruments` — 기존 트랙 일괄 재추출
- `GET /api/instruments` — 마스터 리스트 (UI 필터 dropdown 용)
- `tools/migrations/0001_random_rpc_and_instruments.sql` (적용 완료)
  - `pjl_random_tracks(n)` Postgres RPC — `ORDER BY random()` 보다 효율
  - 초기 instruments seed (piano, sax, trumpet, bass, drums, guitar, ...)
- 긴 Suno 프롬프트용 textarea (input → textarea, 잘림 방지)
- 악기 chip 렌더링 fix (배열 정렬 + 빈 배열 처리)

**Why Postgres RPC for random:** 큰 테이블에서 `ORDER BY random()` 은 full scan. RPC 안에서 `tablesample` + offset 트릭 사용.

**테스트:** `node tools/test-phase3c2c.mjs`

---

## ✅ Phase 3-C-3: Audio Preview

**커밋:** `e5a6fe8`

- `GET /api/tracks/:id/audio-url` — Supabase signed URL (1시간 유효)
- 트랙 행에 ▶️ 재생 버튼
- Sticky bottom audio player — 곡명 + `<audio controls>` + 닫기 버튼
- 다른 트랙 재생 시 자동 교체 (signed URL 새로 발급)
- 재생 토글 — 같은 트랙 다시 누르면 멈춤

**Why signed URL:** bucket private 유지, 노출 1시간만. 외부 스크래핑 차단.

---

## 🎯 현재 상태 요약

- **Pool 탭 100% production-ready.** 업로드 → 분석 → 제목 생성 → 필터 → 미리듣기 → 정리, 전 과정 가능.
- **트랙 적재 가능 상태.** 형님이 Suno 곡 모은 만큼 바로 올려도 됨.
- **9개 테이블 모두 활성, RLS / Realtime 적용 완료.**
- **마이그레이션 1건 적용 완료** (`0001_random_rpc_and_instruments`).

다음은 `HANDOFF_NOTE.md` 참고.
