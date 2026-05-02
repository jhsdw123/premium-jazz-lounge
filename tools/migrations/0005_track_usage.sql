-- =============================================================================
-- Premium Jazz Lounge — Migration 0005: 곡 사용 이력 (Phase 4-D-5-A)
-- 사용법:
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체 내용 붙여넣기 → Run
--
-- 의존: 0001 (pjl_tracks). pjl_tracks.used_count / last_used_at 은 초기 스키마에
--      이미 정의되어 있음 → 별도 ALTER 불필요.
--
-- 이 마이그레이션은 idempotent — 여러 번 실행해도 안전합니다.
-- =============================================================================

-- 1) 사용 이력 테이블 ──────────────────────────────────────
--   곡이 영상에 들어간 시점마다 한 row. (한 곡이 N 영상에 쓰였다면 N rows.)
--   track_id 는 bigint — pjl_tracks.id 의 bigserial 과 일치.
--   video_id 는 text — Studio 가 mp4 export 시 만드는 클라이언트 측 ID
--     (예: "vid_2026-05-02T13-20-00"). pjl_video_projects 와는 의도적으로 분리
--     (project 가 없는 직접 export 도 추적 가능).
create table if not exists pjl_track_usage (
  id              bigserial primary key,
  track_id        bigint not null references pjl_tracks(id) on delete cascade,
  video_id        text not null,
  track_position  smallint not null,
  used_at         timestamptz default now()
);

create index if not exists idx_pjl_track_usage_track on pjl_track_usage (track_id, used_at desc);
create index if not exists idx_pjl_track_usage_video on pjl_track_usage (video_id);

-- 2) used_count 원자적 증가 RPC ─────────────────────────────
--   supabase-js 에는 atomic increment 가 없어 SELECT → UPDATE 2-step 이 필요.
--   동시 녹화 두 건이 같은 곡을 카운트할 때 race 로 +1 손실 가능 → SQL 레벨 단일
--   문장으로 해결. 호출: supabase.rpc('pjl_increment_usage', { p_track_id: 123 }).
create or replace function pjl_increment_usage(p_track_id bigint)
returns void
language sql
as $$
  update pjl_tracks
     set used_count = coalesce(used_count, 0) + 1,
         last_used_at = now()
   where id = p_track_id;
$$;

grant execute on function pjl_increment_usage(bigint) to anon, authenticated, service_role;
