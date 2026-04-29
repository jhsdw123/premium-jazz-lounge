-- =============================================================================
-- Premium Jazz Lounge — Supabase 스키마 (Phase 1)
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--
-- 주의: 모든 테이블에 `pjl_` prefix 적용 (quiz/stock 프로젝트와 동일 인스턴스 공유)
-- =============================================================================

-- 1) pjl_prompts: Suno 프롬프트 라이브러리 ─────────────────
create table if not exists pjl_prompts (
  id            bigserial primary key,
  prompt_text   text not null unique,
  nickname      text,
  use_count     int default 0,
  is_favorite   boolean default false,
  created_at    timestamptz default now()
);
create index if not exists idx_pjl_prompts_favorite on pjl_prompts (is_favorite);

-- 2) pjl_instruments: 악기 정규화 마스터 ───────────────────
create table if not exists pjl_instruments (
  id              bigserial primary key,
  canonical_name  text not null unique,
  aliases         text[] default '{}',
  created_at      timestamptz default now()
);

-- 3) pjl_titles: LLM 자동 생성 제목 풀 ─────────────────────
create table if not exists pjl_titles (
  id                bigserial primary key,
  title_en          text not null,
  normalized_words  text[] not null default '{}',
  status            text not null default 'available'
                    check (status in ('available','used','rejected')),
  use_count         int default 0,
  rejected_reason   text,
  generated_by      text default 'gemini',
  created_at        timestamptz default now(),
  last_used_at      timestamptz
);
create unique index if not exists idx_pjl_titles_lower on pjl_titles (lower(title_en));
create index if not exists idx_pjl_titles_status on pjl_titles (status);
create index if not exists idx_pjl_titles_normalized_gin on pjl_titles using gin (normalized_words);

-- 4) pjl_tracks: 곡 (Supabase Storage 연동) ────────────────
create table if not exists pjl_tracks (
  id                bigserial primary key,
  storage_path      text not null,
  storage_url       text,
  file_hash         text unique,
  original_filename text,
  title_id          bigint references pjl_titles(id) on delete set null,
  prompt_id         bigint references pjl_prompts(id) on delete set null,
  instruments       text[] default '{}',
  has_vocals        boolean default false,
  bpm               numeric(5,2),
  duration_raw_sec  numeric(8,2),
  duration_actual_sec numeric(8,2),
  prefix_order      smallint check (prefix_order between 1 and 5),
  used_count        int default 0,
  last_used_at      timestamptz,
  is_active         boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index if not exists idx_pjl_tracks_title on pjl_tracks (title_id);
create index if not exists idx_pjl_tracks_prompt on pjl_tracks (prompt_id);
create index if not exists idx_pjl_tracks_used on pjl_tracks (used_count, is_active);
create index if not exists idx_pjl_tracks_instruments_gin on pjl_tracks using gin (instruments);
create index if not exists idx_pjl_tracks_prefix on pjl_tracks (prefix_order);
create index if not exists idx_pjl_tracks_vocals on pjl_tracks (has_vocals);

-- 5) pjl_video_projects: 영상 프로젝트 ─────────────────────
create table if not exists pjl_video_projects (
  id              uuid primary key default gen_random_uuid(),
  build_id        text not null unique,
  title           text not null,
  volume          int default 1,
  track_ids       bigint[] not null,
  template_json   jsonb default '{}'::jsonb,
  loop_video_path text,
  dominant_color_hex text,
  status          text default 'draft'
                  check (status in ('draft','rendering','done','uploaded','failed')),
  total_duration_sec int,
  output_path     text,
  thumbnail_path  text,
  timeline_txt    text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists idx_pjl_videos_status on pjl_video_projects (status);
create index if not exists idx_pjl_videos_build on pjl_video_projects (build_id);

-- 6) pjl_video_tracks: 영상 ↔ 곡 N:M ──────────────────────
create table if not exists pjl_video_tracks (
  video_id   uuid references pjl_video_projects(id) on delete cascade,
  track_id   bigint references pjl_tracks(id) on delete restrict,
  position   smallint not null,
  start_sec  numeric(8,2) not null,
  end_sec    numeric(8,2) not null,
  primary key (video_id, position)
);
create index if not exists idx_pjl_video_tracks_track on pjl_video_tracks (track_id);

-- 7) pjl_video_translations: 16개 언어 번역 캐시 ───────────
create table if not exists pjl_video_translations (
  video_id      uuid references pjl_video_projects(id) on delete cascade,
  lang_code     text not null,
  title         text not null,
  description   text,
  tags          text[] default '{}',
  created_at    timestamptz default now(),
  primary key (video_id, lang_code)
);

-- 8) pjl_hashtag_archive: 톱4국 해시태그 (Phase 5에서 자동) ─
create table if not exists pjl_hashtag_archive (
  id              bigserial primary key,
  country_code    text check (country_code in ('JP','US','FR','IT')),
  tag             text not null,
  source_video_id uuid references pjl_video_projects(id) on delete set null,
  views_at_capture bigint,
  captured_at     timestamptz default now()
);
create index if not exists idx_pjl_hashtag_country on pjl_hashtag_archive (country_code, captured_at desc);

-- 9) pjl_video_uploads: YouTube 업로드 추적 (quiz 패턴 그대로) ─
create table if not exists pjl_video_uploads (
  id              uuid primary key default gen_random_uuid(),
  video_id        uuid references pjl_video_projects(id) on delete cascade,
  build_id        text not null,
  date_str        text not null,
  youtube_id      text,
  youtube_url     text,
  youtube_status  text default 'pending'
                  check (youtube_status in ('pending','uploading','processing','published','failed','scheduled')),
  privacy         text default 'private',
  scheduled_at    timestamptz,
  error_message   text,
  retry_count     int default 0,
  created_at      timestamptz default now(),
  uploaded_at     timestamptz,
  updated_at      timestamptz default now()
);
create index if not exists idx_pjl_uploads_status on pjl_video_uploads (youtube_status);
create index if not exists idx_pjl_uploads_video on pjl_video_uploads (video_id);

-- 10) updated_at 자동 갱신 트리거 ────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists trg_pjl_tracks_updated_at on pjl_tracks;
create trigger trg_pjl_tracks_updated_at before update on pjl_tracks
  for each row execute function set_updated_at();

drop trigger if exists trg_pjl_videos_updated_at on pjl_video_projects;
create trigger trg_pjl_videos_updated_at before update on pjl_video_projects
  for each row execute function set_updated_at();

drop trigger if exists trg_pjl_uploads_updated_at on pjl_video_uploads;
create trigger trg_pjl_uploads_updated_at before update on pjl_video_uploads
  for each row execute function set_updated_at();

-- 11) RLS (개인 사용 전제) ─────────────────────────────────
alter table pjl_tracks enable row level security;
alter table pjl_titles enable row level security;
alter table pjl_prompts enable row level security;
alter table pjl_instruments enable row level security;
alter table pjl_video_projects enable row level security;
alter table pjl_video_tracks enable row level security;
alter table pjl_video_translations enable row level security;
alter table pjl_hashtag_archive enable row level security;
alter table pjl_video_uploads enable row level security;

drop policy if exists pjl_tracks_all on pjl_tracks;
create policy pjl_tracks_all on pjl_tracks for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_titles_all on pjl_titles;
create policy pjl_titles_all on pjl_titles for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_prompts_all on pjl_prompts;
create policy pjl_prompts_all on pjl_prompts for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_instruments_all on pjl_instruments;
create policy pjl_instruments_all on pjl_instruments for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_video_projects_all on pjl_video_projects;
create policy pjl_video_projects_all on pjl_video_projects for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_video_tracks_all on pjl_video_tracks;
create policy pjl_video_tracks_all on pjl_video_tracks for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_video_translations_all on pjl_video_translations;
create policy pjl_video_translations_all on pjl_video_translations for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_hashtag_archive_all on pjl_hashtag_archive;
create policy pjl_hashtag_archive_all on pjl_hashtag_archive for all to anon, authenticated using (true) with check (true);

drop policy if exists pjl_video_uploads_all on pjl_video_uploads;
create policy pjl_video_uploads_all on pjl_video_uploads for all to anon, authenticated using (true) with check (true);

-- 12) Realtime publication ────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='pjl_video_projects')
  then alter publication supabase_realtime add table pjl_video_projects; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='pjl_video_uploads')
  then alter publication supabase_realtime add table pjl_video_uploads; end if;
end $$;
