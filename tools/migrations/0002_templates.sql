-- =============================================================================
-- Premium Jazz Lounge — Migration 0002: 템플릿 시스템
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--   3) 적용 후: PowerShell 에서 `node tools/seed-default-template.mjs` 실행
--
-- 의존: tools/supabase_schema.sql 의 set_updated_at() 함수.
-- =============================================================================

-- 영상 빌더용 템플릿 (비주얼라이저 색상/위치/폰트/스타일 프리셋)
create table if not exists pjl_templates (
  id              bigserial primary key,
  name            text not null unique,
  description     text,
  is_default      boolean default false,

  -- JSON: 모든 visual config (색상, 위치, 폰트, visualizer 스타일, progress bar 종류 등)
  config_json     jsonb not null default '{}'::jsonb,

  thumbnail_url   text,           -- 미리보기 (Phase 4-B 에서 자동 생성)
  use_count       int default 0,

  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists idx_pjl_templates_default on pjl_templates (is_default);

drop trigger if exists trg_pjl_templates_updated_at on pjl_templates;
create trigger trg_pjl_templates_updated_at before update on pjl_templates
  for each row execute function set_updated_at();

alter table pjl_templates enable row level security;

drop policy if exists pjl_templates_all on pjl_templates;
create policy pjl_templates_all on pjl_templates for all to anon, authenticated using (true) with check (true);
