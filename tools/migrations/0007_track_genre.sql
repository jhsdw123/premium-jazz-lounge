-- =============================================================================
-- Premium Jazz Lounge — Migration 0007: 곡 장르
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--
-- 배경: 2026-10-01 스윙 재즈 / 잔잔한 곡 / 보사노바 … 로 곡을 나눠 쓰기 위해 장르 칸 추가.
--      업로드할 때 반드시 고르게 한다 (PJL 3D Studio Pool). 기본값 = swing.
--      장르 목록은 서버 코드(lib/track-utils.mjs GENRES)가 관리 — DB 에 CHECK 제약은 두지 않는다
--      (나중에 장르를 늘릴 때 SQL 을 다시 돌릴 필요 없게).
--
-- 이 마이그레이션은 idempotent — 여러 번 실행해도 안전합니다.
-- =============================================================================

-- 1) 컬럼 추가 — 이미 있는 곡은 전부 'swing' 으로 채워진다
alter table pjl_tracks add column if not exists genre text not null default 'swing';

-- 2) 인덱스 (Pool 장르 필터)
create index if not exists idx_pjl_tracks_genre on pjl_tracks (genre);
