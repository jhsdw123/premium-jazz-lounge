import { createHash } from 'node:crypto';

/**
 * 파일명에서 prefix 번호 추출.
 *   "1_LoveSong.mp3"  → 1
 *   "5-track.mp3"     → 5
 *   "01_track.mp3"    → 1
 *   "6_track.mp3"     → null (1~5 범위 밖)
 *   "LoveSong.mp3"    → null
 */
export function parsePrefixOrder(filename) {
  if (!filename) return null;
  const m = String(filename).match(/^(\d+)[_-]/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 5) ? n : null;
}

/**
 * 파일 버퍼의 SHA-256 → 앞 16자 hex.
 * 64-bit truncation. 개인 규모(수천~수만 곡)에서 충돌 무시 가능.
 */
export function computeFileHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/**
 * Supabase Storage 경로용 파일명 정제.
 * 한글/공백/특수문자를 _ 로 치환하고, 디렉토리 구분자 제거.
 * 확장자(.mp3 등)는 보존.
 */
export function sanitizeFilename(name) {
  if (!name) return 'unnamed';
  const base = String(name).replace(/^.*[\/\\]/, '');
  const cleaned = base
    .replace(/[^\w\-.]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 200);
  return cleaned || 'unnamed';
}
