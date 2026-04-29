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
import { uploadTrack, deleteTrack, deleteTracks } from '../../lib/storage.mjs';
import { computeFileHash, parsePrefixOrder } from '../../lib/track-utils.mjs';
import { analyzeTrack } from '../../lib/track-meta.mjs';

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

  res.json({ ok: Object.keys(errors).length === 0, stats, errors });
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
            instruments: [],
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
    if (search) q = q.ilike('original_filename', `%${search}%`);
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
      case 'random':   /* client-side shuffle */ break;
      case 'newest':
      default:         q = q.order('created_at', { ascending: false });
    }

    q = q.limit(lim);

    const { data, error } = await q;
    if (error) throw error;

    let tracks = data || [];
    if (orderBy === 'random') {
      tracks = [...tracks].sort(() => Math.random() - 0.5);
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
