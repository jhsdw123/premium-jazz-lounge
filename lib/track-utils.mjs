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

/** 곡 생성 툴 — pjl_tracks.source_tool 의 허용값 (0006 마이그레이션 check 와 일치). */
export const SOURCE_TOOLS = ['suno', 'mureka', 'other'];
export const DEFAULT_SOURCE_TOOL = 'mureka';

/**
 * 파일명 → 생성 툴에서의 곡 제목 (나중에 Mureka 등에서 검색할 문자열).
 *   "Midnight Velvet.mp3"      → "Midnight Velvet"
 *   "2_Midnight Velvet.mp3"    → "Midnight Velvet"   (순서 prefix 1~5 는 내가 붙인 것)
 *   "Midnight Velvet (1).mp3"  → "Midnight Velvet"   (브라우저 중복 다운로드 꼬리표)
 * 원본 파일명은 original_filename 에 그대로 남는다.
 */
export function parseSourceTitle(filename) {
  if (!filename) return null;
  let s = String(filename).replace(/^.*[\/\\]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '');
  if (parsePrefixOrder(filename) != null) s = s.replace(/^\d+[_-]/, '');
  s = s.replace(/\s*\(\d+\)$/, '').trim();
  return s || null;
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

// 곡 장르 (pjl_tracks.genre, 2026-10-01 — migration 0007). DB 에는 key 가 저장된다.
// PJL 3D Studio(Desktop\PJL-3D-Studio\lib\track-utils.mjs)와 같은 목록 — 한쪽을 고치면 다른 쪽도 고칠 것.
// 새 장르는 맨 뒤에 추가 (DB 에 CHECK 제약이 없어 서버 목록만 고치면 됨). 업로드 때 필수, 기본 = 스윙 재즈.
export const GENRES = [
  { key: 'swing', name: '🎺 스윙 재즈' },
  { key: 'calm', name: '🌙 잔잔한 재즈 (조용한 곡)' },
  { key: 'bossa', name: '🌴 보사노바' },
  { key: 'ballad', name: '💗 재즈 발라드' },
  { key: 'blues', name: '🎸 블루스' },
  { key: 'bebop', name: '⚡ 비밥 · 업템포' },
  { key: 'lounge', name: '🍸 라운지 · 칠' },
  { key: 'reading', name: '📖 독서용 재즈' },
  { key: 'noir', name: '🥃 누아르 재즈 (PNL)' },
];
export const GENRE_KEYS = GENRES.map((g) => g.key);
export const DEFAULT_GENRE = 'swing';
