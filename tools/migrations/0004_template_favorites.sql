-- =============================================================================
-- Premium Jazz Lounge — Migration 0004: 템플릿 즐겨찾기 + 배경 이미지
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--
-- 의존: 0002 (templates).
-- =============================================================================

-- 즐겨찾기 컬럼 추가
alter table pjl_templates
  add column if not exists is_favorite boolean default false;

-- 정렬 인덱스 (즐겨찾기 우선 → 사용 빈도 높은 순)
create index if not exists idx_pjl_templates_favorite
  on pjl_templates (is_favorite desc, use_count desc);

-- 배경 이미지 URL (Loop 영상 첫 프레임 또는 정지 이미지)
alter table pjl_templates
  add column if not exists background_image_url text;
