import { randomUUID } from 'node:crypto';
import { supabase, SUPABASE_BUCKET } from './supabase.mjs';
import { sanitizeFilename } from './track-utils.mjs';

/**
 * 곡 파일을 Supabase Storage 에 업로드.
 * 경로: tracks/{uuid}_{sanitizedName}
 *
 * @returns {{ path: string, publicUrl: string|null }}
 */
export async function uploadTrack(buffer, filename, mimeType = 'audio/mpeg') {
  const safe = sanitizeFilename(filename);
  const path = `tracks/${randomUUID()}_${safe}`;

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(path, buffer, {
      contentType: mimeType || 'audio/mpeg',
      cacheControl: '3600',
      upsert: false,
    });
  if (error) throw new Error(`Storage upload 실패: ${error.message}`);

  // private 버킷이면 publicUrl 은 직접 접근 불가하지만 path 의 안정적 reference 로 보관
  const { data: urlData } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(data.path);

  return { path: data.path, publicUrl: urlData?.publicUrl ?? null };
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
