/**
 * Phase 4-B: pjl_templates.config_json + tracks → Remotion 입력 변환 + 트랙 다운로드.
 *
 * 입력:
 *   template   · pjl_templates row (config_json 포함)
 *   tracks     · pjl_tracks rows (정렬된 순서대로). title:pjl_titles 가 join 된 상태 가정.
 *   videoTitle · 영상 전체 제목
 *
 * 처리:
 *   1) 각 트랙의 startSec/endSec 누적 계산
 *   2) Supabase Storage → video/public/tracks/{trackId}.{ext} 로 다운로드
 *      (이미 존재하고 size 일치하면 skip)
 *   3) video/public/jazz-playlist.json 생성/덮어쓰기
 *
 * 반환:
 *   {
 *     playlist: TPlaylist,                    // 메모리 상의 playlist 객체
 *     playlistPath: '/abs/.../jazz-playlist.json',
 *     downloads: [{ trackId, filename, status, ... }],
 *     totalDurationSec: number,
 *   }
 */

import { promises as fs, statSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase, SUPABASE_BUCKET } from './supabase.mjs';

const FALLBACK_DURATION = 180;
const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEO_PUBLIC = resolve(__dirname, '..', 'video', 'public');
const TRACKS_DIR = resolve(VIDEO_PUBLIC, 'tracks');
const PLAYLIST_PATH = resolve(VIDEO_PUBLIC, 'jazz-playlist.json');

function pickTitle(t, i) {
  if (t?.title?.title_en) return t.title.title_en;
  if (t?.title_en) return t.title_en;
  if (t?.original_filename) return t.original_filename;
  return `Track ${i + 1}`;
}

function pickDuration(t) {
  return Number(t?.duration_actual_sec) || Number(t?.duration_raw_sec) || FALLBACK_DURATION;
}

function pickExt(t) {
  // storage_path 또는 original_filename 에서 확장자 추출
  const fromStorage = extname(t?.storage_path || '').toLowerCase();
  if (fromStorage) return fromStorage.slice(1);
  const fromName = extname(t?.original_filename || '').toLowerCase();
  if (fromName) return fromName.slice(1);
  return 'mp3';
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function fileExistsWithSize(filepath) {
  try {
    const st = statSync(filepath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * 한 트랙 다운로드. 이미 있고 size>0 이면 skip.
 * @returns {{ status: 'downloaded'|'cached'|'error', size?: number, error?: string }}
 */
async function downloadOne(track, ext) {
  const filename = `${track.id}.${ext}`;
  const filepath = resolve(TRACKS_DIR, filename);

  const existingSize = fileExistsWithSize(filepath);
  if (existingSize > 0) {
    return { status: 'cached', filename, size: existingSize };
  }

  if (!track.storage_path) {
    return { status: 'error', filename, error: 'storage_path 비어있음' };
  }

  try {
    const { data: blob, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .download(track.storage_path);
    if (error) throw error;
    if (!blob) throw new Error('빈 응답');

    const buf = Buffer.from(await blob.arrayBuffer());
    await fs.writeFile(filepath, buf);
    return { status: 'downloaded', filename, size: buf.length };
  } catch (e) {
    return { status: 'error', filename, error: e.message };
  }
}

/**
 * Phase 4-B 본 구현: playlist 생성 + 트랙 다운로드 + 파일 쓰기.
 */
export async function buildAndPersistPlaylist({ template, tracks = [], videoTitle = 'Untitled' }) {
  await ensureDir(TRACKS_DIR);

  // 1) startSec / endSec 누적 + Remotion 트랙 메타 빌드
  let cursor = 0;
  const remotionTracks = [];
  const downloads = [];

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const ext = pickExt(t);
    const dur = pickDuration(t);
    const startSec = cursor;
    const endSec = startSec + dur;
    cursor = endSec;

    // 2) 트랙 다운로드 (Storage → video/public/tracks/{id}.{ext})
    const dl = await downloadOne(t, ext);
    downloads.push({ trackId: t.id, ...dl });

    remotionTracks.push({
      id: t.id,
      title: pickTitle(t, i),
      audioPath: `/tracks/${dl.filename}`, // Remotion staticFile() 가 /public/ 기준
      durationSec: dur,
      startSec,
      endSec,
    });
  }

  const playlist = {
    videoTitle,
    tracks: remotionTracks,
    template: template?.config_json || {},
    totalDurationSec: cursor || 1,
  };

  // 3) jazz-playlist.json 쓰기 (덮어쓰기)
  await fs.writeFile(PLAYLIST_PATH, JSON.stringify(playlist, null, 2), 'utf8');

  return {
    playlist,
    playlistPath: PLAYLIST_PATH,
    downloads,
    totalDurationSec: cursor,
  };
}

/**
 * 호환 래퍼: 단순 playlist 객체만 필요할 때 (다운로드 없이).
 */
export function buildPlaylistJson({ template, tracks = [], videoTitle = 'Untitled' }) {
  let cursor = 0;
  const remotionTracks = tracks.map((t, i) => {
    const dur = pickDuration(t);
    const startSec = cursor;
    const endSec = startSec + dur;
    cursor = endSec;
    return {
      id: t.id,
      title: pickTitle(t, i),
      audioPath: `/tracks/${t.id}.${pickExt(t)}`,
      durationSec: dur,
      startSec,
      endSec,
    };
  });
  return {
    videoTitle,
    tracks: remotionTracks,
    template: template?.config_json || {},
    totalDurationSec: cursor || 1,
  };
}
