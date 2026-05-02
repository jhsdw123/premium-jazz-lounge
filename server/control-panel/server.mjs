import { config } from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// .env.local 명시적 로드. lib/supabase.mjs 도 자체 로드하므로 (ESM 호이스팅으로
// 어차피 그쪽이 먼저 평가됨) 이건 server.mjs 본문에서 process.env 를 직접 읽는
// 코드(예: PORT)를 위한 안전망.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../.env.local') });

import { supabase, SUPABASE_BUCKET, SUPABASE_URL } from '../../lib/supabase.mjs';
import { controlPanelPublic } from '../../lib/paths.mjs';
import { uploadTrack, deleteTrack, deleteTracks, getSignedUrl } from '../../lib/storage.mjs';
import { computeFileHash, parsePrefixOrder } from '../../lib/track-utils.mjs';
import { analyzeTrack } from '../../lib/track-meta.mjs';
import { generateTitleCandidates } from '../../lib/llm.mjs';
import {
  normalizeTitle, findCollision,
  firstContentWord, buildWordFrequency, findHeavilyUsedWords, findUsedFirstWords,
} from '../../lib/title-utils.mjs';
import { detectInstruments } from '../../lib/instruments.mjs';
import { callGemini, parseTitlesJson } from '../../lib/llm.mjs';
import { processBackground } from '../../lib/template-bg.mjs';
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';

const PORT = parseInt(process.env.PORT, 10) || 4001;
const VERSION = '0.2.0';

const app = express();

// Phase 4-D-5-C: 요청 로거 — 매 응답마다 색상 코드 + 시각 + 메서드 + 경로 + 상태 + 소요 ms.
//   morgan 의존성 회피 (package.json 변경 X). 디버깅 시 어떤 요청이 들어왔고 어디서 깨지는지
//   서버 콘솔만 보고 즉시 파악 가능. 색상은 ANSI escape — Windows Terminal / VSCode / iTerm 모두 지원.
app.use((req, _res, next) => {
  const res = _res;
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const color = status >= 500 ? '\x1b[31m'        // red
                : status >= 400 ? '\x1b[33m'        // yellow
                : status >= 300 ? '\x1b[36m'        // cyan
                : '\x1b[32m';                       // green
    const reset = '\x1b[0m';
    const t = new Date().toISOString().slice(11, 23);
    console.log(`${color}[${t}] ${req.method.padEnd(4)} ${status} ${ms.toString().padStart(4)}ms ${req.originalUrl}${reset}`);
  });
  next();
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(controlPanelPublic));

// ─── Routes ──────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(resolve(controlPanelPublic, 'index.html'));
});

app.get('/api/health', async (_req, res) => {
  const result = { ok: false, version: VERSION, db: null, storage: null };

  // DB ping: count head query on pjl_tracks
  try {
    const { error } = await supabase
      .from('pjl_tracks')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    result.db = { ok: true, table: 'pjl_tracks' };
  } catch (e) {
    result.db = { ok: false, error: e.message };
  }

  // Storage bucket existence check
  try {
    const { data, error } = await supabase.storage.getBucket(SUPABASE_BUCKET);
    if (error) throw error;
    result.storage = { ok: true, bucket: data.name, public: data.public };
  } catch (e) {
    result.storage = { ok: false, bucket: SUPABASE_BUCKET, error: e.message };
  }

  result.ok = result.db?.ok === true && result.storage?.ok === true;
  res.status(result.ok ? 200 : 503).json(result);
});

app.get('/api/stats', async (_req, res) => {
  const tables = ['pjl_tracks', 'pjl_titles', 'pjl_prompts', 'pjl_video_projects'];
  const stats = {};
  const errors = {};

  await Promise.all(tables.map(async (t) => {
    const { count, error } = await supabase
      .from(t)
      .select('id', { count: 'exact', head: true });
    if (error) errors[t] = error.message;
    stats[t] = count ?? 0;
  }));

  // 추가: 제목 있는 트랙 / 영상에 사용된 트랙 카운트 (Pool 탭 표시용)
  let tracksWithTitle = 0;
  let tracksUsed = 0;
  try {
    const [a, b] = await Promise.all([
      supabase.from('pjl_tracks').select('id', { count: 'exact', head: true })
        .not('title_id', 'is', null).eq('is_active', true),
      supabase.from('pjl_tracks').select('id', { count: 'exact', head: true })
        .gt('used_count', 0).eq('is_active', true),
    ]);
    tracksWithTitle = a.count ?? 0;
    tracksUsed = b.count ?? 0;
    if (a.error) errors.tracksWithTitle = a.error.message;
    if (b.error) errors.tracksUsed = b.error.message;
  } catch (e) {
    errors.derived = e.message;
  }

  res.json({
    ok: Object.keys(errors).length === 0,
    stats,
    tracksWithTitle,
    tracksUsed,
    errors,
  });
});

// ─── Tracks: upload / list / delete ──────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 5 },
});

// 오디오 허용 검사: MIME 우선, 일부 클라이언트(브라우저/CLI)가 전달하는
// application/octet-stream 또는 빈 MIME 도 확장자로 fallback 허용.
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.oga', '.aac', '.opus', '.mp4', '.aiff', '.wma'];
function isAllowedAudio(file) {
  const mt = (file?.mimetype || '').toLowerCase();
  if (mt.startsWith('audio/')) return true;
  if (mt === 'video/mp4') return true;
  // MIME 누락/일반 → 확장자로 판단
  if (!mt || mt === 'application/octet-stream' || mt === 'application/x-empty') {
    const name = (file?.originalname || '').toLowerCase();
    return AUDIO_EXTS.some((ext) => name.endsWith(ext));
  }
  return false;
}

function parseIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// multer 자체 에러를 JSON 으로 변환하는 wrapper
function uploadMiddleware(req, res, next) {
  upload.array('files', 5)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, error: `multer: ${err.code} (${err.message})` });
    }
    if (err) return res.status(400).json({ ok: false, error: err.message });
    next();
  });
}

app.post('/api/tracks/upload', uploadMiddleware, async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'files 필드에 파일이 없습니다' });
    }

    let promptId = parseIntOrNull(req.body.promptId);
    const promptText = (req.body.promptText || '').trim();
    const hasVocals = req.body.hasVocals === 'true' || req.body.hasVocals === true;

    // promptText 만 주어지면 upsert 후 promptId 채움
    if (!promptId && promptText) {
      const { data: pdata, error: perr } = await supabase
        .from('pjl_prompts')
        .upsert({ prompt_text: promptText }, { onConflict: 'prompt_text' })
        .select('id')
        .single();
      if (perr) return res.status(500).json({ ok: false, error: `prompt upsert: ${perr.message}` });
      promptId = pdata.id;
    }

    // 악기 자동 추출용 prompt_text 확보 — 명시적 promptText 우선,
    // 없으면 promptId 로 DB 에서 조회. 한 번만 fetch 해서 모든 파일에 공유.
    let resolvedPromptText = promptText;
    if (!resolvedPromptText && promptId) {
      const { data: pr } = await supabase
        .from('pjl_prompts')
        .select('prompt_text')
        .eq('id', promptId)
        .maybeSingle();
      resolvedPromptText = pr?.prompt_text || '';
    }
    const inferredInstruments = await detectInstruments(resolvedPromptText);

    const results = [];
    let uploaded = 0, duplicates = 0, errors = 0;

    for (const file of files) {
      const filename = file.originalname;
      try {
        if (!isAllowedAudio(file)) {
          results.push({ filename, status: 'error', error: `지원하지 않는 형식: ${file.mimetype}` });
          errors++;
          continue;
        }

        const fileHash = computeFileHash(file.buffer);

        // 중복 체크: file_hash + is_active=true
        const { data: dup, error: dupErr } = await supabase
          .from('pjl_tracks')
          .select('id')
          .eq('file_hash', fileHash)
          .eq('is_active', true)
          .maybeSingle();
        if (dupErr) throw new Error(`중복 검사 실패: ${dupErr.message}`);
        if (dup) {
          results.push({ filename, status: 'duplicate', existingTrackId: dup.id });
          duplicates++;
          continue;
        }

        // Storage 업로드
        const { path: storagePath, publicUrl } = await uploadTrack(
          file.buffer, filename, file.mimetype
        );

        // 분석 — 격리된 try/catch.
        // ffprobe/silencedetect 실패해도 DB row 는 null 로 적재 (backfill 로 회복).
        let bpm = null, durationRawSec = null, durationActualSec = null;
        let analyzeError = null;
        try {
          const meta = await analyzeTrack(file.buffer);
          bpm = meta.bpm;
          durationRawSec = meta.durationRawSec;
          durationActualSec = meta.durationActualSec;
        } catch (e) {
          analyzeError = e.message;
          console.warn(`[upload] analyzeTrack 실패 (${filename}): ${e.message}`);
        }
        const prefixOrder = parsePrefixOrder(filename);

        // DB insert (실패 시 Storage rollback)
        const { data: track, error: insErr } = await supabase
          .from('pjl_tracks')
          .insert({
            storage_path: storagePath,
            storage_url: publicUrl,
            file_hash: fileHash,
            original_filename: filename,
            prompt_id: promptId,
            has_vocals: hasVocals,
            prefix_order: prefixOrder,
            bpm,
            duration_raw_sec: durationRawSec,
            duration_actual_sec: durationActualSec,
            instruments: inferredInstruments,
          })
          .select('id')
          .single();
        if (insErr) {
          await deleteTrack(storagePath).catch(() => {});
          throw new Error(`DB insert 실패: ${insErr.message}`);
        }

        results.push({
          filename,
          status: 'uploaded',
          trackId: track.id,
          storagePath,
          duration_raw_sec: durationRawSec,
          duration_actual_sec: durationActualSec,
          instruments: inferredInstruments,
          ...(analyzeError ? { analyzeWarning: analyzeError } : {}),
        });
        uploaded++;
      } catch (e) {
        results.push({ filename, status: 'error', error: e.message });
        errors++;
      }
    }

    res.json({
      ok: true,
      results,
      summary: { uploaded, duplicates, errors },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/tracks', async (req, res) => {
  try {
    const {
      ids, search, promptId, hasVocals, instrument,
      usedFilter = 'all', prefixOrder = 'any',
      minDuration, maxDuration, fromDate, toDate,
      limit = 100, orderBy = 'newest',
    } = req.query;

    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);

    let q = supabase
      .from('pjl_tracks')
      .select(`
        *,
        title:pjl_titles(id, title_en, status),
        prompt:pjl_prompts(id, prompt_text, nickname)
      `)
      .eq('is_active', true);

    if (ids) {
      const idArr = String(ids).split(',').map((s) => parseIntOrNull(s.trim())).filter((n) => n != null);
      if (idArr.length) q = q.in('id', idArr);
    }

    // orderBy=random — Postgres 측 random() (pjl_random_tracks RPC).
    // 1) RPC 로 최대 500 개 random ID 추출
    // 2) 메인 쿼리에 .in('id', ids) 로 제약 + 다른 필터 그대로 적용
    // 3) fetch 후 JS 에서 RPC 순서대로 reorder + lim slice
    // RPC 미적용 환경 fallback: 마지막 단계의 JS shuffle.
    let useRpcRandom = orderBy === 'random';
    let randomOrderedIds = null;
    if (useRpcRandom) {
      try {
        const { data: rndRows, error: rpcErr } = await supabase
          .rpc('pjl_random_tracks', { _limit: 500 });
        if (rpcErr) throw rpcErr;
        randomOrderedIds = (rndRows || []).map((r) => r.id);
        if (randomOrderedIds.length === 0) {
          return res.json({ ok: true, count: 0, tracks: [] });
        }
        q = q.in('id', randomOrderedIds);
      } catch (e) {
        console.warn('[random] pjl_random_tracks RPC unavailable — JS shuffle fallback:', e.message);
        useRpcRandom = false;
      }
    }

    // 검색: filename + title_en 양쪽 ilike.
    // title_en 은 join 한 테이블 컬럼이라 PostgREST or() 한 줄로 검색 불가 →
    // 먼저 매칭되는 title_id 들을 prefetch 한 뒤 OR(filename ilike, title_id IN (...)).
    if (search) {
      // PostgREST or() 문자열에서 충돌 가능한 메타문자 제거.
      const safe = String(search).replace(/[,()*\\]/g, ' ').trim();
      if (safe) {
        const { data: titleHits } = await supabase
          .from('pjl_titles')
          .select('id')
          .ilike('title_en', `%${safe}%`);
        const matchingTitleIds = (titleHits || []).map((t) => t.id);

        // PostgREST or() 안에서는 ilike wildcard 가 '*' (URL 컨텍스트, '%' 금지)
        if (matchingTitleIds.length) {
          q = q.or(
            `original_filename.ilike.*${safe}*,title_id.in.(${matchingTitleIds.join(',')})`
          );
        } else {
          q = q.ilike('original_filename', `%${safe}%`);
        }
      }
    }

    const pid = parseIntOrNull(promptId);
    if (pid) q = q.eq('prompt_id', pid);
    if (hasVocals === 'true') q = q.eq('has_vocals', true);
    else if (hasVocals === 'false') q = q.eq('has_vocals', false);
    if (usedFilter === 'unused') q = q.eq('used_count', 0);
    else if (usedFilter === 'used') q = q.gt('used_count', 0);
    if (prefixOrder === 'with-prefix') q = q.not('prefix_order', 'is', null);
    else if (prefixOrder === 'no-prefix') q = q.is('prefix_order', null);
    if (instrument) q = q.contains('instruments', [instrument]);
    if (minDuration) q = q.gte('duration_actual_sec', parseFloat(minDuration));
    if (maxDuration) q = q.lte('duration_actual_sec', parseFloat(maxDuration));
    if (fromDate) q = q.gte('created_at', fromDate);
    if (toDate) q = q.lte('created_at', toDate);

    switch (orderBy) {
      case 'oldest':   q = q.order('created_at', { ascending: true }); break;
      case 'shortest': q = q.order('duration_actual_sec', { ascending: true, nullsFirst: false }); break;
      case 'longest':  q = q.order('duration_actual_sec', { ascending: false, nullsFirst: false }); break;
      case 'random':   /* RPC 가 위에서 처리, JS reorder 는 fetch 후 */ break;
      // Phase 4-D-5-A: 사용 이력 기반 정렬.
      case 'recommend':
        // 사용 횟수 적은 순 + 마지막 사용 오래된 순. 둘 다 nulls 가 가장 위 (= 한 번도 안 쓴 곡 최상단).
        q = q.order('used_count', { ascending: true, nullsFirst: true })
             .order('last_used_at', { ascending: true, nullsFirst: true });
        break;
      case 'usage_asc':
        q = q.order('used_count', { ascending: true, nullsFirst: true });
        break;
      case 'usage_desc':
        q = q.order('used_count', { ascending: false, nullsFirst: false });
        break;
      case 'last_used_asc':
        q = q.order('last_used_at', { ascending: true, nullsFirst: true });
        break;
      case 'alpha':
        // 파일명 알파벳 순 (title_en 은 join 컬럼이라 PostgREST .order 처리 까다로움 — 안정적 키 선택).
        q = q.order('original_filename', { ascending: true, nullsFirst: false });
        break;
      case 'recent':   q = q.order('created_at', { ascending: false }); break;  // 'newest' alias
      case 'newest':
      default:         q = q.order('created_at', { ascending: false });
    }

    // random 일 때는 RPC 가 가져온 ID 들 모두 fetch (≤500), 이후 JS reorder + slice.
    q = q.limit(orderBy === 'random' ? Math.max(lim, 500) : lim);

    const { data, error } = await q;
    if (error) throw error;

    let tracks = data || [];
    if (orderBy === 'random') {
      if (useRpcRandom && randomOrderedIds) {
        // RPC 의 random 순서 그대로 보존
        const map = new Map(tracks.map((t) => [t.id, t]));
        tracks = randomOrderedIds.map((id) => map.get(id)).filter(Boolean).slice(0, lim);
      } else {
        // RPC 없는 환경 fallback: JS shuffle
        tracks = [...tracks].sort(() => Math.random() - 0.5).slice(0, lim);
      }
    }

    // Phase 4-D-5-A: 활성 트랙 총 개수 (Pool 탭 'N / 총 N 곡' 표시용 — 필터 무관 글로벌 count).
    let total = null;
    try {
      const { count, error: cErr } = await supabase
        .from('pjl_tracks')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true);
      if (!cErr) total = count ?? null;
    } catch {}

    res.json({ ok: true, count: tracks.length, total, tracks });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/tracks/delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((x) => parseIntOrNull(x)).filter((n) => n != null)
      : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'ids 배열이 필요합니다' });
    }

    console.log(`[DELETE] ${ids.length}곡 삭제 요청:`, ids.slice(0, 10), ids.length > 10 ? `… +${ids.length - 10}` : '');

    const { data: tracks, error: selErr } = await supabase
      .from('pjl_tracks')
      .select('id, storage_path')
      .in('id', ids);
    if (selErr) throw selErr;
    console.log(`[DELETE] DB 에서 ${tracks.length}곡 발견`);

    const paths = tracks.map((t) => t.storage_path).filter(Boolean);
    let removedFromStorage = 0;
    if (paths.length) {
      try {
        const r = await deleteTracks(paths);
        removedFromStorage = r.removed;
        console.log(`[DELETE] Storage ${removedFromStorage}/${paths.length} 파일 삭제`);
      } catch (e) {
        // best-effort: storage 실패해도 DB 삭제는 진행
        console.warn('[DELETE] storage 삭제 일부 실패:', e.message);
      }
    }

    // Phase 4-D-5-C fix: pjl_video_tracks.track_id 의 FK 가 ON DELETE RESTRICT —
    //   Builder 단계 (POST /api/videos) 에서 video_track row 가 생기면 그 후 곡 삭제는 차단됨.
    //   해결: pjl_tracks 삭제 직전 video_tracks 의 해당 track_id row 들을 명시적으로 정리.
    //   pjl_track_usage 는 0005 에서 ON DELETE CASCADE 라 자동 처리.
    {
      const { error: vtErr, count: vtCount } = await supabase
        .from('pjl_video_tracks')
        .delete({ count: 'exact' })
        .in('track_id', ids);
      if (vtErr) {
        console.warn('[DELETE] pjl_video_tracks 정리 실패:', vtErr.message);
      } else {
        console.log(`[DELETE] pjl_video_tracks ${vtCount ?? 0} row 정리`);
      }
    }

    const { error: delErr, count } = await supabase
      .from('pjl_tracks')
      .delete({ count: 'exact' })
      .in('id', ids);
    if (delErr) throw delErr;
    console.log(`[DELETE] pjl_tracks ${count ?? tracks.length}곡 삭제 완료`);

    res.json({
      ok: true,
      deleted: count ?? tracks.length,
      removedFromStorage,
    });
  } catch (e) {
    console.error('[DELETE] 실패:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: 사용 이력 기록 (Phase 4-D-5-A) ──────────────────────────────
//   POST /api/tracks/usage
//   body: { records: [{ track_id, video_id, track_position }, ...] }
//   - pjl_track_usage 에 일괄 INSERT.
//   - 각 track_id 마다 pjl_increment_usage RPC 호출 (atomic +1 + last_used_at=now()).
//   - RPC 미존재 환경 fallback: SELECT used_count → UPDATE 2-step.
//   - 같은 곡이 한 영상에 두 번 들어가도 (예: encore) 둘 다 카운트.
//   - 호출 시점: Studio 가 mp4 export 성공 직후 (취소/실패 시 호출 X).
app.post('/api/tracks/usage', async (req, res) => {
  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    if (!records.length) {
      return res.status(400).json({ ok: false, error: 'records 배열이 필요합니다' });
    }

    const cleaned = records
      .map((r, idx) => ({
        track_id: parseIntOrNull(r?.track_id),
        video_id: typeof r?.video_id === 'string' ? r.video_id.slice(0, 200) : null,
        track_position: parseIntOrNull(r?.track_position) ?? idx + 1,
      }))
      .filter((r) => r.track_id != null && r.video_id);

    if (!cleaned.length) {
      return res.status(400).json({ ok: false, error: 'track_id / video_id 모두 필요' });
    }

    const { error: insErr } = await supabase.from('pjl_track_usage').insert(cleaned);
    if (insErr) throw insErr;

    // unique track_ids — 같은 영상 안 중복 곡은 used_count 1회만 증가시키지 않고 record 수만큼 증가시킴.
    // (record N = 그 곡이 영상에 N 번 들어갔다는 의미. 둘 다 +1.)
    let rpcOk = 0;
    let rpcFail = 0;
    for (const r of cleaned) {
      const { error: rpcErr } = await supabase
        .rpc('pjl_increment_usage', { p_track_id: r.track_id });
      if (rpcErr) {
        rpcFail++;
        // RPC 미존재(0005 마이그레이션 미실행) → 2-step fallback
        try {
          const { data: row } = await supabase
            .from('pjl_tracks')
            .select('used_count')
            .eq('id', r.track_id)
            .maybeSingle();
          await supabase
            .from('pjl_tracks')
            .update({
              used_count: (row?.used_count || 0) + 1,
              last_used_at: new Date().toISOString(),
            })
            .eq('id', r.track_id);
        } catch (e) {
          console.warn(`[usage] track ${r.track_id} fallback 도 실패:`, e.message);
        }
      } else {
        rpcOk++;
      }
    }

    res.json({ ok: true, recorded: cleaned.length, rpcOk, rpcFail });
  } catch (e) {
    console.error('[usage] 기록 실패:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: 사용 이력 리셋 (Phase 4-D-5-C) ──────────────────────────────
//   POST /api/tracks/reset-usage   body: { ids: [...] }
//     일괄: 선택한 곡들의 used_count → 0, last_used_at → null,
//     pjl_track_usage 행 모두 삭제.
//   POST /api/tracks/:id/reset-usage
//     단일: 한 곡만 동일 처리. (아래 별도 핸들러)
//
// ⚠ Express 라우팅 우선순위: '/api/tracks/reset-usage' 가 '/api/tracks/:id/...' 보다
//   먼저 등록되도록 본 블록이 :id 핸들러보다 위에 위치해야 함.
app.post('/api/tracks/reset-usage', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((x) => parseIntOrNull(x)).filter((n) => n != null)
      : [];
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'ids 배열이 필요합니다' });
    }
    console.log(`[RESET] ${ids.length}곡 일괄 리셋:`, ids.slice(0, 10), ids.length > 10 ? `… +${ids.length - 10}` : '');

    const { error: usageErr, count: usageCount } = await supabase
      .from('pjl_track_usage')
      .delete({ count: 'exact' })
      .in('track_id', ids);
    if (usageErr) throw usageErr;
    console.log(`[RESET] pjl_track_usage ${usageCount ?? 0} row 삭제`);

    const { error: trErr, count: resetCount } = await supabase
      .from('pjl_tracks')
      .update({ used_count: 0, last_used_at: null }, { count: 'exact' })
      .in('id', ids);
    if (trErr) throw trErr;
    console.log(`[RESET] pjl_tracks ${resetCount ?? 0}곡 카운터 리셋`);

    res.json({ ok: true, reset: resetCount ?? ids.length, usageRowsDeleted: usageCount ?? 0 });
  } catch (e) {
    console.error('[RESET] 일괄 실패:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/tracks/:id/reset-usage', async (req, res) => {
  const trackId = parseIntOrNull(req.params.id);
  if (!trackId) return res.status(400).json({ ok: false, error: 'invalid track id' });
  try {
    console.log(`[RESET] 곡 ${trackId} 단일 리셋`);

    const { error: usageErr, count: usageCount } = await supabase
      .from('pjl_track_usage')
      .delete({ count: 'exact' })
      .eq('track_id', trackId);
    if (usageErr) throw usageErr;

    const { error: trErr } = await supabase
      .from('pjl_tracks')
      .update({ used_count: 0, last_used_at: null })
      .eq('id', trackId);
    if (trErr) throw trErr;

    console.log(`[RESET] 곡 ${trackId} 완료 (이력 ${usageCount ?? 0}건 삭제)`);
    res.json({ ok: true, trackId, usageRowsDeleted: usageCount ?? 0 });
  } catch (e) {
    console.error(`[RESET] 곡 ${trackId} 실패:`, e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: 곡별 사용 이력 조회 (Phase 4-D-5-B) ─────────────────────────
//   GET /api/tracks/:id/usage
//   응답: { ok, count, usage: [{ id, video_id, track_position, used_at }, ...] }
//   used_at desc 순. Pool 탭의 행 expand UI 가 이걸 호출.
app.get('/api/tracks/:id/usage', async (req, res) => {
  const trackId = parseIntOrNull(req.params.id);
  if (!trackId) return res.status(400).json({ ok: false, error: 'invalid track id' });

  try {
    const { data, error } = await supabase
      .from('pjl_track_usage')
      .select('id, video_id, track_position, used_at')
      .eq('track_id', trackId)
      .order('used_at', { ascending: false });
    if (error) throw error;

    res.json({ ok: true, count: data?.length || 0, usage: data || [] });
  } catch (e) {
    console.error('[usage] 조회 실패:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: backfill (Phase 3-B) ────────────────────────────────────────
//   POST /api/tracks/backfill
//   body: { ids?: number[], limit?: number }
//   ids 가 있으면 해당 트랙만, 없으면 duration_actual_sec=null 인 트랙 일괄 처리.
//   한 곡씩 순차 처리 (메모리/ffmpeg 프로세스 폭주 방지).
//   Storage 다운로드 실패 / 분석 실패 / DB update 실패를 각 단계별로 분리 보고.
app.post('/api/tracks/backfill', async (req, res) => {
  try {
    const explicitIds = Array.isArray(req.body?.ids)
      ? req.body.ids.map(parseIntOrNull).filter((n) => n != null)
      : null;
    const lim = Math.min(Math.max(parseInt(req.body?.limit, 10) || 100, 1), 500);

    let q = supabase
      .from('pjl_tracks')
      .select('id, storage_path, original_filename')
      .eq('is_active', true);

    if (explicitIds && explicitIds.length) {
      q = q.in('id', explicitIds);
    } else {
      q = q.is('duration_actual_sec', null);
    }
    q = q.limit(lim);

    const { data: tracks, error: selErr } = await q;
    if (selErr) throw selErr;

    const results = [];
    let analyzed = 0, dlErrors = 0, anErrors = 0, updErrors = 0, skipped = 0;

    // ⚠ 순차 처리: 동시 ffmpeg 프로세스 폭주 / 메모리 폭증 방지
    for (const t of tracks) {
      // 1) Storage 다운로드
      let buf;
      try {
        const { data: blob, error: dlErr } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .download(t.storage_path);
        if (dlErr) throw dlErr;
        if (!blob) throw new Error('빈 응답');
        buf = Buffer.from(await blob.arrayBuffer());
      } catch (e) {
        results.push({
          id: t.id,
          filename: t.original_filename,
          status: 'error',
          step: 'download',
          error: e.message,
        });
        dlErrors++;
        continue;
      }

      // 2) 분석
      let meta;
      try {
        meta = await analyzeTrack(buf);
        if (meta._probeError) {
          // ffprobe 자체가 실패 — 결과 모두 null. error 로 분류.
          throw new Error(`ffprobe 실패: ${meta._probeError}`);
        }
      } catch (e) {
        results.push({
          id: t.id,
          filename: t.original_filename,
          status: 'error',
          step: 'analyze',
          error: e.message,
        });
        anErrors++;
        continue;
      }

      // 3) DB update
      try {
        const { error: updErr } = await supabase
          .from('pjl_tracks')
          .update({
            bpm: meta.bpm,
            duration_raw_sec: meta.durationRawSec,
            duration_actual_sec: meta.durationActualSec,
          })
          .eq('id', t.id);
        if (updErr) throw updErr;
      } catch (e) {
        results.push({
          id: t.id,
          filename: t.original_filename,
          status: 'error',
          step: 'update',
          error: e.message,
        });
        updErrors++;
        continue;
      }

      results.push({
        id: t.id,
        filename: t.original_filename,
        status: 'analyzed',
        bpm: meta.bpm,
        duration_raw_sec: meta.durationRawSec,
        duration_actual_sec: meta.durationActualSec,
      });
      analyzed++;
    }

    res.json({
      ok: true,
      total: tracks.length,
      summary: { analyzed, skipped, dlErrors, anErrors, updErrors },
      results,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: signed audio URL (Phase 3-C-3 — preview player) ─────────────
//   GET /api/tracks/:id/audio-url
//   Private bucket 의 곡을 1시간 유효 signed URL 로 노출.
app.get('/api/tracks/:id/audio-url', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid id' });

    const { data: track, error } = await supabase
      .from('pjl_tracks')
      .select('id, storage_path, original_filename, title:pjl_titles(title_en)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!track) return res.status(404).json({ ok: false, error: `trackId=${id} not found` });
    if (!track.storage_path) return res.status(500).json({ ok: false, error: 'storage_path 비어있음' });

    const expiresInSec = 3600;
    let url;
    try {
      url = await getSignedUrl(track.storage_path, expiresInSec);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `signed URL 발급 실패: ${e.message}` });
    }

    res.json({
      ok: true,
      trackId: track.id,
      url,
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      title: track.title?.title_en || null,
      originalFilename: track.original_filename,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: extract-instruments (Phase 3-C-2-C) ──────────────────────────
//   POST /api/tracks/extract-instruments
//   body: { ids?: number[], overwrite?: boolean }
//
//   - ids 가 있으면 해당 트랙만, 없으면 instruments 가 비어있는 트랙 전체.
//   - overwrite=true 면 기존 instruments 가 있어도 prompt 재추출로 교체.
//   - prompt_text 가 없는 트랙은 skip.
//   - 오디오 다운로드/Gemini 호출 없음 — 순수 텍스트 매칭, 빠름.
app.post('/api/tracks/extract-instruments', async (req, res) => {
  try {
    const explicitIds = Array.isArray(req.body?.ids)
      ? req.body.ids.map(parseIntOrNull).filter((n) => n != null)
      : null;
    const overwrite = req.body?.overwrite === true;

    let q = supabase
      .from('pjl_tracks')
      .select('id, instruments, prompt:pjl_prompts(prompt_text)')
      .eq('is_active', true);

    if (explicitIds && explicitIds.length) {
      q = q.in('id', explicitIds);
    }

    const { data: tracks, error: selErr } = await q.limit(500);
    if (selErr) throw selErr;

    let updated = 0, skipped = 0, errors = 0;
    const results = [];

    for (const t of tracks) {
      const had = (t.instruments || []).length > 0;
      if (had && !overwrite) {
        skipped++;
        results.push({ id: t.id, status: 'skipped', reason: 'already-has-instruments', instruments: t.instruments });
        continue;
      }
      const promptText = t.prompt?.prompt_text || '';
      if (!promptText) {
        skipped++;
        results.push({ id: t.id, status: 'skipped', reason: 'no-prompt' });
        continue;
      }
      try {
        const inferred = await detectInstruments(promptText);
        const { error: uerr } = await supabase
          .from('pjl_tracks')
          .update({ instruments: inferred })
          .eq('id', t.id);
        if (uerr) throw uerr;
        updated++;
        results.push({ id: t.id, status: 'updated', instruments: inferred, prev: t.instruments || [] });
      } catch (e) {
        errors++;
        results.push({ id: t.id, status: 'error', error: e.message });
      }
    }

    res.json({
      ok: true,
      total: tracks.length,
      summary: { updated, skipped, errors },
      results,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Instruments: 사용 빈도순 집계 (필터 드롭다운용) ──────────────────────
app.get('/api/instruments', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('pjl_tracks')
      .select('instruments')
      .eq('is_active', true);
    if (error) throw error;
    const counts = new Map();
    for (const t of data || []) {
      for (const ins of t.instruments || []) {
        counts.set(ins, (counts.get(ins) || 0) + 1);
      }
    }
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
    res.json({ ok: true, instruments: sorted });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Prompts CRUD ─────────────────────────────────────────────────────────

app.get('/api/prompts', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('pjl_prompts')
      .select('*')
      .order('use_count', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, prompts: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/prompts', async (req, res) => {
  try {
    const promptText = (req.body?.promptText || '').trim();
    if (!promptText) {
      return res.status(400).json({ ok: false, error: 'promptText 필수' });
    }
    const payload = { prompt_text: promptText };
    if (req.body?.nickname !== undefined) {
      payload.nickname = req.body.nickname || null;
    }
    if (req.body?.isFavorite !== undefined) {
      payload.is_favorite = !!req.body.isFavorite;
    }

    const { data, error } = await supabase
      .from('pjl_prompts')
      .upsert(payload, { onConflict: 'prompt_text' })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, prompt: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Titles: generate / reroll / bulk-generate (Phase 3-C-1) ─────────────
//
// 정책:
//  - 새 제목은 Gemini Pro 가 5개 후보 생성 → 서버가 ≥2 의미단어 충돌 검사로 필터링
//  - rejected 제목도 영구 보관 + 다음 generate 의 회피 목록에 포함 (학습용)
//  - reroll 은 현재 title 을 status='rejected' 로 표시 후 새로 generate
//  - bulk-generate 는 곡 사이 sleep 4500ms (Gemini free tier 15 RPM 안전)

const BULK_SLEEP_MS = 4500;
const MAX_GEN_ROUNDS = 3;

async function generateTitleForTrack(trackId) {
  // 1) track + prompt 조회
  const { data: track, error: terr } = await supabase
    .from('pjl_tracks')
    .select('id, title_id, original_filename, prompt:pjl_prompts(prompt_text)')
    .eq('id', trackId)
    .single();
  if (terr) throw new Error(`track 조회 실패: ${terr.message}`);
  if (!track) throw new Error(`trackId=${trackId} 없음`);
  if (track.title_id) {
    const err = new Error(`이미 title_id=${track.title_id} 있음. /api/titles/reroll 사용`);
    err.code = 'TITLE_ALREADY_SET';
    throw err;
  }

  const promptText = track.prompt?.prompt_text || '';

  // 2) 기존 제목 로드 — 회피 + 충돌 + 다양성 필터 계산용.
  //    Phase 4-D-5-D: 'recent window' (최근 50) 기준으로 heavyWords / bannedFirstWords 산출 →
  //    같은 batch 내 직전 곡들과의 단어 폭증 ("Showa", "Bayou") 자동 차단.
  const { data: existing, error: eerr } = await supabase
    .from('pjl_titles')
    .select('id, title_en, normalized_words, status')
    .order('id', { ascending: false })
    .limit(500);
  if (eerr) throw new Error(`titles 조회 실패: ${eerr.message}`);
  const all = existing || [];
  const recent = all.slice(0, 50);                     // 최근 50개
  const avoidList = all.map((t) => t.title_en);        // 충돌 검사 + Gemini prompt
  const recentFreq = buildWordFrequency(recent);
  const heavyWords = findHeavilyUsedWords(recentFreq, 2);  // 최근 50 안에서 2회 이상 = heavy
  const bannedFirstWords = findUsedFirstWords(recent);

  // 3) Gemini 호출 + 점수화. MAX_GEN_ROUNDS 회 시도, 모든 후보 모아 best 픽.
  //    Phase 4-D-5-D: 단순 first-collision 통과 → 점수제로 변경. perfect 후보 있으면 즉시 채택,
  //    없어도 best 후보를 fallback 으로 사용 (500 안 던짐 — 형님 작업 흐름 멈추지 않게).
  const allCandidates = [];
  const rejections = [];
  /** @type {Array<{ trimmed: string, norm: string[], score: number, reasons: string[] }>} */
  const scoredAll = [];

  for (let round = 1; round <= MAX_GEN_ROUNDS; round++) {
    let cands;
    try {
      cands = await generateTitleCandidates({
        promptText, avoidList, heavyWords, bannedFirstWords,
        count: 10, attempt: round,
      });
    } catch (e) {
      throw new Error(`Gemini 호출 실패 (round ${round}): ${e.message}`);
    }

    for (const cand of cands) {
      const trimmed = String(cand).trim();
      if (!trimmed) continue;
      allCandidates.push(trimmed);

      // 절대 reject: exact duplicate / 의미 단어 0개 / ≥2 단어 충돌
      if (avoidList.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
        rejections.push({ candidate: trimmed, reason: 'exact-duplicate' });
        continue;
      }
      const norm = normalizeTitle(trimmed);
      if (!norm.length) {
        rejections.push({ candidate: trimmed, reason: 'no-content-words' });
        continue;
      }
      const col = findCollision(norm, all);
      if (col) {
        rejections.push({
          candidate: trimmed, reason: 'pattern-collision',
          existingTitle: col.existingTitle, overlapWords: col.overlapWords,
        });
        continue;
      }

      // 점수화 — 0 이 perfect. heavyWord/firstWord 패널티 큼.
      const reasons = [];
      let score = 0;
      const fw = norm[0];
      if (fw && bannedFirstWords.has(fw)) {
        score += 5;
        reasons.push(`first-word-collision(${fw})`);
      }
      let heavyHits = 0;
      for (const w of norm) {
        if ((recentFreq.get(w) || 0) >= 2) {
          heavyHits++;
          score += 3;
        }
      }
      if (heavyHits) reasons.push(`heavy-word-x${heavyHits}`);

      scoredAll.push({ trimmed, norm, score, reasons });

      // perfect 후보 발견 시 즉시 채택 (배치당 Gemini 호출 절약).
      if (score === 0) break;
    }
    if (scoredAll.some((s) => s.score === 0)) break;
  }

  if (!scoredAll.length) {
    // exact-dup / 충돌만 있어서 점수화 단계 자체에 도달 못 함.
    const err = new Error('모든 후보가 ≥2 단어 충돌 — 패턴 회피 실패');
    err.candidates = allCandidates;
    err.rejections = rejections;
    throw err;
  }

  // 가장 unique 한 후보 선택. score 동률 시 먼저 들어온 (= 더 일찍 발견된 = round 작은) 것.
  scoredAll.sort((a, b) => a.score - b.score);
  const best = scoredAll[0];
  const chosen = { title: best.trimmed, normalized: best.norm };
  let warning = null;
  if (best.score > 0) {
    warning = {
      message: '완벽한 unique 후보를 찾지 못해 가장 unique 한 것을 사용했습니다. 수동 변경 권장.',
      score: best.score,
      issues: best.reasons,
    };
    console.warn(`[TITLE] 곡 ${trackId} fallback: ${chosen.title} (score=${best.score}, ${best.reasons.join(', ')})`);
  }

  // 4) titles insert
  const { data: title, error: ierr } = await supabase
    .from('pjl_titles')
    .insert({
      title_en: chosen.title,
      normalized_words: chosen.normalized,
      status: 'used',
      use_count: 1,
      last_used_at: new Date().toISOString(),
    })
    .select('id, title_en, normalized_words, status, use_count')
    .single();
  if (ierr) throw new Error(`title insert 실패: ${ierr.message}`);

  // 5) tracks.title_id 연결
  const { error: uerr } = await supabase
    .from('pjl_tracks')
    .update({ title_id: title.id })
    .eq('id', trackId);
  if (uerr) {
    // 고아 title row 정리 (best-effort)
    await supabase.from('pjl_titles').delete().eq('id', title.id);
    throw new Error(`track 업데이트 실패: ${uerr.message}`);
  }

  return {
    title,
    track: { id: trackId, title_id: title.id },
    candidatesConsidered: allCandidates.length,
    rejections,
    warning,
  };
}

app.post('/api/titles/generate', async (req, res) => {
  try {
    const trackId = parseIntOrNull(req.body?.trackId);
    if (!trackId) return res.status(400).json({ ok: false, error: 'trackId 필수' });
    const result = await generateTitleForTrack(trackId);
    res.json({ ok: true, ...result });
  } catch (e) {
    const payload = { ok: false, error: e.message };
    if (e.code) payload.code = e.code;
    if (e.candidates) payload.candidates = e.candidates;
    if (e.rejections) payload.rejections = e.rejections;
    const status = e.code === 'TITLE_ALREADY_SET' ? 409 : 500;
    res.status(status).json(payload);
  }
});

app.post('/api/titles/reroll', async (req, res) => {
  try {
    const trackId = parseIntOrNull(req.body?.trackId);
    const reason = req.body?.reason || null;
    if (!trackId) return res.status(400).json({ ok: false, error: 'trackId 필수' });

    const { data: track, error: terr } = await supabase
      .from('pjl_tracks')
      .select('id, title_id')
      .eq('id', trackId)
      .single();
    if (terr) throw terr;
    if (!track) return res.status(404).json({ ok: false, error: 'track 없음' });

    let previousTitleId = null;
    if (track.title_id) {
      previousTitleId = track.title_id;
      // 영구 보관: status=rejected (삭제 X)
      const { error: uerr } = await supabase
        .from('pjl_titles')
        .update({ status: 'rejected', rejected_reason: reason })
        .eq('id', track.title_id);
      if (uerr) throw uerr;
      // track.title_id 분리 → generate 가 다시 돌 수 있게
      const { error: nerr } = await supabase
        .from('pjl_tracks')
        .update({ title_id: null })
        .eq('id', trackId);
      if (nerr) throw nerr;
    }

    const result = await generateTitleForTrack(trackId);
    res.json({ ok: true, ...result, previousTitleId });
  } catch (e) {
    const payload = { ok: false, error: e.message };
    if (e.candidates) payload.candidates = e.candidates;
    if (e.rejections) payload.rejections = e.rejections;
    res.status(500).json(payload);
  }
});

app.post('/api/titles/bulk-generate', async (req, res) => {
  try {
    const trackIds = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds.map(parseIntOrNull).filter((n) => n != null)
      : null;
    const lim = Math.min(Math.max(parseInt(req.body?.limit, 10) || 50, 1), 200);

    let q = supabase
      .from('pjl_tracks')
      .select('id')
      .is('title_id', null)
      .eq('is_active', true);
    if (trackIds && trackIds.length) q = q.in('id', trackIds);
    const { data: tracks, error } = await q.limit(lim);
    if (error) throw error;

    const results = [];
    let ok = 0, errs = 0;

    // ⚠ 순차 처리 + sleep — Gemini free tier 15 RPM
    let warns = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      try {
        const r = await generateTitleForTrack(t.id);
        if (r.warning) warns++;
        results.push({
          trackId: t.id, status: r.warning ? 'warn' : 'ok',
          titleId: r.title.id, title: r.title.title_en,
          warning: r.warning || null,
        });
        ok++;
      } catch (e) {
        results.push({ trackId: t.id, status: 'error', error: e.message });
        errs++;
      }
      if (i < tracks.length - 1) {
        await new Promise((r) => setTimeout(r, BULK_SLEEP_MS));
      }
    }

    res.json({ ok: true, total: tracks.length, summary: { ok, warns, errs }, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Templates: CRUD + duplicate (Phase 4-A) ─────────────────────────────

app.get('/api/templates', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('pjl_templates')
      .select('id, name, description, is_default, is_favorite, config_json, background_image_url, thumbnail_url, use_count, created_at, updated_at')
      .order('is_favorite', { ascending: false })
      .order('use_count', { ascending: false })
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, templates: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/templates/:id', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });
    const { data, error } = await supabase
      .from('pjl_templates')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'template not found' });
    res.json({ ok: true, template: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/templates', async (req, res) => {
  try {
    const {
      name, description = null, config_json,
      is_default = false, is_favorite = false,
      background_image_url = null, thumbnail_url = null,
    } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ ok: false, error: 'name 필수' });
    }
    if (!config_json || typeof config_json !== 'object') {
      return res.status(400).json({ ok: false, error: 'config_json 객체 필수' });
    }

    // is_default 켜면 기존 default 들 모두 false
    if (is_default) {
      const { error: uerr } = await supabase
        .from('pjl_templates')
        .update({ is_default: false })
        .eq('is_default', true);
      if (uerr) throw uerr;
    }

    const { data, error } = await supabase
      .from('pjl_templates')
      .insert({
        name: name.trim(),
        description,
        config_json,
        is_default: !!is_default,
        is_favorite: !!is_favorite,
        background_image_url,
        thumbnail_url,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, template: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/templates/:id', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });

    const patch = {};
    const {
      name, description, config_json, is_default, is_favorite,
      thumbnail_url, background_image_url,
    } = req.body || {};
    if (name !== undefined) patch.name = String(name).trim();
    if (description !== undefined) patch.description = description;
    if (config_json !== undefined) {
      if (!config_json || typeof config_json !== 'object') {
        return res.status(400).json({ ok: false, error: 'config_json 객체여야 함' });
      }
      patch.config_json = config_json;
    }
    if (thumbnail_url !== undefined) patch.thumbnail_url = thumbnail_url;
    if (background_image_url !== undefined) patch.background_image_url = background_image_url;
    if (is_default !== undefined) patch.is_default = !!is_default;
    if (is_favorite !== undefined) patch.is_favorite = !!is_favorite;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: '변경할 필드 없음' });
    }

    if (patch.is_default === true) {
      const { error: uerr } = await supabase
        .from('pjl_templates')
        .update({ is_default: false })
        .neq('id', id)
        .eq('is_default', true);
      if (uerr) throw uerr;
    }

    const { data, error } = await supabase
      .from('pjl_templates')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'template not found' });
    res.json({ ok: true, template: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/templates/:id', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });

    // 마지막 default 보호: 지우려는 게 default 이고 default 가 1개뿐이면 거부
    const { data: target, error: terr } = await supabase
      .from('pjl_templates')
      .select('id, is_default')
      .eq('id', id)
      .maybeSingle();
    if (terr) throw terr;
    if (!target) return res.status(404).json({ ok: false, error: 'template not found' });

    if (target.is_default) {
      const { count, error: cerr } = await supabase
        .from('pjl_templates')
        .select('id', { count: 'exact', head: true })
        .eq('is_default', true);
      if (cerr) throw cerr;
      if ((count ?? 0) <= 1) {
        return res.status(409).json({
          ok: false,
          error: '기본 템플릿(is_default=true)은 항상 1개 이상 유지되어야 합니다. 다른 템플릿을 default 로 먼저 지정하세요.',
        });
      }
    }

    const { error } = await supabase.from('pjl_templates').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/templates/:id/duplicate', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });

    const { data: src, error: serr } = await supabase
      .from('pjl_templates')
      .select('name, description, config_json')
      .eq('id', id)
      .maybeSingle();
    if (serr) throw serr;
    if (!src) return res.status(404).json({ ok: false, error: 'template not found' });

    // unique name 충돌 회피: " (copy)", " (copy 2)" ...
    let candidate = `${src.name} (copy)`;
    let suffix = 2;
    while (true) {
      const { data: hit } = await supabase
        .from('pjl_templates')
        .select('id')
        .eq('name', candidate)
        .maybeSingle();
      if (!hit) break;
      candidate = `${src.name} (copy ${suffix++})`;
      if (suffix > 50) throw new Error('복제 이름 후보 50개 초과');
    }

    const { data, error } = await supabase
      .from('pjl_templates')
      .insert({
        name: candidate,
        description: src.description,
        config_json: src.config_json,
        is_default: false,
      })
      .select('*')
      .single();
    if (error) throw error;
    res.json({ ok: true, template: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Templates: favorite toggle (Phase 4-C-1-A) ──────────────────────────

app.post('/api/templates/:id/favorite', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });
    const isFav = !!req.body?.is_favorite;
    const { data, error } = await supabase
      .from('pjl_templates')
      .update({ is_favorite: isFav })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'template not found' });
    res.json({ ok: true, template: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Templates: background upload (Phase 4-C-1-A) ────────────────────────
//   POST /api/templates/upload-background
//   multipart/form-data, field: "file" (mp4 또는 image/*)
//   mp4 면 ffmpeg 로 첫 프레임 PNG 추출, 이미지면 그대로.
//   Storage 의 template-bg/ 경로에 업로드 후 signed URL 반환.

const bgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }, // 100MB (Loop mp4 대비)
});

app.post('/api/templates/upload-background',
  (req, res, next) => {
    bgUpload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: `multer: ${err.code} (${err.message})` });
      }
      if (err) return res.status(400).json({ ok: false, error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'file 필드 비어있음' });

      // 1) 첫 프레임 추출 (또는 이미지 그대로)
      let processed;
      try {
        processed = await processBackground(req.file.buffer, req.file.originalname, req.file.mimetype);
      } catch (e) {
        return res.status(400).json({ ok: false, error: `처리 실패: ${e.message}` });
      }

      // 2) Storage 업로드 — 경로: template-bg/{uuid}.{ext}
      const path = `template-bg/${randomUUID()}.${processed.ext}`;
      const { error: upErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(path, processed.buffer, {
          contentType: processed.mime,
          cacheControl: '86400',
          upsert: false,
        });
      if (upErr) throw new Error(`Storage upload 실패: ${upErr.message}`);

      // 3) signed URL — 1년 유효 (편집 세션 동안 유지). 진짜 영구 보관 필요 시 public bucket 또는 별도 보관 정책.
      const { data: sd, error: sErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      if (sErr) throw new Error(`signed URL 발급 실패: ${sErr.message}`);

      res.json({
        ok: true,
        url: sd.signedUrl,
        path,
        mime: processed.mime,
        ext: processed.ext,
        bytes: processed.buffer.length,
      });
    } catch (e) {
      console.error('[upload-background]', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ─── Video Series: CRUD (Phase 4-B) ──────────────────────────────────────

app.get('/api/video-series', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('pjl_video_series')
      .select('id, name, description, current_vol, created_at, updated_at')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, series: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/video-series', async (req, res) => {
  try {
    const name = (req.body?.series_name || req.body?.name || '').trim();
    const description = req.body?.description ?? null;
    const currentVol = Math.max(0, parseInt(req.body?.current_vol, 10) || 0);
    if (!name) return res.status(400).json({ ok: false, error: 'series_name 필수' });

    const { data, error } = await supabase
      .from('pjl_video_series')
      .insert({ name, description, current_vol: currentVol })
      .select('*')
      .single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return res.status(409).json({ ok: false, error: `시리즈 "${name}" 이미 존재` });
      }
      throw error;
    }
    res.json({ ok: true, series: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/video-series/:id', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });

    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body?.description !== undefined) patch.description = req.body.description;
    if (req.body?.current_vol !== undefined) {
      const v = parseInt(req.body.current_vol, 10);
      if (Number.isNaN(v) || v < 0) {
        return res.status(400).json({ ok: false, error: 'current_vol 음수 불가' });
      }
      patch.current_vol = v;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: '변경할 필드 없음' });
    }

    const { data, error } = await supabase
      .from('pjl_video_series')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'series not found' });
    res.json({ ok: true, series: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/video-series/:id', async (req, res) => {
  try {
    const id = parseIntOrNull(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: 'invalid id' });
    const { error } = await supabase.from('pjl_video_series').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Videos: AI title suggest (Phase 4-B) ────────────────────────────────
//   POST /api/videos/suggest-titles { trackIds, seriesName? }
//   trackIds 의 곡 제목/프롬프트를 컨텍스트로 5개 영상 제목 후보 생성.

app.post('/api/videos/suggest-titles', async (req, res) => {
  try {
    const trackIds = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds.map(parseIntOrNull).filter((n) => n != null)
      : [];
    const seriesName = (req.body?.seriesName || '').trim();
    if (!trackIds.length) {
      return res.status(400).json({ ok: false, error: 'trackIds 필수' });
    }

    // 1) 트랙 + 제목 + 프롬프트 join 조회
    const { data: tracks, error } = await supabase
      .from('pjl_tracks')
      .select(`
        id, original_filename, instruments, has_vocals,
        title:pjl_titles(title_en),
        prompt:pjl_prompts(prompt_text, nickname)
      `)
      .in('id', trackIds);
    if (error) throw error;
    if (!tracks?.length) {
      return res.status(404).json({ ok: false, error: '해당 트랙 없음' });
    }

    // 2) Gemini 컨텍스트 구성
    const trackLines = tracks.slice(0, 20).map((t, i) => {
      const title = t.title?.title_en || '(no title)';
      const instr = (t.instruments || []).join(', ') || '';
      return `  ${i + 1}. "${title}"${instr ? ` [${instr}]` : ''}`;
    }).join('\n');

    const allInstr = new Set();
    for (const t of tracks) for (const x of (t.instruments || [])) allInstr.add(x);
    const instrLine = [...allInstr].slice(0, 12).join(', ');

    const prompt = [
      'You are naming a long jazz YouTube video (25–35 minutes, instrumental).',
      'Output JSON ONLY: {"titles": ["Title One", "Title Two", ...]}.',
      'Each title is 4–8 English words, evocative, jazz/lounge mood, in Title Case.',
      'No emojis, no quotation marks inside the title text.',
      seriesName ? `This is for the "${seriesName}" series — title should fit the series tone.` : '',
      '',
      'Tracks included in this video:',
      trackLines,
      instrLine ? `Combined instruments: ${instrLine}` : '',
      '',
      'Generate 5 candidate video titles, all distinct from each other.',
    ].filter(Boolean).join('\n');

    let text;
    try {
      // ⚠ 영상 제목 (4-8 단어) × 5개 + 2.5-flash 의 thinking 토큰 소비를 감안.
      //   기존 512 는 thinking 에 다 먹혀 응답이 truncate 되어 JSON 파싱 실패 (500) 발생.
      text = await callGemini(prompt, {
        temperature: 1.0,
        maxOutputTokens: 2048,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            // minItems 너무 빡빡하면 Gemini 가 거부하고 빈 응답 줌. 3 으로 완화.
            titles: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 3 },
          },
          required: ['titles'],
        },
      });
    } catch (e) {
      console.error('[suggest-titles] Gemini 호출 실패:', e);
      return res.status(500).json({ ok: false, error: `Gemini 호출 실패: ${e.message}` });
    }

    const titles = parseTitlesJson(text).slice(0, 5);
    if (!titles.length) {
      console.error('[suggest-titles] 파싱 실패. raw 응답:', text);
      return res.status(500).json({
        ok: false,
        error: 'Gemini 응답 파싱 실패 (응답이 비었거나 잘림). 다시 시도해주세요.',
        raw: text,
      });
    }

    res.json({ ok: true, titles, trackCount: tracks.length });
  } catch (e) {
    console.error('[suggest-titles] 서버 오류:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Videos: list / create (Phase 4-B) ───────────────────────────────────

function makeBuildId() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

app.get('/api/videos', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('pjl_video_projects')
      .select('id, build_id, title, volume, status, total_duration_sec, series_id, template_id, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ ok: true, videos: data || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/videos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase
      .from('pjl_video_projects')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'video not found' });

    // 트랙 매핑도 같이 (position 순서)
    const { data: vt, error: vtErr } = await supabase
      .from('pjl_video_tracks')
      .select('position, start_sec, end_sec, track:pjl_tracks(id, title:pjl_titles(title_en), original_filename, duration_actual_sec, prefix_order)')
      .eq('video_id', id)
      .order('position', { ascending: true });
    if (vtErr) throw vtErr;

    res.json({ ok: true, video: data, tracks: vt || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/videos', async (req, res) => {
  try {
    const title = (req.body?.title || '').trim();
    const trackIds = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds.map(parseIntOrNull).filter((n) => n != null)
      : [];
    const templateId = parseIntOrNull(req.body?.templateId);
    const seriesIdRaw = req.body?.seriesId;
    const seriesId = (seriesIdRaw === '' || seriesIdRaw == null) ? null : parseIntOrNull(seriesIdRaw);
    const registerAsSeries = !!req.body?.registerAsSeries;

    if (!title) return res.status(400).json({ ok: false, error: 'title 필수' });
    if (!trackIds.length) return res.status(400).json({ ok: false, error: 'trackIds 비어있음' });

    // 1) 템플릿 조회 (없으면 default)
    let templateRow = null;
    if (templateId) {
      const { data, error } = await supabase
        .from('pjl_templates')
        .select('*')
        .eq('id', templateId)
        .maybeSingle();
      if (error) throw error;
      templateRow = data;
    }
    if (!templateRow) {
      const { data, error } = await supabase
        .from('pjl_templates')
        .select('*')
        .eq('is_default', true)
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      templateRow = data;
    }
    if (!templateRow) {
      return res.status(409).json({
        ok: false,
        error: '사용 가능한 템플릿이 없습니다. tools/seed-default-template.mjs 를 먼저 실행하세요.',
      });
    }

    // 2) 시리즈 결정 — registerAsSeries=true 면 신규 생성, seriesId 면 기존 사용
    let seriesRow = null;
    if (registerAsSeries) {
      const { data, error } = await supabase
        .from('pjl_video_series')
        .insert({ name: title, current_vol: 0 })
        .select('*')
        .single();
      if (error) {
        if (/duplicate|unique/i.test(error.message)) {
          // 이미 같은 이름의 시리즈가 있으면 그것을 사용
          const { data: existing } = await supabase
            .from('pjl_video_series')
            .select('*')
            .eq('name', title)
            .maybeSingle();
          seriesRow = existing;
        } else {
          throw error;
        }
      } else {
        seriesRow = data;
      }
    } else if (seriesId) {
      const { data, error } = await supabase
        .from('pjl_video_series')
        .select('*')
        .eq('id', seriesId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ ok: false, error: 'series not found' });
      seriesRow = data;
    }

    const nextVolume = seriesRow ? (seriesRow.current_vol + 1) : 1;

    // 3) 트랙 메타 조회 (제목 join 포함). 사용자 지정 순서로 정렬.
    const { data: trackRows, error: terr } = await supabase
      .from('pjl_tracks')
      .select(`
        id, storage_path, original_filename,
        duration_actual_sec, duration_raw_sec, prefix_order,
        title:pjl_titles(title_en)
      `)
      .in('id', trackIds);
    if (terr) throw terr;

    const trackMap = new Map((trackRows || []).map((t) => [t.id, t]));
    const orderedTracks = trackIds.map((id) => trackMap.get(id)).filter(Boolean);
    if (orderedTracks.length !== trackIds.length) {
      return res.status(404).json({
        ok: false,
        error: `일부 trackId 가 DB 에 없습니다 (요청 ${trackIds.length}, 발견 ${orderedTracks.length})`,
      });
    }

    // 4) build_id 생성, video_projects insert
    const buildId = makeBuildId();
    const { data: video, error: vErr } = await supabase
      .from('pjl_video_projects')
      .insert({
        build_id: buildId,
        title,
        volume: nextVolume,
        track_ids: trackIds,
        template_json: templateRow.config_json || {},
        status: 'draft',
        series_id: seriesRow?.id || null,
        template_id: templateRow.id,
      })
      .select('*')
      .single();
    if (vErr) throw vErr;

    // 5) video_tracks N:M insert
    let cursor = 0;
    const vtRows = orderedTracks.map((t, i) => {
      const dur = Number(t.duration_actual_sec) || Number(t.duration_raw_sec) || 180;
      const start = cursor;
      const end = start + dur;
      cursor = end;
      return {
        video_id: video.id,
        track_id: t.id,
        position: i + 1,
        start_sec: start,
        end_sec: end,
      };
    });
    const { error: vtErr } = await supabase.from('pjl_video_tracks').insert(vtRows);
    if (vtErr) throw vtErr;

    // 6) total_duration_sec 갱신 + template use_count + series.current_vol 증가
    //    (Phase 4-D-1 — Remotion 제거. 영상 export 는 브라우저 Studio 탭에서.)
    const totalDurationSec = cursor;
    await supabase
      .from('pjl_video_projects')
      .update({ total_duration_sec: Math.round(totalDurationSec) })
      .eq('id', video.id);

    await supabase
      .from('pjl_templates')
      .update({ use_count: (templateRow.use_count || 0) + 1 })
      .eq('id', templateRow.id);

    if (seriesRow) {
      await supabase
        .from('pjl_video_series')
        .update({ current_vol: nextVolume })
        .eq('id', seriesRow.id);
    }

    // 7) 트랙 사용 카운트 — Phase 4-D-5-A 부터 Studio 가 mp4 export 성공 시점에
    //    POST /api/tracks/usage 로 증가시킴. Builder 단계의 video_project 생성에서는
    //    실제 영상이 나온 게 아니므로 카운트 X (예전 코드 제거).

    res.json({
      ok: true,
      videoId: video.id,
      buildId,
      title: video.title,
      volume: nextVolume,
      seriesId: seriesRow?.id || null,
      seriesName: seriesRow?.name || null,
      templateId: templateRow.id,
      templateName: templateRow.name,
      totalDurationSec,
      trackCount: orderedTracks.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── YouTube OAuth + API (Phase 5-A) ─────────────────────────────────────
//
// 흐름:
//   1) GET /auth/youtube         → Google consent 화면으로 redirect
//   2) Google → GET /auth/youtube/callback?code=...
//   3) 서버가 code → tokens 교환 후 secrets/youtube-token.json 에 저장
//   4) 이후 oauth2Client 가 access_token 만료 시 refresh_token 으로 자동 갱신
//
// 토큰 파일은 .gitignore (secrets/) 로 보호. client_id/secret 도 .env.local 에만.

const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const YT_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${PORT}/auth/youtube/callback`;
const YT_TOKEN_PATH = path.isAbsolute(process.env.YOUTUBE_TOKEN_PATH || '')
  ? process.env.YOUTUBE_TOKEN_PATH
  : resolve(__dirname, '../..', process.env.YOUTUBE_TOKEN_PATH || 'secrets/youtube-token.json');
const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

let oauth2Client = null;
let youtube = null;

function ytConfigured() {
  return !!(YT_CLIENT_ID && YT_CLIENT_SECRET);
}

function ytLoadToken() {
  try {
    if (!fs.existsSync(YT_TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(YT_TOKEN_PATH, 'utf-8'));
  } catch (e) {
    console.warn('[YT] 토큰 로드 실패:', e.message);
    return null;
  }
}

function ytSaveToken(tokens) {
  const dir = path.dirname(YT_TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(YT_TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

if (ytConfigured()) {
  oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REDIRECT_URI);

  // refresh_token 은 첫 인증 시만 받음 → 자동 갱신된 access_token 만 새로 저장 + 기존 refresh 보존.
  oauth2Client.on('tokens', (newTokens) => {
    const existing = ytLoadToken() || {};
    ytSaveToken({ ...existing, ...newTokens });
    console.log('[YT] 토큰 자동 갱신 — refresh_token=' + (newTokens.refresh_token ? 'rotated' : 'kept'));
  });

  const saved = ytLoadToken();
  if (saved) {
    oauth2Client.setCredentials(saved);
    console.log('[YT] 저장된 토큰 로드');
  } else {
    console.log('[YT] 토큰 없음 — /auth/youtube 로 인증 필요');
  }

  youtube = google.youtube({ version: 'v3', auth: oauth2Client });
} else {
  console.warn('[YT] YOUTUBE_CLIENT_ID / SECRET 미설정 — Uploader 탭은 인증 카드 표시');
}

// === 1) 인증 시작 ===
app.get('/auth/youtube', (_req, res) => {
  if (!ytConfigured()) {
    return res.status(500).send('YOUTUBE_CLIENT_ID / SECRET 가 .env.local 에 없습니다.');
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',          // refresh_token 보장 (이미 동의한 사용자도 다시 묻기)
    scope: YT_SCOPES,
  });
  res.redirect(url);
});

// === 2) Callback ===
app.get('/auth/youtube/callback', async (req, res) => {
  if (!ytConfigured()) return res.status(500).send('YT not configured');
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  try {
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);
    ytSaveToken(tokens);
    console.log('[YT] OAuth 인증 완료. refresh_token=' + (tokens.refresh_token ? 'OK' : 'MISSING — re-consent 필요'));
    res.send(`<!doctype html><html><body style="font-family:system-ui;background:#0a0a0a;color:#eee;padding:60px;text-align:center;">
      <h2 style="color:#D4AF37;">✅ YouTube 인증 완료</h2>
      <p style="color:#888;">이 창은 잠시 후 자동으로 닫힙니다.</p>
      <script>setTimeout(() => window.close(), 1500);</script>
    </body></html>`);
  } catch (e) {
    console.error('[YT] OAuth 실패:', e);
    res.status(500).send(`인증 실패: ${e.message}`);
  }
});

// === 3) 인증 상태 ===
app.get('/api/youtube/status', (_req, res) => {
  const token = ytLoadToken();
  res.json({
    ok: true,
    configured: ytConfigured(),
    authenticated: !!token,
    hasRefreshToken: !!(token?.refresh_token),
  });
});

// === 4) 영상 50개 (예약 영상 포함) ===
//   uploads playlist 를 통해 가져오기 — search.list 는 예약 영상 누락.
async function ytGetMyVideos(maxResults = 50) {
  if (!youtube) throw new Error('YouTube 미인증 또는 client 미설정');
  const meRes = await youtube.channels.list({ part: ['contentDetails'], mine: true });
  const me = meRes.data.items?.[0];
  if (!me) throw new Error('채널 정보를 가져올 수 없음');
  const uploadsPid = me.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPid) throw new Error('uploads playlist ID 없음');

  const itemsRes = await youtube.playlistItems.list({
    part: ['contentDetails'],
    playlistId: uploadsPid,
    maxResults,
  });
  const ids = (itemsRes.data.items || []).map((it) => it.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) return [];

  const vidsRes = await youtube.videos.list({
    part: ['snippet', 'status', 'statistics', 'localizations'],
    id: ids,
  });
  return (vidsRes.data.items || []).map((v) => ({
    id: v.id,
    title: v.snippet?.title || '',
    description: v.snippet?.description || '',
    thumbnail: v.snippet?.thumbnails?.medium?.url
            || v.snippet?.thumbnails?.default?.url
            || null,
    publishedAt: v.snippet?.publishedAt || null,
    privacyStatus: v.status?.privacyStatus || null,
    publishAt: v.status?.publishAt || null,
    viewCount: parseInt(v.statistics?.viewCount || '0', 10),
    tags: v.snippet?.tags || [],
    defaultLanguage: v.snippet?.defaultLanguage || null,
    localizations: v.localizations || {},
    localizationCount: Object.keys(v.localizations || {}).length,
  }));
}

async function ytGetMyPlaylists(maxResults = 50) {
  if (!youtube) throw new Error('YouTube 미인증 또는 client 미설정');
  const r = await youtube.playlists.list({
    part: ['snippet', 'contentDetails'],
    mine: true,
    maxResults,
  });
  return (r.data.items || []).map((p) => ({
    id: p.id,
    title: p.snippet?.title || '',
    description: p.snippet?.description || '',
    thumbnail: p.snippet?.thumbnails?.medium?.url || p.snippet?.thumbnails?.default?.url || null,
    itemCount: p.contentDetails?.itemCount || 0,
    privacyStatus: p.status?.privacyStatus || null,
  }));
}

function ytAuthGate(_req, res) {
  if (!ytConfigured()) {
    res.status(500).json({ ok: false, error: 'YouTube client 미설정 (.env.local 의 YOUTUBE_CLIENT_ID/SECRET)' });
    return false;
  }
  if (!ytLoadToken()) {
    res.status(401).json({ ok: false, error: 'YouTube 인증 필요', authUrl: '/auth/youtube' });
    return false;
  }
  return true;
}

app.get('/api/youtube/videos', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  try {
    const max = Math.min(Math.max(parseInt(req.query.max, 10) || 50, 1), 50);
    const videos = await ytGetMyVideos(max);
    res.json({ ok: true, count: videos.length, videos });
  } catch (e) {
    console.error('[YT] 영상 조회 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/api/youtube/playlists', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  try {
    const playlists = await ytGetMyPlaylists();
    res.json({ ok: true, count: playlists.length, playlists });
  } catch (e) {
    console.error('[YT] 재생목록 조회 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Phase 4-D-5-C: 글로벌 에러 핸들러 — 라우트 안에서 throw 가 res 에 처리되지 않은 채
//   bubble up 한 경우 마지막 안전망. 정상 라우트들은 try/catch 로 직접 500 응답.
app.use((err, req, res, _next) => {
  console.error(`[GLOBAL ERROR] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: err?.message || String(err) });
});

// ─── Start ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const projectRef = SUPABASE_URL?.replace(/^https?:\/\//, '').split('.')[0] ?? '(unset)';
  console.log('');
  console.log(`🎷 Premium Jazz Lounge — http://localhost:${PORT}`);
  console.log(`   Supabase: ${projectRef}`);
  console.log(`   Bucket:   ${SUPABASE_BUCKET}`);
  console.log(`   Health:   http://localhost:${PORT}/api/health`);
  console.log('');
});
