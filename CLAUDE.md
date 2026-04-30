# Premium Jazz Lounge — Claude 작업 지침

> 24/7 jazz YouTube 채널 자동화. Suno 곡 → Supabase → Remotion 렌더 → 16개 언어 번역 → YouTube 예약 업로드.

새 세션이라면 이 문서를 먼저 다 읽고, 그 다음 `PROGRESS_NOTE.md` (지금까지 무엇을 만들었나) 와 `HANDOFF_NOTE.md` (다음 작업 시작점) 를 읽어라.

---

## 폴더 구조

```
premium-jazz-lounge/
├── server/control-panel/        ⚙️ Express 컨트롤 패널 (Pool / Builder / Uploader 3 tabs)
│   ├── server.mjs               · 4001 포트, REST API, multer 업로드
│   └── public/                  · index.html (다크+gold), app.js (vanilla JS)
├── lib/                         📚 공유 모듈
│   ├── supabase.mjs             · Supabase 클라이언트 (절대경로 .env.local 로드)
│   ├── paths.mjs                · __dirname 헬퍼
│   ├── storage.mjs              · pjl-jazz-tracks bucket 업로드/삭제/signed URL
│   ├── track-utils.mjs          · file_hash, prefix_order 파서
│   ├── track-meta.mjs           · ffprobe + silencedetect 분석
│   ├── llm.mjs                  · Gemini 2.5-flash 호출 + JSON 파싱
│   ├── title-utils.mjs          · 제목 normalize + 2-word 충돌 검증
│   └── instruments.mjs          · 프롬프트 텍스트 → 정규화된 악기 추출
├── tools/                       🛠 마이그레이션 + 테스트 스크립트
│   ├── supabase_schema.sql      · Phase 1 초기 스키마 (9개 테이블 + RLS)
│   ├── migrations/
│   │   └── 0001_random_rpc_and_instruments.sql  · 적용 완료
│   └── test-phase3*.mjs         · Phase 별 통합 테스트
├── video/                       🎬 Remotion 컴포지션 (Phase 4 부터 채움)
├── data/                        📦 곡 파일 캐시 + 렌더 출력 (gitignore)
├── assets/                      🎨 폰트 / Loop 영상 / 템플릿
├── .env.local                   🔑 Supabase / Gemini 키 (gitignore)
├── start-jazz.bat / .command    ▶️ 실행 스크립트
└── package.json                 · "type":"module", Node 18+
```

---

## 기술 스택

| 영역 | 기술 |
|---|---|
| 서버 | Node.js 18+, Express, multer, cors, dotenv |
| DB | Supabase Postgres (jhsdw123 인스턴스, quiz/stock 과 공유) |
| Storage | Supabase Storage bucket `pjl-jazz-tracks` (private) |
| LLM | Gemini 2.5-flash (`gemini-2.5-flash`) — 무료 tier 15 RPM |
| 영상 | Remotion (Phase 4 부터) — port 3001 studio |
| 분석 | ffprobe + silencedetect (시스템 ffmpeg 필요) |
| 프론트 | vanilla JS + CSS (다크 배경 + gold accent), 빌드 도구 없음 |

---

## DB 스키마 — 9개 테이블 (모두 `pjl_` prefix)

| 테이블 | 역할 |
|---|---|
| `pjl_prompts` | Suno 프롬프트 라이브러리 (use_count, is_favorite) |
| `pjl_instruments` | 악기 정규화 마스터 (canonical_name, aliases[]) |
| `pjl_titles` | LLM 자동 생성 제목 풀 (status: available/used/rejected, normalized_words[] GIN) |
| `pjl_tracks` | 곡 메타 (Storage path, file_hash, instruments[], bpm, duration, prefix_order 1-5) |
| `pjl_video_projects` | 영상 프로젝트 (build_id, track_ids[], template_json, status) |
| `pjl_video_tracks` | 영상 ↔ 곡 N:M (position, start_sec, end_sec) |
| `pjl_video_translations` | 16개 언어 번역 캐시 (lang_code 별 title/description/tags[]) |
| `pjl_hashtag_archive` | 톱4국 해시태그 보관 (JP/US/FR/IT) |
| `pjl_video_uploads` | YouTube 업로드 추적 (youtube_status, scheduled_at) |

> 전체 DDL: `tools/supabase_schema.sql`. 추가 마이그레이션: `tools/migrations/`.

**`pjl_` prefix 는 절대 빠뜨리면 안 됨.** 같은 Supabase 인스턴스에 quiz / stock 프로젝트 테이블이 같이 있어서, prefix 없으면 충돌. 새 테이블/RPC/함수 만들 때 항상 `pjl_` 부터.

---

## 주요 명령어

```bash
# 컨트롤 패널 시작 (port 4001)
npm run dev
# 또는: ./start-jazz.command  (Mac)
#       start-jazz.bat        (Windows)

# Remotion Studio (Phase 4 부터, port 3001)
npm run studio

# 헬스체크
curl http://localhost:4001/api/health

# 통계 (트랙 수, 제목 수, 업로드 수 등)
curl http://localhost:4001/api/stats

# 단일 트랙 분석 백필 (BPM / duration 누락 시)
curl -X POST http://localhost:4001/api/tracks/backfill -H "Content-Type: application/json" -d '{"limit":50}'

# 통합 테스트 (Phase 3-C-1 = 제목 생성)
node tools/test-phase3c1.mjs

# 통합 테스트 (Phase 3-C-2-C = random RPC + instruments)
node tools/test-phase3c2c.mjs
```

---

## 중요 규칙 (지키지 않으면 깨짐)

1. **모든 Supabase 테이블/함수에 `pjl_` prefix.** quiz/stock 인스턴스 공유 중. 예외 없음.
2. **Storage bucket 은 `pjl-jazz-tracks` (private).** 외부 노출 금지 — 항상 signed URL 로 서빙. 환경변수 `SUPABASE_STORAGE_BUCKET` 로 override 가능.
3. **Gemini 모델은 `gemini-2.5-flash`.** `2.0-flash-exp` 는 deprecated — 2026년 이후 호출하면 404. 환경변수 `GEMINI_MODEL` 로 override 가능.
4. **Gemini RPM 무료 15/min — 호출 사이 4500ms sleep 필수.** 일괄 생성 (`/api/titles/bulk-generate`) 에서는 항상 throttle. 안 그러면 429 폭탄.
5. **`.env.local` 자동 로드는 `lib/supabase.mjs` 에서 절대경로로 처리.** CWD 무관하게 동작해야 함 (cron / 다른 폴더에서 require 되어도). `process.env` 를 다른 모듈에서 읽기 전에 이 모듈이 import 되어야 함 (ESM 호이스팅 활용).
6. **`file_hash` 중복 검사는 항상 `is_active=true` 조건과 같이.** 삭제된 (soft-delete) 트랙과 충돌 방지.
7. **Supabase nested embed (`select: '*, title:pjl_titles(*)'`) 와 RPC 동시 호출 금지.** 둘 중 하나만. 같이 쓰면 silently 빈 결과 반환됨 → 2-step query 로.
8. **MIME `application/octet-stream` fallback 처리.** Windows curl 이 audio 파일에 octet-stream 을 줌 → `fileFilter` 에서 확장자로 fallback (`AUDIO_EXTS` 리스트, `server.mjs:115`).

---

## 형님(Dexter) 선호 — 작업 스타일

- **한국어 직설적 답변.** 인사말, 사과, 추임새 빼고 본론부터.
- **단계별 확인 후 진행.** 큰 변경은 먼저 계획 보여주고 OK 받고 실행. 작은 fix 는 바로.
- **액션 우선.** "할까요?" 보다는 "이렇게 했음 / 이거 하면 됨" 패턴.
- **Phase 분할 작업.** 한 번에 한 sub-phase 완료 → 커밋 → 다음. 절대 여러 phase 섞지 말 것.
- **테스트 스크립트로 검증.** 큰 변경 후 항상 `tools/test-*.mjs` 추가하거나 기존 것 실행.

---

## 외부 참조

| 리소스 | URL |
|---|---|
| 참고 패턴 레포 | https://github.com/jhsdw123/youtube-quiz (CLAUDE.md / HANDOFF / PROGRESS 패턴 원본) |
| 본 레포 | https://github.com/jhsdw123/premium-jazz-lounge |
| Supabase Dashboard | https://supabase.com/dashboard (프로젝트 jhsdw123, quiz/stock 공유) |
| Gemini API 문서 | https://ai.google.dev/gemini-api/docs (모델 ID, RPM 한도) |

---

## 다음 작업

`HANDOFF_NOTE.md` 참고. 현재는 Phase 3 (Pool 탭) 100% 완료, **Phase 4 (Builder 탭) 진입 직전.**
