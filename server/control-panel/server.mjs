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

// ─── Tracks: 제목 자동완성 (Phase 5-B) ──────────────────────────────────
//   GET /api/tracks/autocomplete?q=Sho&limit=5
//   - 제목이 q 로 시작하는 (사용된 적 있는) 곡 우선.
//   - title_en 은 pjl_titles 에 있으므로 2-step query (titles 먼저 → tracks).
//   - 응답: { ok, results: [{ id, title, used_count, last_used_at }] }.
app.get('/api/tracks/autocomplete', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
  if (!q) return res.json({ ok: true, results: [] });

  try {
    // 1) title_en 이 q 로 시작하는 title row 들 (≤200 prefetch)
    const safe = q.replace(/[,()*\\%]/g, ' ').trim();
    const { data: titleHits, error: tErr } = await supabase
      .from('pjl_titles')
      .select('id, title_en')
      .ilike('title_en', `${safe}%`)
      .limit(200);
    if (tErr) throw tErr;
    const matchedTitleIds = (titleHits || []).map((t) => t.id);
    if (!matchedTitleIds.length) return res.json({ ok: true, results: [] });

    // 2) 그 title 을 가진 + used_count>0 트랙 중 used 가 많은 순.
    const { data: trackRows, error: trErr } = await supabase
      .from('pjl_tracks')
      .select('id, title_id, used_count, last_used_at')
      .in('title_id', matchedTitleIds)
      .gt('used_count', 0)
      .eq('is_active', true)
      .order('used_count', { ascending: false })
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (trErr) throw trErr;

    const titleMap = new Map((titleHits || []).map((t) => [t.id, t.title_en]));
    const results = (trackRows || []).map((t) => ({
      id: t.id,
      title: titleMap.get(t.title_id) || '',
      used_count: t.used_count || 0,
      last_used_at: t.last_used_at || null,
    }));
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[autocomplete] 실패:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Tracks: 가장 최근 사용 영상의 곡 list (Phase 5-B) ───────────────────
//   GET /api/tracks/:id/last-video
//   - 이 곡의 가장 최근 used_at 의 video_id 조회.
//   - 그 video_id 의 모든 pjl_track_usage row + 트랙/제목/길이 조회.
//   - 누적 시간 계산해 timecode 부여.
//   - 응답: { ok, video_id, used_at, track_count, tracks: [{ position, title, track_id, length_sec, start_sec, timecode }] }
//   - 사용 이력 없으면 404 + { fallback: 'manual' }.
app.get('/api/tracks/:id/last-video', async (req, res) => {
  const trackId = parseIntOrNull(req.params.id);
  if (!trackId) return res.status(400).json({ ok: false, error: 'invalid track id' });

  try {
    // 1) 가장 최근 사용
    const { data: last, error: e1 } = await supabase
      .from('pjl_track_usage')
      .select('video_id, used_at, track_position')
      .eq('track_id', trackId)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e1) throw e1;
    if (!last) {
      return res.status(404).json({ ok: false, error: '이 곡의 사용 이력 없음', fallback: 'manual' });
    }

    // 2) 그 video_id 의 모든 곡 (position 순). 트랙/제목/길이 join.
    //    pjl_track_usage → pjl_tracks → pjl_titles 2단 nested embed.
    const { data: usageRows, error: e2 } = await supabase
      .from('pjl_track_usage')
      .select(`
        track_position,
        used_at,
        track:pjl_tracks (
          id,
          duration_actual_sec,
          duration_raw_sec,
          title:pjl_titles ( id, title_en )
        )
      `)
      .eq('video_id', last.video_id)
      .order('track_position', { ascending: true });
    if (e2) throw e2;

    let cumulative = 0;
    const tracks = (usageRows || []).map((u) => {
      const lengthSec = Number(u.track?.duration_actual_sec)
        || Number(u.track?.duration_raw_sec)
        || 0;
      const startSec = cumulative;
      cumulative += lengthSec;
      return {
        position: u.track_position,
        track_id: u.track?.id ?? null,
        title: u.track?.title?.title_en || '',
        length_sec: lengthSec,
        start_sec: startSec,
        timecode: formatTimecode(startSec),
      };
    });

    res.json({
      ok: true,
      video_id: last.video_id,
      used_at: last.used_at,
      track_count: tracks.length,
      tracks,
    });
  } catch (e) {
    console.error('[last-video] 실패:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

function formatTimecode(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

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

// ─── Phase 5-C: Path A — 기존 영상 메타 재사용 ────────────────────────────
//
//  형님 워크플로우:
//    1) 새 영상 카드 클릭 (=적용 대상)
//    2) 첫 곡 입력 → 14곡 자동 매칭 (Phase 5-B)
//    3) "Path A" 선택 → 과거 영상 1개 (재사용 source) 선택
//    4) 서버가 source 영상의 16개 언어 메타 fetch
//       - [Vol.숫자] +1 정규식 교체
//       - 설명란 타임라인 (MM:SS - Title) 새 곡으로 교체
//       - 해시태그 그대로 유지
//    5) 빠진 언어가 있으면 missingLanguages 로 알림
//    6) (Phase 5-F 에서) YouTube API 로 적용

const PATH_A_TARGET_LANGUAGES = [
  'ko', 'en', 'ja', 'zh', 'zh-Hant',
  'es', 'fr', 'de', 'it', 'pt',
  'ru', 'nl', 'th', 'vi', 'id',
  'ms', 'tl',
];

// === Vol 숫자 추출 (어떤 언어 제목이든) ===
//  여러 패턴 중 첫 매치 → 정수 반환. 못 찾으면 null.
//  Phase 5-D: 비표준 (vol.X) / (vol N-M) 패턴 지원 — The Grand Fanfare 시리즈.
function extractVolNumber(text) {
  if (!text) return null;
  const patterns = [
    /\[Vol\.?\s*(\d+)\]/i,            // [Vol.5] / [Vol5]
    /\(Vol\.?\s*(\d+)\)/i,            // (Vol 5) / (Vol5)
    /\(vol\.(\d+)\)/i,                 // (vol.5) — 비표준 The Grand Fanfare
    /\(vol\s+(\d+)(?:[\s\-\d]*)\)/i,  // (vol 1-2) — 첫 숫자만
    /\bVol\.?\s*(\d+)\b/i,            // bare Vol 5
    /\[(\d{1,3})\]\s*$/,              // 프랑스어 끝 [5]
  ];
  for (const p of patterns) {
    const m = String(text).match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// === Vol 패턴 통일 ===
//  source 영상 17개 언어가 7~8가지 패턴으로 다양 (Gemini 번역 변동) →
//  "두더지잡기" 회피: 알려진 모든 Vol 패턴 제거 후 끝에 [Vol.N] 통일 추가.
//  결과: 다음 사이클부터는 [Vol.N] 1개 패턴만 매치 OK.
function unifyVolPattern(text, newVolNumber) {
  if (!text) return text;
  let result = String(text);
  // 알려진 Vol 패턴 모두 제거 (앞쪽 가로공백 흡수)
  result = result.replace(/\s*\[Vol\.?\s*\d+\]/gi, '');         // [Vol.5] / [Vol5]
  result = result.replace(/\s*\(Vol\.?\s*\d+\)/gi, '');         // (Vol 5) / (Vol5)
  result = result.replace(/\s*\(vol\.\d+\)/gi, '');             // (vol.5) — 비표준 The Grand Fanfare
  result = result.replace(/\s*\(vol\s+\d+(?:[\s\-\d]*)\)/gi, ''); // (vol 1-2) — 범위
  result = result.replace(/\s*\(\d+\s*집\)/g, '');              // 한국어 (5집)
  result = result.replace(/\s*\(Том\s*\d+\)/gi, '');            // 러시아 (Том 5)
  result = result.replace(/\s*\(เล่ม\s*\d+\)/g, '');            // 태국 (เล่ม 5)
  result = result.replace(/\s*\(第\s*\d+\s*卷\)/g, '');         // 중국 (第 5 卷)
  result = result.replace(/\s*\[\d{1,3}\]\s*$/, '');            // 프랑스 끝의 [5]
  // 가로공백 collapse + 양끝 trim (newline 보존)
  result = result.replace(/[ \t]{2,}/g, ' ').trim();
  return result ? `${result} [Vol.${newVolNumber}]` : `[Vol.${newVolNumber}]`;
}

// === 시리즈 키 추출 ===
//  패턴 1 (표준): [시리즈명] ... 으로 시작하는 영상.
//  패턴 2 (Phase 5-D 비표준): 콜론(:) 또는 (vol N) 앞까지가 시리즈명.
//                예: "The Grand 🎺Fanfare🎺: Nostalgic Big Band Swing for a Powerful Start(vol.5)"
//  안전 장치:
//    - 시리즈명이 Vol/Volume/Episode/EP/Pt/Part 로 시작 → null
//    - 시리즈명 길이 < 3 → null (패턴 1) / < 5 → null (패턴 2 더 엄격)
function extractSeriesKey(title) {
  if (!title) return null;
  const t = String(title);

  // 패턴 1: [시리즈명] prefix
  const bracket = t.match(/^\[([^\]]+)\]/);
  if (bracket) {
    const candidate = bracket[1].trim();
    if (/^(Vol|Volume|Episode|EP|Pt|Part)[\s.\d]/i.test(candidate)) return null;
    if (candidate.length < 3) return null;
    return candidate;
  }

  // 패턴 2: "(vol N)" / "(vol.N)" 류 vol 패턴 직전까지를 시리즈명.
  //   콜론(:) / 한글 / 이모지 / 공백 모두 시리즈명 안에 포함 가능 (The Grand Fanfare).
  //   vol 패턴이 없으면 null (변형/DRAFT 안전 무시).
  const volMatch = t.match(/^(.+?)\s*\(vol\.?\s*\d/i);
  if (volMatch) {
    const candidate = volMatch[1].trim();
    if (candidate.length >= 5 && candidate.length <= 120) {
      if (/^(Vol|Volume|Episode|EP|Pt|Part)[\s.\d]/i.test(candidate)) return null;
      return candidate;
    }
  }

  return null;
}

function validateExtractSeriesKey() {
  const cases = [
    { input: '[New Orleans Jazz] Upbeat swing jazz [Vol.6]', expected: 'New Orleans Jazz' },
    { input: '[Showa Era] Smooth jazz [Vol.3]', expected: 'Showa Era' },
    { input: '[Vol.5] No series', expected: null },
    { input: 'No bracket title', expected: null },
    { input: '[ABC]', expected: 'ABC' },
    { input: '[A] short', expected: null },
    { input: '[No Ads] New Orleans Jazz...', expected: 'No Ads' }, // 형님 검토 필요
    // Phase 5-D 비표준 시리즈
    { input: 'The Grand 🎺Fanfare🎺: Nostalgic Big Band Swing for a Powerful Start(vol.5)',
      expected: 'The Grand 🎺Fanfare🎺: Nostalgic Big Band Swing for a Powerful Start' },
    { input: 'Title without colon or paren', expected: null },
    { input: 'Tiny: x', expected: null }, // 길이 < 5
  ];
  let pass = 0;
  cases.forEach((c, i) => {
    const r = extractSeriesKey(c.input);
    const ok = r === c.expected;
    console.log(`[Series] ${ok ? '✓' : '✗'} case ${i + 1}: "${c.input.substring(0, 60)}" → ${r === null ? 'null' : `"${r}"`}`);
    if (!ok) console.log(`  expected: ${c.expected === null ? 'null' : `"${c.expected}"`}`);
    ok && pass++;
  });
  console.log(`[Series] ${pass}/${cases.length} pass`);
}
if (process.env.NODE_ENV !== 'production') {
  validateExtractSeriesKey();
}

function validateExtractVolNumber() {
  const cases = [
    { input: '[Vol.5]', expected: 5 },
    { input: '(Vol 5)', expected: 5 },
    { input: '(vol.5)', expected: 5 },         // 신규 비표준
    { input: '(vol 1-2)', expected: 1 },        // 신규 범위 — 첫 숫자만
    { input: 'No vol', expected: null },
    { input: 'Bare Vol 7 inline', expected: 7 },
    { input: 'French ending [42]', expected: 42 },
  ];
  let pass = 0;
  cases.forEach((c, i) => {
    const r = extractVolNumber(c.input);
    const ok = r === c.expected;
    console.log(`[Vol] ${ok ? '✓' : '✗'} case ${i + 1}: "${c.input}" → ${r === null ? 'null' : r}`);
    if (!ok) console.log(`  expected: ${c.expected === null ? 'null' : c.expected}`);
    ok && pass++;
  });
  console.log(`[Vol] ${pass}/${cases.length} pass`);
}
if (process.env.NODE_ENV !== 'production') {
  validateExtractVolNumber();
}

// === Vol 패턴 in-place 교체 (description 용) ===
//  description 의 Vol 미러 라인 (예: "[Title] [Vol.8]" 또는 "(8집)") 을 새 Vol 로 갱신.
//  unifyVolPattern 과 달리 끝에 append 안 함 — 위치 보존, 모든 언어 패턴 in-place 교체.
//  주의: 프랑스어의 끝-[N] 패턴은 description 에서 매치 X (1930 등 4자리 안전).
function replaceVolPattern(text, newVolNumber) {
  if (!text) return text;
  const newPattern = `[Vol.${newVolNumber}]`;
  let result = String(text);
  result = result.replace(/\[Vol\.?\s*\d+\]/gi, newPattern);     // [Vol.5] / [Vol5]
  result = result.replace(/\(Vol\.?\s*\d+\)/gi, newPattern);     // (Vol 5)
  result = result.replace(/\(vol\.\d+\)/gi, newPattern);          // (vol.5) — 비표준
  result = result.replace(/\(vol\s+\d+(?:[\s\-\d]*)\)/gi, newPattern); // (vol 1-2)
  result = result.replace(/\(\s*\d+\s*집\s*\)/g, newPattern);    // (5집)
  result = result.replace(/\(Том\s*\d+\)/gi, newPattern);        // (Том 5)
  result = result.replace(/\(เล่ม\s*\d+\)/g, newPattern);        // (เล่ม 5)
  result = result.replace(/\(第\s*\d+\s*卷\)/g, newPattern);     // (第 5 卷)
  return result;
}

function validateReplaceVolPattern() {
  const cases = [
    { input: '[New Orleans Jazz] Upbeat swing jazz [Vol.8]', newVol: 9,
      expected: '[New Orleans Jazz] Upbeat swing jazz [Vol.9]' },
    { input: '한국어 제목 (8집)\n설명', newVol: 9,
      expected: '한국어 제목 [Vol.9]\n설명' },
    { input: '中文 (第 8 卷) 설명', newVol: 9,
      expected: '中文 [Vol.9] 설명' },
    { input: 'Multi line\n[Vol.8] middle\nmore text', newVol: 9,
      expected: 'Multi line\n[Vol.9] middle\nmore text' },
    { input: 'No vol here', newVol: 9, expected: 'No vol here' },
    { input: 'Big Band Classics from the [1930] era', newVol: 9,
      expected: 'Big Band Classics from the [1930] era' },
    { input: 'Grand Fanfare(vol.5) line', newVol: 6,
      expected: 'Grand Fanfare[Vol.6] line' },
    { input: 'Range (vol 1-2) sample', newVol: 3,
      expected: 'Range [Vol.3] sample' },
  ];
  let pass = 0;
  cases.forEach((c, i) => {
    const r = replaceVolPattern(c.input, c.newVol);
    const ok = r === c.expected;
    console.log(`[ReplaceVol] ${ok ? '✓' : '✗'} case ${i + 1}`);
    if (!ok) {
      console.log(`  in:       "${c.input}"`);
      console.log(`  got:      "${r}"`);
      console.log(`  expected: "${c.expected}"`);
    }
    ok && pass++;
  });
  console.log(`[ReplaceVol] ${pass}/${cases.length} pass`);
}
if (process.env.NODE_ENV !== 'production') {
  validateReplaceVolPattern();
}

// === 검증 (개발 환경 1회): 형님 17개 언어 진짜 데이터 ===
function validateUnifyVol() {
  const cases = [
    { input: 'Instant Good Mood: ... Big Band Classics (Vol 5)', newVol: 6,
      expected: 'Instant Good Mood: ... Big Band Classics [Vol.6]' },
    { input: '즉각적인 기분 전환: ... 빅밴드 클래식 (5집)', newVol: 6,
      expected: '즉각적인 기분 전환: ... 빅밴드 클래식 [Vol.6]' },
    { input: 'Мгновенное хорошее настроение: ... биг-бэнда (Том 5)', newVol: 6,
      expected: 'Мгновенное хорошее настроение: ... биг-бэнда [Vol.6]' },
    { input: 'อารมณ์ดีทันที: ... ที่ช่วยเติมพลัง (เล่ม 5)', newVol: 6,
      expected: 'อารมณ์ดีทันที: ... ที่ช่วยเติมพลัง [Vol.6]' },
    { input: '瞬间好心情：... 与活力大乐队经典 (第 5 卷)', newVol: 6,
      expected: '瞬间好心情：... 与活力大乐队经典 [Vol.6]' },
    { input: 'Bonne humeur instantanée : ... énergisants de Big Band[5]', newVol: 6,
      expected: 'Bonne humeur instantanée : ... énergisants de Big Band [Vol.6]' },
    { input: 'Tâm Trạng Tốt Tức Thì: ... Tiếp Năng Lượng', newVol: 6,
      expected: 'Tâm Trạng Tốt Tức Thì: ... Tiếp Năng Lượng [Vol.6]' },
    { input: '[Vol.99]', newVol: 100, expected: '[Vol.100]' },
    { input: 'Already unified [Vol.5]', newVol: 6, expected: 'Already unified [Vol.6]' },
    // Phase 5-D 비표준 시리즈
    { input: 'The Grand 🎺Fanfare🎺: Nostalgic Big Band Swing for a Powerful Start(vol.5)', newVol: 6,
      expected: 'The Grand 🎺Fanfare🎺: Nostalgic Big Band Swing for a Powerful Start [Vol.6]' },
    { input: 'Grand Fanfare title (vol 1-2)', newVol: 3,
      expected: 'Grand Fanfare title [Vol.3]' },
  ];
  let pass = 0;
  let fail = 0;
  cases.forEach((c, i) => {
    const r = unifyVolPattern(c.input, c.newVol);
    const ok = r === c.expected;
    console.log(`[Unify] ${ok ? '✓' : '✗'} case ${i + 1}`);
    if (!ok) {
      console.log(`  in:       "${c.input}"`);
      console.log(`  got:      "${r}"`);
      console.log(`  expected: "${c.expected}"`);
    }
    ok ? pass++ : fail++;
  });
  console.log(`[Unify] ${pass}/${cases.length} pass`);
}
if (process.env.NODE_ENV !== 'production') {
  validateUnifyVol();
}

// === Vol 해시태그 제거 ===
//  #jazzvol8, #Vol2024, #SwingVol3 같은 Vol+숫자 해시태그 제거.
//  newline 은 보존 (description 의 헤더/타임라인/푸터 구조 유지).
//  가로 공백만 collapse, 빈 줄에 남은 공백은 trim.
function removeVolHashtags(text) {
  if (!text) return text;
  return String(text)
    .replace(/[ \t]*#\w*[Vv]ol\w*\d+\w*/g, '') // 해시태그 + 앞쪽 가로 공백 제거
    .replace(/ {2,}/g, ' ')                      // 연속 공백 collapse (newline 보존)
    .replace(/[ \t]+\n/g, '\n')                  // 줄 끝 공백 제거
    .trim();
}

// === 타임라인 정규식 ===
//  형님 영상 실제 형식: "00:00 Sideburn Trim Crooked" (대시 없이 시간 + 공백 + 제목).
//  대시/하이픈/em-dash 도 허용 (옵션). 공백은 필수 (시간과 제목 분리).
const TIMELINE_REGEX = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+[-–—]?\s*.+$/;

// === 검증: 타임라인 정규식 케이스 (개발 환경 1회) ===
function validateTimelineRegex() {
  const cases = [
    { text: '00:00 Sideburn Trim Crooked', expected: true },
    { text: '02:16 Bowtie Clip Broken', expected: true },
    { text: '00:00 - Track Name', expected: true },
    { text: '00:00 — Em Dash Track', expected: true },
    { text: '1:23:45 Long Track', expected: true },
    { text: '00:00  Multiple Spaces', expected: true },
    { text: 'No timecode here', expected: false },
    { text: '0:00NoSpace', expected: false },
  ];
  let pass = 0;
  let fail = 0;
  cases.forEach((c) => {
    const result = TIMELINE_REGEX.test(c.text);
    const ok = result === c.expected;
    const status = ok ? '✓' : '✗';
    console.log(`[Timeline regex] ${status} "${c.text}" → ${result} (expected ${c.expected})`);
    if (ok) pass++; else fail++;
  });
  console.log(`[Timeline regex] ${pass}/${pass + fail} pass`);
}
if (process.env.NODE_ENV !== 'production') {
  validateTimelineRegex();
}

// === 설명란 타임라인 교체 ===
//  형님 타임라인 형식: "00:00 Track Title" (대시 없이 공백만, MM:SS 또는 HH:MM:SS).
//  연속된 타임라인 블록을 찾아서 새 newTracks 로 통째 교체. 빈 줄은 블록 안에서 허용.
//  타임라인 블록 못 찾으면 description 그대로 반환.
function replaceTimeline(description, newTracks) {
  if (!description || !Array.isArray(newTracks) || !newTracks.length) return description;
  const lines = String(description).split('\n');

  let timelineStartIdx = -1;
  let timelineEndIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (TIMELINE_REGEX.test(trimmed)) {
      if (timelineStartIdx === -1) timelineStartIdx = i;
      timelineEndIdx = i;
    } else if (timelineStartIdx !== -1 && trimmed === '') {
      // 타임라인 안의 빈 줄 — 계속 검사
      continue;
    } else if (timelineStartIdx !== -1) {
      // 타임라인이 끝남
      break;
    }
  }

  if (timelineStartIdx === -1) {
    console.warn('[Path A] 기존 타임라인 못 찾음');
    return description;
  }

  const newTimeline = newTracks.map((t) => `${t.timecode} ${t.title}`).join('\n');
  const before = lines.slice(0, timelineStartIdx);
  const after = lines.slice(timelineEndIdx + 1);
  return [...before, newTimeline, ...after].join('\n');
}

// === Source 메타 → 변경된 generatedMeta ===
//  Vol 패러다임:
//    title    — 알려진 모든 Vol 패턴 제거 + 끝에 [Vol.N] 통일 추가 (unifyVolPattern)
//    description — Vol 미러 in-place 교체 ([Vol.X] / (X집) / (Том X) / (第 X 卷) 등 → [Vol.N])
//  newVol 명시 없으면 source title 의 Vol +1 사용 (기본).
//  빠진 언어는 missingLanguages 배열에. 태그는 그대로 복사.
function reuseMetaWithChanges(sourceMeta, newTracks, newVol) {
  let appliedVol = newVol;
  if (typeof appliedVol !== 'number' || !Number.isFinite(appliedVol)) {
    const sourceVol = extractVolNumber(sourceMeta.title);
    if (!sourceVol) {
      console.warn('[Vol] 소스 제목에서 Vol 숫자 못 찾음 — 0 부터 시작:', sourceMeta.title);
    }
    appliedVol = (sourceVol || 0) + 1;
  }
  const defaultLang = sourceMeta.defaultLanguage || 'en';

  const result = {
    defaultLanguage: defaultLang,
    appliedVol,
    title: { default: unifyVolPattern(sourceMeta.title, appliedVol) },
    description: {
      default: removeVolHashtags(
        replaceVolPattern(replaceTimeline(sourceMeta.description, newTracks), appliedVol),
      ),
    },
    tags: Array.isArray(sourceMeta.tags) ? [...sourceMeta.tags] : [],
    localizations: {},
    missingLanguages: [],
  };

  for (const lang of PATH_A_TARGET_LANGUAGES) {
    if (lang === defaultLang) continue;
    const localized = sourceMeta.localizations?.[lang];
    if (!localized || (!localized.title && !localized.description)) {
      result.missingLanguages.push(lang);
      continue;
    }
    result.localizations[lang] = {
      title: unifyVolPattern(localized.title || sourceMeta.title, appliedVol),
      description: removeVolHashtags(
        replaceVolPattern(
          replaceTimeline(localized.description || sourceMeta.description, newTracks),
          appliedVol,
        ),
      ),
    };
  }

  return result;
}

// === GET /api/youtube/videos/:id/meta ===
//  영상 1개의 모든 16개 언어 메타 + 태그.
app.get('/api/youtube/videos/:id/meta', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  const videoId = String(req.params.id || '').trim();
  if (!videoId) return res.status(400).json({ ok: false, error: 'videoId 필요' });

  try {
    const response = await youtube.videos.list({
      part: ['snippet', 'localizations', 'status'],
      id: [videoId],
    });
    const video = response.data.items?.[0];
    if (!video) return res.status(404).json({ ok: false, error: '영상 없음' });

    res.json({
      ok: true,
      meta: {
        videoId,
        defaultLanguage: video.snippet?.defaultLanguage || 'en',
        title: video.snippet?.title || '',
        description: video.snippet?.description || '',
        tags: video.snippet?.tags || [],
        localizations: video.localizations || {},
        publishedAt: video.snippet?.publishedAt || null,
      },
    });
  } catch (e) {
    console.error('[YT] 메타 조회 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ─── Phase 5-D: Path B — Gemini 새 메타 생성 (17개 언어) ──────────────────
//
//  새 시리즈 첫 영상 또는 기존 시리즈 새 본문 — Path A 처럼 source 재사용 X.
//  Gemini 가 영어 base 생성 → 16개 언어 번역 → 영구 PJL 템플릿 (헤더/푸터) 적용.
//  결과 구조는 Path A 와 동일 (generatedMeta) — 후속 미리보기/적용 단계 그대로 재사용.

const PATH_B_LANGUAGES = [
  'ko', 'ja', 'zh', 'zh-Hant',
  'es', 'fr', 'de', 'it', 'pt',
  'ru', 'nl', 'th', 'vi', 'id', 'ms', 'tl',
];  // 16개 (en 제외 — Path B default)

// PJL 영구 템플릿 — 헤더 + 본문 + 타임라인 + 채널 안내 + 저작권 + 해시태그
const PJL_HEADER_TEMPLATE = `🐾 Follow Us for the earliest release → [https://www.youtube.com/@PremiumJazzLounge]
{TITLE}

{BODY}

{HASHTAGS_TOP}
-------------------------------------------------------------------------------------------------------------------------

🐾 Join the Premium Jazz Lounge Family! → https://www.youtube.com/@PremiumJazzLounge ✔️
Channel memberships allow you to join our channel and get Members-Only Perks like Badges, Emojis, early access to New Videos, and even Access to All Orchid Tones Library (Access to All Constantly Updated Music 🎧 included in the Premium Jazz Lounge Videos)!
❤️ Become a Premium Jazz Lounge channel member!

{TIMELINE}

☕ About Premium Jazz Lounge channel:
At Premium Jazz Lounge, we categorize our playlists according to the mood, tempo, genre, and intended use of each jazz track. We hope our subscribers enjoy exploring these curated selections.
Thank you for your support and happy listening

🎵 All music in this video and on this channel is original music created by us.
🎵 All songs are performed by our musicians and AI. All music is composed by our authors.
🎥 All videos on this channel are original videos produced by us.

📩 Contact For business inquiries and licensing of our music, contact us via the following email address:
Official contact: [dain.lim@outlook.com]

© All rights reserved.
℗ Music is Copyrighted by Premium Jazz Lounge.
© Video is Copyrighted by Premium Jazz Lounge.

🚫 Any reproduction or republication of all or part of this video/audio is prohibited.

Hashtags
{HASHTAGS_BOTTOM}`;

// 타임라인 텍스트 — newTracks → "00:00 Title\n02:34 Title2\n..." 형식
function generatePathBTimeline(newTracks) {
  if (!Array.isArray(newTracks)) return '';
  return newTracks.map((t) => `${t.timecode} ${t.title}`).join('\n');
}

// Gemini prompt 빌더 — 17개 언어 메타 동시 생성 (영어 base + 16개 번역)
function buildPathBPrompt(inputs) {
  const { seriesName, volNumber, mood, scenarios, era, notes } = inputs;
  const allLangs = ['en', ...PATH_B_LANGUAGES];
  const langList = allLangs.join(', ');

  // 제목 fixed 부분 길이 = "[" + series + "] " + " [Vol." + N + "]"
  const fixedLen = seriesName.length + 4 + 7 + String(volNumber).length;
  const bodyMax = Math.max(20, 100 - fixedLen);

  return `You are a YouTube SEO expert for "Premium Jazz Lounge" — a 24/7 jazz music streaming channel for international audience (especially Japan, US, France, Italy, Korea).

Generate complete metadata for a new jazz video in ${allLangs.length} languages: ${langList}.

## Video Info
- Series: ${seriesName}
- Volume: ${volNumber}
- Mood: ${mood || 'jazz'}
- Use Scenarios: ${scenarios || 'general listening'}
- Era/Genre: ${era || ''}
- Additional Notes: ${notes || ''}
- Important: This video is Midroll-Ad-Free (no ads in the middle)

## Output Format (STRICT JSON ONLY — no markdown, no commentary)

{
  "en": {
    "title": "[${seriesName}] (catchy English description) [Vol.${volNumber}]",
    "body": "(2-3 English sentences, 1-2 emojis, mention scenarios/mood + Midroll-Ad-Free)",
    "hashtags_top": "#tag1 #tag2 #tag3 ... (15 hashtags, single line, space-separated, all lowercase, jazz/mood/scenario related)",
    "hashtags_bottom": "#tag1, #tag2, #tag3, ... (24 hashtags, single line, comma-separated, lowercase, more diverse SEO)"
  },
  "ko": { "title": "...", "body": "...", "hashtags_top": "...", "hashtags_bottom": "..." },
  "ja": { ... },
  "zh": { ... },
  "zh-Hant": { ... },
  "es": { ... },
  "fr": { ... },
  "de": { ... },
  "it": { ... },
  "pt": { ... },
  "ru": { ... },
  "nl": { ... },
  "th": { ... },
  "vi": { ... },
  "id": { ... },
  "ms": { ... },
  "tl": { ... }
}

## CRITICAL TITLE LENGTH RULE (YouTube max = 100 characters per title)
Format: [${seriesName}] (description) [Vol.${volNumber}]
- The fixed parts "[${seriesName}] " + " [Vol.${volNumber}]" already take ~${fixedLen} characters.
- The (description) middle MUST be max ${bodyMax} characters total (count emojis as 2 chars each).
- KEEP DESCRIPTIONS PUNCHY AND SHORT. Do not exceed 100 chars total per title in any language.

Examples (good length):
✅ "[Showa Era] Smooth Jazz for Cozy Evenings 🌙 [Vol.1]"  (51 chars)
✅ "[New Orleans] Energetic Swing for Workouts 💪 [Vol.3]"  (51 chars)
❌ "[New Orleans] Uplifting & Happy Instrumental Music for Good Mood and Stress Relief [Vol.1]"  (90+ chars — too long)

## Title Rules
- Format: [${seriesName}] (description in target language) [Vol.${volNumber}]
- The literal "[${seriesName}]" prefix and "[Vol.${volNumber}]" suffix MUST stay identical in every language (universal).
- Description in the middle: catchy, mentions mood/scenario, in target language.
- TOTAL title length MUST be ≤100 characters in EVERY language. Verify each language before output.

## Body Rules
- 2-3 sentences in target language.
- 1-2 emojis (jazz/mood related: 🎷 💃 🌟 🎵 ☕ 🌙 🚗 🎺 etc).
- Mention "Midroll-Ad-Free" or its target-language equivalent.
- Engaging tone, written for the listener.

## Hashtags Rules
- hashtags_top: 15 hashtags total, space-separated, lowercase, ENGLISH keywords only (global SEO).
- hashtags_bottom: 24 hashtags total, comma-separated, lowercase, ENGLISH keywords only (more diverse SEO).
- Both fields use the SAME English hashtags across ALL 17 languages — viewers find the channel via English keywords.
- Topics: jazz, swing, big band, ${mood}, ${scenarios}, vintage, classic, instrumental, premium jazz lounge, etc.

Return ${allLangs.length} language entries. JSON only.`;
}

// Path B 전용 Gemini 모델 — pro 가 maxOutputTokens 65536 지원 (flash 는 8192 한계로 17개 언어 잘림).
//   .env.local 에서 PATH_B_GEMINI_MODEL 로 override 가능 (예: gemini-3-pro-preview).
const PATH_B_MODEL = process.env.PATH_B_GEMINI_MODEL || 'gemini-2.5-pro';

// Gemini 응답 텍스트 cleanse + JSON.parse — retry 함수와 미리보기 둘 다 사용.
//   responseMimeType: 'application/json' 가 lib/llm.mjs 에 hardcoded 되어있어
//   markdown fence 안 붙는 게 정상이지만, 모델이 가끔 fence 붙이는 케이스 보험.
function parsePathBResponse(text) {
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7).trim();
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3).trim();
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trim();
  return JSON.parse(cleaned);
}

// === Path B Gemini 호출 + retry (최대 2회) ===
//  실패 케이스:
//    (a) JSON 파싱 실패 (응답 잘림 — maxOutputTokens 부족 or 모델 max 초과)
//    (b) 17개 언어 중 4개 이상 누락 → 재시도
//  마지막 시도까지 실패하면 throw.
async function generatePathBWithRetry(prompt, maxRetries = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Path B] Gemini 시도 ${attempt}/${maxRetries} (model: ${PATH_B_MODEL})...`);
      const startTime = Date.now();

      const text = await callGemini(prompt, {
        model: PATH_B_MODEL,
        temperature: 0.85,
        maxOutputTokens: 65536, // pro 모델 한계까지 — 17개 언어 안전
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Path B] 응답 (${elapsed}초, ${text.length} chars)`);

      let parsed;
      try {
        parsed = parsePathBResponse(text);
      } catch (parseErr) {
        const err = new Error(
          `JSON 파싱 실패: ${parseErr.message}. 응답 ${text.length} chars (잘렸을 가능성 — maxOutputTokens 또는 모델 max 초과).`,
        );
        if (attempt < maxRetries) {
          console.warn(`[Path B] 시도 ${attempt} 파싱 실패 → 재시도:`, parseErr.message);
          lastError = err;
          continue;
        }
        throw err;
      }

      if (!parsed.en || !parsed.en.title) {
        const err = new Error('Gemini 응답에 en 또는 en.title 누락 (default language 빠짐)');
        if (attempt < maxRetries) {
          console.warn(`[Path B] 시도 ${attempt} en 누락 → 재시도`);
          lastError = err;
          continue;
        }
        throw err;
      }

      const expectedLangs = ['en', ...PATH_B_LANGUAGES];
      const missingLangs = expectedLangs.filter((l) => !parsed[l] || !parsed[l].title);

      if (missingLangs.length > 3 && attempt < maxRetries) {
        console.warn(`[Path B] 시도 ${attempt}: ${missingLangs.length}개 언어 누락 (${missingLangs.join(',')}) → 재시도`);
        continue;
      }
      if (missingLangs.length) {
        console.warn(`[Path B] 시도 ${attempt}: ${missingLangs.length}개 언어 누락 (${missingLangs.join(',')}) — 진행`);
      }

      // 길이 검증 — 영어 제목이 100자 초과면 재시도, 마지막 시도면 trim.
      const enTitleLen = parsed.en.title.length;
      if (enTitleLen > 100) {
        if (attempt < maxRetries) {
          console.warn(`[Path B] 시도 ${attempt}: 영어 제목 ${enTitleLen}자 (max 100) → 재시도`);
          continue;
        }
        // 마지막 시도 — auto-trim
        const trimmed = parsed.en.title.slice(0, 97).trimEnd() + '...';
        console.warn(`[Path B] 자동 trim: en ${enTitleLen}자 → 100자 ("${trimmed}")`);
        parsed.en.title = trimmed;
      }
      // 다른 언어들도 100자 초과 시 자동 trim (재시도 비용 안 들이고 즉시 처리)
      let trimmedCount = 0;
      for (const lang of PATH_B_LANGUAGES) {
        const langData = parsed[lang];
        if (!langData?.title) continue;
        if (langData.title.length > 100) {
          const before = langData.title.length;
          langData.title = langData.title.slice(0, 97).trimEnd() + '...';
          console.warn(`[Path B] 자동 trim: ${lang} ${before}자 → ${langData.title.length}자`);
          trimmedCount++;
        }
      }
      if (trimmedCount) console.warn(`[Path B] ${trimmedCount}개 언어 제목 100자 초과로 trim`);

      return { parsed, elapsed, attemptCount: attempt };
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        console.warn(`[Path B] 시도 ${attempt} 예외 → 재시도:`, e.message);
      }
    }
  }
  throw lastError || new Error('Gemini 호출 실패 (알 수 없음)');
}

// 파싱된 JSON → generatedMeta (Path A 와 동일 구조).
//  파싱은 generatePathBWithRetry 가 담당 — 여기는 객체 받음.
function buildPathBMeta(parsed, inputs, newTracks) {
  const { seriesName, volNumber } = inputs;
  const timeline = generatePathBTimeline(newTracks);

  function buildDescription(langData) {
    return PJL_HEADER_TEMPLATE
      .replace('{TITLE}', langData.title || '')
      .replace('{BODY}', langData.body || '')
      .replace('{HASHTAGS_TOP}', langData.hashtags_top || '')
      .replace('{TIMELINE}', timeline)
      .replace('{HASHTAGS_BOTTOM}', langData.hashtags_bottom || '');
  }

  const result = {
    defaultLanguage: 'en',
    appliedVol: volNumber,
    title: { default: parsed.en.title },
    description: { default: buildDescription(parsed.en) },
    tags: [],
    localizations: {},
    missingLanguages: [],
    pathBInputs: { seriesName, volNumber },
  };

  for (const lang of PATH_B_LANGUAGES) {
    const langData = parsed[lang];
    if (!langData || !langData.title) {
      result.missingLanguages.push(lang);
      continue;
    }
    result.localizations[lang] = {
      title: langData.title,
      description: buildDescription(langData),
    };
  }

  return result;
}

// === POST /api/uploader/path-b/generate ===
//  body: { seriesName, volNumber, mood?, scenarios?, era?, notes?, newTracks }
//  Gemini 호출 → 17개 언어 generatedMeta + missingLanguages 반환.
app.post('/api/uploader/path-b/generate', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'GEMINI_API_KEY 환경변수 없음. .env.local 에 추가 필요.',
    });
  }

  const { seriesName, volNumber, mood, scenarios, era, notes, newTracks } = req.body || {};
  if (!seriesName || typeof seriesName !== 'string' || !seriesName.trim()) {
    return res.status(400).json({ ok: false, error: 'seriesName 필요' });
  }
  if (!Number.isFinite(volNumber) || volNumber < 1) {
    return res.status(400).json({ ok: false, error: '유효한 volNumber 필요' });
  }
  if (!Array.isArray(newTracks) || !newTracks.length) {
    return res.status(400).json({ ok: false, error: 'newTracks 배열 필요' });
  }

  const inputs = {
    seriesName: seriesName.trim(),
    volNumber,
    mood: (mood || '').trim(),
    scenarios: (scenarios || '').trim(),
    era: (era || '').trim(),
    notes: (notes || '').trim(),
  };

  try {
    const prompt = buildPathBPrompt(inputs);
    console.log(`[Path B] 시작 — 시리즈: "${inputs.seriesName}", Vol.${inputs.volNumber}`);

    const { parsed, elapsed, attemptCount } = await generatePathBWithRetry(prompt, 2);

    const generated = buildPathBMeta(parsed, inputs, newTracks);
    console.log(`[Path B] generatedMeta 조립 OK — ${Object.keys(generated.localizations).length}/${PATH_B_LANGUAGES.length} 언어 (시도 ${attemptCount}회)`);

    res.json({ ok: true, generated, geminiElapsed: elapsed, attemptCount });
  } catch (e) {
    console.error('[Path B] 최종 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// === POST /api/uploader/path-a/preview ===
//  body: { sourceVideoId, newTracks: [{ timecode, title, ... }] }
//  source 영상 fetch → Vol +1 + 타임라인 교체 → generatedMeta + missingLanguages 반환.
app.post('/api/uploader/path-a/preview', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  const { sourceVideoId, newTracks, newVol } = req.body || {};
  if (!sourceVideoId || !Array.isArray(newTracks)) {
    return res.status(400).json({ ok: false, error: 'sourceVideoId + newTracks 필요' });
  }

  try {
    const response = await youtube.videos.list({
      part: ['snippet', 'localizations'],
      id: [String(sourceVideoId)],
    });
    const video = response.data.items?.[0];
    if (!video) return res.status(404).json({ ok: false, error: 'Source 영상 없음' });

    const sourceMeta = {
      defaultLanguage: video.snippet?.defaultLanguage || 'en',
      title: video.snippet?.title || '',
      description: video.snippet?.description || '',
      tags: video.snippet?.tags || [],
      localizations: video.localizations || {},
    };

    const explicitVol = (typeof newVol === 'number' && Number.isFinite(newVol)) ? newVol : undefined;
    const generated = reuseMetaWithChanges(sourceMeta, newTracks, explicitVol);
    const sourceVol = extractVolNumber(sourceMeta.title);
    res.json({ ok: true, generated, sourceMeta, sourceVol });
  } catch (e) {
    console.error('[Path A] preview 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// === GET /api/youtube/latest-vol?series=... ===
//  채널 최근 50개 영상에서 Vol 숫자 추출 → 최댓값 반환.
//  series query 있으면 같은 시리즈만 필터링.
app.get('/api/youtube/latest-vol', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  const seriesFilter = req.query.series ? String(req.query.series) : null;
  try {
    const videos = await ytGetMyVideos(50);
    const filtered = seriesFilter
      ? videos.filter((v) => extractSeriesKey(v.title) === seriesFilter)
      : videos;
    const volNumbers = filtered
      .map((v) => extractVolNumber(v.title))
      .filter((n) => n !== null && Number.isFinite(n));
    const latestVol = volNumbers.length ? Math.max(...volNumbers) : 0;
    res.json({ ok: true, latestVol, sampleCount: volNumbers.length, seriesFilter });
  } catch (e) {
    console.error('[YT] latest-vol 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// === GET /api/youtube/check-vol/:volNumber?series=... ===
//  채널 영상 중에 같은 Vol 번호 가진 영상이 있는지 검사.
//  series query 있으면 같은 시리즈만 필터링.
app.get('/api/youtube/check-vol/:volNumber', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  const targetVol = parseInt(req.params.volNumber, 10);
  const seriesFilter = req.query.series ? String(req.query.series) : null;
  if (!Number.isFinite(targetVol) || targetVol < 1) {
    return res.status(400).json({ ok: false, error: '유효한 Vol 번호 필요' });
  }
  try {
    const videos = await ytGetMyVideos(50);
    const matches = videos.filter((v) => {
      if (extractVolNumber(v.title) !== targetVol) return false;
      if (seriesFilter && extractSeriesKey(v.title) !== seriesFilter) return false;
      return true;
    });
    res.json({
      ok: true,
      targetVol,
      seriesFilter,
      hasDuplicate: matches.length > 0,
      duplicates: matches.map((v) => ({
        id: v.id,
        title: v.title,
        publishedAt: v.publishedAt,
        series: extractSeriesKey(v.title),
      })),
    });
  } catch (e) {
    console.error('[YT] check-vol 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ─── Phase 5-F: YouTube 적용 (예약 + 재생목록 + 백업/복원) ────────────────
//
//  1) GET  /api/uploader/next-schedule          — 다음 월/목 16:30 SGT 슬롯 자동 계산
//  2) POST /api/uploader/apply { dryRun }       — 백업 + videos.update + playlistItems.insert
//  3) POST /api/uploader/restore { backupPath } — 백업 복원
//
//  백업 파일: secrets/yt-backups/{videoId}-{timestamp}.json (gitignored).

const YT_BACKUP_DIR = resolve(__dirname, '../..', 'secrets', 'yt-backups');

// === 다음 예약 슬롯 (월/목 16:30 SGT = 08:30 UTC) ===
//  baseTime 보다 미래의 가장 빠른 월요일 또는 목요일 16:30 SGT 반환.
function getNextScheduleSlot(lastScheduledAt) {
  const baseTime = lastScheduledAt ? new Date(lastScheduledAt) : new Date();
  const candidates = [];
  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(baseTime);
    candidate.setUTCDate(candidate.getUTCDate() + i);
    candidate.setUTCHours(8, 30, 0, 0); // 16:30 SGT = 08:30 UTC
    const day = candidate.getUTCDay();  // 0=Sun, 1=Mon, 4=Thu
    if ((day === 1 || day === 4) && candidate > baseTime) {
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a - b);
  return candidates[0];
}

// === GET /api/uploader/next-schedule ===
//  채널의 가장 늦은 예약 영상 → 그 다음 월/목 16:30 슬롯 계산.
app.get('/api/uploader/next-schedule', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  try {
    const videos = await ytGetMyVideos(50);
    const scheduled = videos
      .filter((v) => v.publishAt && new Date(v.publishAt) > new Date())
      .sort((a, b) => new Date(b.publishAt) - new Date(a.publishAt));
    const lastScheduledAt = scheduled[0]?.publishAt || null;
    const nextSlot = getNextScheduleSlot(lastScheduledAt);
    res.json({
      ok: true,
      lastScheduledAt,
      nextSlot: nextSlot.toISOString(),
      nextSlotSGT: nextSlot.toLocaleString('en-SG', { timeZone: 'Asia/Singapore' }),
    });
  } catch (e) {
    console.error('[Uploader] next-schedule 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// === POST /api/uploader/apply ===
//  body: { videoId, generatedMeta, scheduleAt?, playlistIds?, dryRun? }
//  - 백업 (현재 snippet/localizations/status JSON) 항상 생성
//  - dryRun=true 면 plan 만 반환, 실제 변경 X
//  - dryRun=false 면 videos.update + playlistItems.insert
app.post('/api/uploader/apply', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  const { videoId, generatedMeta, scheduleAt, playlistIds, dryRun } = req.body || {};
  if (!videoId || !generatedMeta) {
    return res.status(400).json({ ok: false, error: 'videoId + generatedMeta 필요' });
  }

  // 진단 로그 — Path A/B 둘 다 메타 구조 확인
  const defaultTitle = generatedMeta?.title?.default || '';
  const defaultDescPreview = (generatedMeta?.description?.default || '').slice(0, 100);
  console.log('[Apply] generatedMeta 진단:');
  console.log(`  defaultLanguage: ${generatedMeta?.defaultLanguage}`);
  console.log(`  title (default) [${defaultTitle.length}자]: ${defaultTitle}`);
  console.log(`  description (default) 앞 100자: ${defaultDescPreview}`);
  console.log(`  localizations 수: ${Object.keys(generatedMeta?.localizations || {}).length}`);

  // === 길이 검증 + 자동 trim (apply 직전 마지막 안전망) ===
  if (defaultTitle.length < 1) {
    return res.status(400).json({ ok: false, error: '영어 제목 비어있음. 메타 다시 생성 필요.' });
  }
  if (defaultTitle.length > 100) {
    return res.status(400).json({
      ok: false,
      error: `영어 제목 ${defaultTitle.length}자 (YouTube max 100자). Path B 다시 생성 필요.`,
    });
  }
  // 다른 언어들은 즉시 trim (apply 흐름 깨지 않도록)
  if (generatedMeta.localizations) {
    for (const [lang, loc] of Object.entries(generatedMeta.localizations)) {
      if (loc?.title && loc.title.length > 100) {
        const before = loc.title.length;
        generatedMeta.localizations[lang].title = loc.title.slice(0, 97).trimEnd() + '...';
        console.warn(`[Apply] ${lang} 제목 ${before}자 → 100자 자동 trim`);
      }
    }
  }

  try {
    // 1. 현재 메타 fetch (백업용 + categoryId 보존)
    const currentRes = await youtube.videos.list({
      part: ['snippet', 'localizations', 'status'],
      id: [String(videoId)],
    });
    const backupData = currentRes.data.items?.[0];
    if (!backupData) return res.status(404).json({ ok: false, error: '영상 없음' });

    // 2. 백업 파일 저장
    if (!fs.existsSync(YT_BACKUP_DIR)) fs.mkdirSync(YT_BACKUP_DIR, { recursive: true });
    const backupFile = path.join(YT_BACKUP_DIR, `${videoId}-${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));

    const localizationsCount = Object.keys(generatedMeta.localizations || {}).length;

    // 재생목록: body.playlistIds 가 비어있으면 .env.local 의 DEFAULT_PLAYLIST_IDS (csv) 사용.
    //   ⚙️ 설정 모달은 fallback. 환경변수가 1차 truth.
    const bodyPlaylists = Array.isArray(playlistIds) ? playlistIds.filter(Boolean) : [];
    const envPlaylists = (process.env.DEFAULT_PLAYLIST_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const requestedPlaylists = bodyPlaylists.length ? bodyPlaylists : envPlaylists;
    const playlistSource = bodyPlaylists.length ? 'body' : (envPlaylists.length ? 'env' : 'none');
    if (playlistSource === 'env') {
      console.log('[Apply] Using env DEFAULT_PLAYLIST_IDS:', envPlaylists);
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        backup: backupFile,
        plan: {
          updateSnippet: {
            title: generatedMeta.title?.default || '',
            description: generatedMeta.description?.default || '',
            defaultLanguage: generatedMeta.defaultLanguage || 'en',
            tags: generatedMeta.tags || [],
            categoryId: backupData.snippet?.categoryId || null,
          },
          updateLocalizations: `${localizationsCount} 개 언어`,
          updateStatus: scheduleAt ? `예약: ${scheduleAt}` : '변경 X',
          addToPlaylists: requestedPlaylists,
          playlistSource, // 'body' | 'env' | 'none'
        },
        message: '드라이런 완료. 실제 변경 X.',
      });
    }

    // === 진짜 적용 ===
    const updateBody = {
      id: videoId,
      snippet: {
        title: generatedMeta.title?.default || '',
        description: generatedMeta.description?.default || '',
        defaultLanguage: generatedMeta.defaultLanguage || backupData.snippet?.defaultLanguage || 'en',
        tags: generatedMeta.tags || [],
        categoryId: backupData.snippet?.categoryId, // 보존
      },
      localizations: generatedMeta.localizations || {},
    };
    const updateParts = ['snippet', 'localizations'];
    if (scheduleAt) {
      updateBody.status = {
        privacyStatus: 'private',
        publishAt: scheduleAt,
      };
      updateParts.push('status');
    }

    await youtube.videos.update({
      part: updateParts,
      requestBody: updateBody,
    });

    // 3. playlistItems.insert (각 재생목록)
    const playlistResults = [];
    for (const playlistId of requestedPlaylists) {
      try {
        await youtube.playlistItems.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              playlistId,
              resourceId: { kind: 'youtube#video', videoId },
            },
          },
        });
        playlistResults.push({ playlistId, ok: true });
      } catch (pe) {
        playlistResults.push({ playlistId, ok: false, error: pe?.message || String(pe) });
      }
    }

    res.json({
      ok: true,
      videoId,
      backup: backupFile,
      updated: { snippet: true, localizations: true, status: !!scheduleAt },
      playlists: playlistResults,
      youtubeUrl: `https://studio.youtube.com/video/${videoId}/edit`,
    });
  } catch (e) {
    console.error('[Uploader] apply 실패:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// === POST /api/uploader/restore ===
//  body: { backupPath } — apply 응답의 backup 경로 그대로.
app.post('/api/uploader/restore', async (req, res) => {
  if (!ytAuthGate(req, res)) return;
  const { backupPath } = req.body || {};
  if (!backupPath) return res.status(400).json({ ok: false, error: 'backupPath 필요' });

  // 보안: backupPath 가 YT_BACKUP_DIR 안인지 확인 (path traversal 방지)
  const resolvedBackup = path.resolve(String(backupPath));
  if (!resolvedBackup.startsWith(YT_BACKUP_DIR)) {
    return res.status(400).json({ ok: false, error: 'backupPath 범위 밖' });
  }
  if (!fs.existsSync(resolvedBackup)) {
    return res.status(404).json({ ok: false, error: '백업 파일 없음' });
  }

  try {
    const backup = JSON.parse(fs.readFileSync(resolvedBackup, 'utf-8'));
    await youtube.videos.update({
      part: ['snippet', 'localizations', 'status'],
      requestBody: {
        id: backup.id,
        snippet: backup.snippet,
        localizations: backup.localizations || {},
        status: backup.status,
      },
    });
    res.json({ ok: true, restored: backup.id });
  } catch (e) {
    console.error('[Uploader] restore 실패:', e?.message || e);
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
