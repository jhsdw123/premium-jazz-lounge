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
import { normalizeTitle, findCollision } from '../../lib/title-utils.mjs';
import { detectInstruments } from '../../lib/instruments.mjs';
import { callGemini, parseTitlesJson } from '../../lib/llm.mjs';
import { buildAndPersistPlaylist } from '../../lib/template-to-remotion.mjs';

const PORT = parseInt(process.env.PORT, 10) || 4001;
const VERSION = '0.2.0';

const app = express();
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

    res.json({ ok: true, count: tracks.length, tracks });
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

    const { data: tracks, error: selErr } = await supabase
      .from('pjl_tracks')
      .select('id, storage_path')
      .in('id', ids);
    if (selErr) throw selErr;

    const paths = tracks.map((t) => t.storage_path).filter(Boolean);
    let removedFromStorage = 0;
    if (paths.length) {
      try {
        const r = await deleteTracks(paths);
        removedFromStorage = r.removed;
      } catch (e) {
        // best-effort: storage 실패해도 DB 삭제는 진행
        console.warn('storage 삭제 일부 실패:', e.message);
      }
    }

    const { error: delErr } = await supabase.from('pjl_tracks').delete().in('id', ids);
    if (delErr) throw delErr;

    res.json({ ok: true, deleted: tracks.length, removedFromStorage });
  } catch (e) {
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

  // 2) 모든 기존 제목 (status 무관) 로드 — 회피 + 충돌 검사용
  const { data: existing, error: eerr } = await supabase
    .from('pjl_titles')
    .select('id, title_en, normalized_words, status');
  if (eerr) throw new Error(`titles 조회 실패: ${eerr.message}`);
  const avoidList = (existing || []).map((t) => t.title_en);

  // 3) Gemini 호출 + 충돌 필터, 최대 MAX_GEN_ROUNDS 회 시도
  const allCandidates = [];
  const rejections = [];
  let chosen = null;

  for (let round = 1; round <= MAX_GEN_ROUNDS; round++) {
    let cands;
    try {
      cands = await generateTitleCandidates({
        promptText, avoidList, count: 5, attempt: round,
      });
    } catch (e) {
      throw new Error(`Gemini 호출 실패 (round ${round}): ${e.message}`);
    }

    for (const cand of cands) {
      const trimmed = String(cand).trim();
      if (!trimmed) continue;
      allCandidates.push(trimmed);

      // 정확히 일치 (대소문자 무시) → reject
      if (avoidList.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
        rejections.push({ candidate: trimmed, reason: 'exact-duplicate' });
        continue;
      }

      const norm = normalizeTitle(trimmed);
      if (!norm.length) {
        rejections.push({ candidate: trimmed, reason: 'no-content-words' });
        continue;
      }

      const col = findCollision(norm, existing || []);
      if (col) {
        rejections.push({
          candidate: trimmed,
          reason: 'pattern-collision',
          existingTitle: col.existingTitle,
          overlapWords: col.overlapWords,
        });
        continue;
      }

      chosen = { title: trimmed, normalized: norm };
      break;
    }
    if (chosen) break;
  }

  if (!chosen) {
    const err = new Error('모든 후보가 충돌/중복 — 패턴 회피 실패');
    err.candidates = allCandidates;
    err.rejections = rejections;
    throw err;
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
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      try {
        const r = await generateTitleForTrack(t.id);
        results.push({ trackId: t.id, status: 'ok', titleId: r.title.id, title: r.title.title_en });
        ok++;
      } catch (e) {
        results.push({ trackId: t.id, status: 'error', error: e.message });
        errs++;
      }
      if (i < tracks.length - 1) {
        await new Promise((r) => setTimeout(r, BULK_SLEEP_MS));
      }
    }

    res.json({ ok: true, total: tracks.length, summary: { ok, errs }, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Templates: CRUD + duplicate (Phase 4-A) ─────────────────────────────

app.get('/api/templates', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('pjl_templates')
      .select('id, name, description, is_default, config_json, thumbnail_url, use_count, created_at, updated_at')
      .order('is_default', { ascending: false })
      .order('use_count', { ascending: false })
      .order('id', { ascending: true });
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
    const { name, description = null, config_json, is_default = false } = req.body || {};
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
      .insert({ name: name.trim(), description, config_json, is_default: !!is_default })
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
    const { name, description, config_json, is_default, thumbnail_url } = req.body || {};
    if (name !== undefined) patch.name = String(name).trim();
    if (description !== undefined) patch.description = description;
    if (config_json !== undefined) {
      if (!config_json || typeof config_json !== 'object') {
        return res.status(400).json({ ok: false, error: 'config_json 객체여야 함' });
      }
      patch.config_json = config_json;
    }
    if (thumbnail_url !== undefined) patch.thumbnail_url = thumbnail_url;
    if (is_default !== undefined) patch.is_default = !!is_default;

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

    // 6) Remotion 입력 빌드 + 트랙 다운로드 + jazz-playlist.json 쓰기
    let buildResult;
    try {
      buildResult = await buildAndPersistPlaylist({
        template: templateRow,
        tracks: orderedTracks,
        videoTitle: seriesRow ? `${seriesRow.name} Vol.${nextVolume} — ${title}` : title,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: `playlist/다운로드 실패: ${e.message}`,
        videoId: video.id,
        buildId,
      });
    }

    // 7) total_duration_sec 갱신 + template use_count + series.current_vol 증가
    await supabase
      .from('pjl_video_projects')
      .update({ total_duration_sec: Math.round(buildResult.totalDurationSec) })
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

    // 8) 트랙 사용 카운트 증가
    for (const t of orderedTracks) {
      await supabase
        .from('pjl_tracks')
        .update({
          used_count: undefined, // sentinel — 다음 줄에서 RPC 또는 별도 처리
        })
        .eq('id', t.id);
    }
    // 위는 noop. 아래에서 sequential 실제 증가 — supabase-js 는 increment RPC 별도 필요해서
    // 간단히 select → update 로.
    for (const t of orderedTracks) {
      const { data: row } = await supabase
        .from('pjl_tracks')
        .select('used_count')
        .eq('id', t.id)
        .maybeSingle();
      if (row) {
        await supabase
          .from('pjl_tracks')
          .update({
            used_count: (row.used_count || 0) + 1,
            last_used_at: new Date().toISOString(),
          })
          .eq('id', t.id);
      }
    }

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
      totalDurationSec: buildResult.totalDurationSec,
      trackCount: orderedTracks.length,
      downloads: buildResult.downloads,
      playlistPath: buildResult.playlistPath,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
