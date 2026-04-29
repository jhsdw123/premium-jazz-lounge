import { randomUUID } from 'node:crypto';
import { supabase, SUPABASE_BUCKET } from './supabase.mjs';
import { sanitizeFilename } from './track-utils.mjs';

// Supabase Storage 가 application/octet-stream 을 거부하는 경우가 흔하므로
// 확장자 기반으로 audio MIME 을 추론.
const EXT_TO_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
};

function resolveContentType(mimeType, filename) {
  const mt = (mimeType || '').toLowerCase();
  // 신뢰할 수 있는 audio/* 또는 video/mp4 면 그대로 사용
  if (mt.startsWith('audio/') || mt === 'video/mp4') return mimeType;
  // 그 외 (octet-stream, x-empty, 빈 값) 는 확장자로 추론
  const ext = (filename || '').toLowerCase().match(/\.([^.\\\/]+)$/)?.[1];
  return EXT_TO_MIME[ext] || 'audio/mpeg';
}

/**
 * 곡 파일을 Supabase Storage 에 업로드.
 * 경로: tracks/{uuid}_{sanitizedName}
 *
 * @returns {{ path: string, publicUrl: string|null, contentType: string }}
 */
export async function uploadTrack(buffer, filename, mimeType = null) {
  const safe = sanitizeFilename(filename);
  const path = `tracks/${randomUUID()}_${safe}`;
  const contentType = resolveContentType(mimeType, filename);

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, buffer, {
      contentType,
      cacheControl: '3600',
      upsert: false,
    });
  if (error) throw new Error(`Storage upload 실패: ${error.message}`);

  // private 버킷이면 publicUrl 은 직접 접근 불가하지만 path 의 안정적 reference 로 보관
  const { data: urlData } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(data.path);

  return { path: data.path, publicUrl: urlData?.publicUrl ?? null, contentType };
}

/**
 * Storage 객체 단일 삭제.
 */
export async function deleteTrack(storagePath) {
  if (!storagePath) return;
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .remove([storagePath]);
  if (error) throw new Error(`Storage delete 실패: ${error.message}`);
}

/**
 * Storage 객체 다중 삭제 (best-effort).
 */
export async function deleteTracks(storagePaths) {
  const paths = (storagePaths || []).filter(Boolean);
  if (!paths.length) return { removed: 0 };
  const { error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .remove(paths);
  if (error) throw new Error(`Storage delete 실패: ${error.message}`);
  return { removed: paths.length };
}

/**
 * 서명된 임시 URL 발급 (private 버킷용).
 */
export async function getSignedUrl(storagePath, expiresInSec = 3600) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(storagePath, expiresInSec);
  if (error) throw new Error(`Signed URL 실패: ${error.message}`);
  return data.signedUrl;
}
