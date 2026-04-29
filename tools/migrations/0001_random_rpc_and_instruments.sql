-- =============================================================================
-- Migration 0001 — pjl_random_tracks RPC + pjl_instruments seed
-- =============================================================================
-- 사용법:
--   Supabase Dashboard → SQL Editor → New query → 이 파일 전체 붙여넣기 → Run
--
-- 이 마이그레이션은 idempotent — 여러 번 실행해도 안전합니다.
-- (RPC 는 create or replace, instruments 는 on conflict do nothing)
-- =============================================================================

-- 1) 랜덤 정렬용 RPC ─────────────────────────────────────
--   supabase-js 의 .order() 는 SQL 표현식(random()) 미지원 → RPC 로 우회.
--   서비스 측에서 .rpc('pjl_random_tracks', {_limit: 100}).select(...) 형태로 호출.
create or replace function pjl_random_tracks(_limit int default 100)
returns setof pjl_tracks
language sql
stable
as $$
  select *
    from pjl_tracks
   where is_active = true
   order by random()
   limit _limit;
$$;

grant execute on function pjl_random_tracks(int) to anon, authenticated, service_role;

-- 2) 자주 쓰는 jazz 악기 시드 ────────────────────────────
--   canonical_name 자체는 자동으로 매칭에 포함되므로 aliases 에 다시 안 넣음.
--   alias 는 모두 소문자, 다중 단어 OK (word-boundary 매칭).
insert into pjl_instruments (canonical_name, aliases) values
  ('Saxophone',  array['sax','alto sax','tenor sax','baritone sax','soprano sax',
                       'alto saxophone','tenor saxophone','baritone saxophone','soprano saxophone']),
  ('Piano',      array['electric piano','rhodes','wurlitzer','grand piano','upright piano']),
  ('Bass',       array['upright bass','double bass','contrabass','acoustic bass',
                       'stand-up bass','standup bass']),
  ('Bass Guitar',array['bass guitar','electric bass']),
  ('Drums',      array['brushed drums','jazz drums','percussion','drum kit',
                       'cymbals','snare','hi-hat','hihat']),
  ('Guitar',     array['jazz guitar','electric guitar','nylon guitar','acoustic guitar']),
  ('Trumpet',    array[]::text[]),
  ('Trombone',   array[]::text[]),
  ('Clarinet',   array[]::text[]),
  ('Vibraphone', array['vibes','vibraphones']),
  ('Organ',      array['hammond','hammond organ','b3','b-3']),
  ('Flute',      array[]::text[]),
  ('Violin',     array['fiddle']),
  ('Cello',      array[]::text[]),
  ('Harmonica',  array['blues harp']),
  ('Synth',      array['synthesizer','keyboard','keys'])
on conflict (canonical_name) do nothing;
