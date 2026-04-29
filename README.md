# 🎷 Premium Jazz Lounge — YouTube Jazz Channel Automation

24/7 재즈 YouTube 채널 자동화 파이프라인.
Suno 곡 → DB 적재 → 자동 영상 생성 → 16개 언어 번역 → YouTube 예약 업로드.

## 구성

```
premium-jazz-lounge/
├── server/control-panel/  ⚙️ Express 컨트롤 패널 (Pool / Builder / Uploader 3 tabs)
├── video/                 🎬 Remotion 영상 컴포지션 (재즈 비주얼라이저)
├── lib/                   📚 공유 모듈 (Supabase 클라이언트, paths, 시간 등)
├── tools/                 🛠 Supabase 스키마 + 마이그레이션 스크립트
├── data/                  📦 곡 파일 캐시 + 렌더 출력 (gitignore)
└── assets/                🎨 폰트 / Loop 영상 / 템플릿
```

## 워크플로우 (3단계)

### 1. 음악 풀 매니저 (Pool Tab)
- Suno 곡 드래그 & 드롭 → Supabase Storage 업로드
- LLM 자동 제목 할당 (reroll 가능)
- BPM, 길이, 악기, 보컬 유무 자동 분석
- 프롬프트별 / 길이별 / 사용여부별 / 날짜별 검색

### 2. 영상 빌더 (Builder Tab)
- Pool에서 13~15곡 선택 → 순서 정하기 (1~5번 prefix 고정, 나머지 셔플)
- 미리 저장한 템플릿 자동 적용
- Remotion 렌더 → 30분 영상 + 썸네일 + 타임라인

### 3. YouTube 업로더 (Uploader Tab)
- 16개 언어 자동 번역 (Gemini Pro / OpenAI)
- 일/미/프/이 톱4국 해시태그 자동 재사용
- 예약 업로드

## 로컬 실행

```bash
./start-jazz.command
  → localhost:3001 (Remotion Studio)
  → localhost:4001 (Control Panel)
```

## DB / 인프라

- **Supabase**: 곡/제목/프로젝트/업로드 메타데이터
- **Supabase Storage**: 곡 파일 (bucket: `jazz-tracks`)
- **로컬 캐시**: `data/tracks/` (선택적 동기화)

자세한 내용은 [`tools/supabase_schema.sql`](./tools/supabase_schema.sql) 참고.

## 환경 변수

`.env.local` (gitignore 됨):

```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
GEMINI_API_KEY=
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
```

## 라이선스

개인 프로젝트 — 외부 사용 금지.
