-- =============================================================================
-- Premium Jazz Lounge — Migration 0006: 곡 생성 툴 + 생성 당시 원제목
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--
-- 배경: 2026-09-20 부터 곡 생성 툴을 Suno → Mureka 로 교체. Mureka 는 곡 제목을
--      자동으로 붙여 내보내는데, 영상에 쓰는 제목은 Gemini 가 새로 짓는다(pjl_titles).
--      나중에 Mureka 사이트에서 옛 곡을 찾으려면 "생성 당시 제목" 이 필요 → 따로 보관.
--
-- 이 마이그레이션은 idempotent — 여러 번 실행해도 안전합니다.
-- =============================================================================

-- 1) 컬럼 추가 ─────────────────────────────────────────────
--   source_tool  : 곡을 만든 툴. 'suno' | 'mureka' | 'other'
--                  default 'suno' → 이 시점까지 올라가 있던 곡은 전부 Suno 산.
--                  (새 업로드는 서버가 항상 값을 명시하므로 default 에 기대지 않음.)
--   source_title : 생성 툴에서의 곡 제목 (보통 파일명에서 확장자 뗀 것).
alter table pjl_tracks add column if not exists source_tool  text not null default 'suno';
alter table pjl_tracks add column if not exists source_title text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pjl_tracks_source_tool_check'
  ) then
    alter table pjl_tracks
      add constraint pjl_tracks_source_tool_check
      check (source_tool in ('suno', 'mureka', 'other'));
  end if;
end $$;

-- 2) 기존 곡 backfill ──────────────────────────────────────
--   source_title 이 빈 곡만: original_filename 에서 확장자 제거.
update pjl_tracks
   set source_title = regexp_replace(original_filename, '\.[A-Za-z0-9]{2,5}$', '')
 where source_title is null
   and original_filename is not null;

-- 3) 인덱스 ────────────────────────────────────────────────
create index if not exists idx_pjl_tracks_source_tool on pjl_tracks (source_tool);
