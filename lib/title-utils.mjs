/**
 * 제목 정규화 + 패턴 충돌 검사.
 *
 * 정책: 두 제목이 의미 있는 단어 ≥2개를 공유하면 충돌.
 *   "Velvet Night Jazz" vs "Velvet Blue Jazz" → {velvet, jazz} 2개 → 충돌.
 *   "Velvet Night Jazz" vs "Smooth Blue Jazz" → {jazz} 1개 → OK.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'and', 'or', 'but', 'by', 'is', 'are', 'was', 'were', 'be', 'been',
  'as', 'from', 'into', 'through', 'over', 'under', 'before', 'after',
  'i', 'me', 'my', 'mine', 'we', 'our', 'us',
  'you', 'your', 'he', 'she', 'his', 'her', 'it', 'its', 'they', 'their',
  'this', 'that', 'these', 'those',
  // 흔한 grammatical filler — 충돌 노이즈
  'oh', 'eh', 'ah', 'na',
]);

/**
 * 제목 → 정규화된 의미 단어 배열.
 *  - 소문자
 *  - 비-알파벳 → 공백
 *  - 길이 ≥2, stop words 제외
 */
export function normalizeTitle(title) {
  if (!title) return [];
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w && w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * candidate (정규화 단어 배열) 가 existingTitles 중 하나와 ≥2 단어 충돌하는지.
 *
 * @param {string[]} candidateNorm
 * @param {Array<{ id?: number, title_en: string, normalized_words?: string[] }>} existingTitles
 * @returns {null | { existingId, existingTitle, overlapWords }}
 */
export function findCollision(candidateNorm, existingTitles) {
  if (!candidateNorm || candidateNorm.length === 0) return null;
  const candSet = new Set(candidateNorm);
  for (const ex of existingTitles || []) {
    const words = (ex.normalized_words && ex.normalized_words.length)
      ? ex.normalized_words
      : normalizeTitle(ex.title_en);
    const overlap = [];
    for (const w of words) {
      if (candSet.has(w)) overlap.push(w);
      if (overlap.length >= 2) {
        return {
          existingId: ex.id ?? null,
          existingTitle: ex.title_en,
          overlapWords: overlap,
        };
      }
    }
  }
  return null;
}
