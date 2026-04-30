-- =============================================================================
-- Premium Jazz Lounge — Migration 0003: 영상 시리즈 + 빌더 연결
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--
-- 의존: 0001 (random_rpc), 0002 (templates), 그리고 supabase_schema 의 pjl_video_projects.
-- =============================================================================

-- 1) pjl_video_series — 시리즈 (예: "Late Night Jazz Vol. 1, 2, 3 ...")
create table if not exists pjl_video_series (
  id              bigserial primary key,
  name            text not null unique,
  description     text,
  current_vol     int not null default 0,        -- 마지막으로 발행한 vol 번호 (다음은 +1)
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists idx_pjl_video_series_name on pjl_video_series (name);

drop trigger if exists trg_pjl_video_series_updated_at on pjl_video_series;
create trigger trg_pjl_video_series_updated_at before update on pjl_video_series
  for each row execute function set_updated_at();

alter table pjl_video_series enable row level security;
drop policy if exists pjl_video_series_all on pjl_video_series;
create policy pjl_video_series_all on pjl_video_series for all to anon, authenticated using (true) with check (true);

-- 2) pjl_video_projects — 컬럼 추가 (시리즈 연결 + 템플릿 연결)
alter table pjl_video_projects
  add column if not exists series_id   bigint references pjl_video_series(id) on delete set null;

alter table pjl_video_projects
  add column if not exists template_id bigint references pjl_templates(id) on delete set null;

create index if not exists idx_pjl_videos_series on pjl_video_projects (series_id);
create index if not exists idx_pjl_videos_template on pjl_video_projects (template_id);
