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
 * 제목의 첫 의미 단어 (stop word 제거 후 첫 단어). batch 내 같은 단어로 시작하는
 * 제목 폭증 ("Showa ...", "Bayou ...") 을 막기 위한 키.
 *
 * @returns {string|null}
 */
export function firstContentWord(title) {
  const norm = normalizeTitle(title);
  return norm[0] || null;
}

/**
 * existingTitles 들의 모든 의미 단어 빈도 Map.
 *
 * @param {Array<{title_en?: string, normalized_words?: string[]}> | string[]} titles
 * @returns {Map<string, number>}
 */
export function buildWordFrequency(titles) {
  const freq = new Map();
  for (const t of titles || []) {
    const words = typeof t === 'string'
      ? normalizeTitle(t)
      : (t.normalized_words?.length ? t.normalized_words : normalizeTitle(t.title_en || ''));
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return freq;
}

/**
 * 빈도 Map → 임계 이상 사용된 (= 추가 사용 금지 권장) 단어 목록.
 */
export function findHeavilyUsedWords(freq, threshold = 2) {
  const out = [];
  for (const [w, c] of freq) if (c >= threshold) out.push(w);
  return out;
}

/**
 * existingTitles 들의 첫 의미 단어 Set. batch 안에서 첫-단어 중복 차단용.
 */
export function findUsedFirstWords(titles) {
  const set = new Set();
  for (const t of titles || []) {
    const fw = typeof t === 'string'
      ? firstContentWord(t)
      : firstContentWord(t.title_en || '');
    if (fw) set.add(fw);
  }
  return set;
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
