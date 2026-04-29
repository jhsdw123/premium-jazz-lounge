/**
 * 텍스트(주로 Suno 프롬프트) 에서 악기 자동 추출.
 *
 * 정책:
 *  - pjl_instruments 테이블의 canonical_name + aliases 마스터 리스트 사용.
 *  - word-boundary 매칭 (\b).
 *  - 긴 alias 부터 매칭 → 매칭된 자리는 공백으로 마스킹 → 짧은 alias 가
 *    같은 자리를 다시 매칭하는 것 방지.
 *      예: "bass guitar" 이 "Bass Guitar" 로 잡히고 나면, "bass" 만으로 "Bass"
 *      가 추가로 잡히지 않음.
 */

import { supabase } from './supabase.mjs';

let cache = null;
let cacheAt = 0;
const TTL_MS = 5 * 60 * 1000;

/**
 * pjl_instruments 마스터 리스트 로드 (in-memory cache).
 * @returns {Promise<Array<{ canonical: string, aliases: string[] }>>}
 *          aliases 는 canonical_name 자체를 포함하고 모두 소문자.
 */
export async function loadInstruments(force = false) {
  if (!force && cache && (Date.now() - cacheAt) < TTL_MS) return cache;
  const { data, error } = await supabase
    .from('pjl_instruments')
    .select('canonical_name, aliases');
  if (error) throw new Error(`pjl_instruments 조회 실패: ${error.message}`);
  cache = (data || []).map((r) => ({
    canonical: r.canonical_name,
    aliases: [r.canonical_name, ...(r.aliases || [])]
      .filter(Boolean)
      .map((a) => String(a).toLowerCase().trim())
      .filter((a) => a.length > 0),
  }));
  cacheAt = Date.now();
  return cache;
}

export function clearInstrumentsCache() {
  cache = null; cacheAt = 0;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 순수 함수 — 마스터 리스트와 텍스트 받아서 매칭된 canonical_name 배열 반환.
 *
 * @param {string} text
 * @param {Array<{ canonical: string, aliases: string[] }>} masterList
 * @returns {string[]}
 */
export function extractInstrumentsFromText(text, masterList) {
  if (!text || !masterList?.length) return [];

  // (canonical, alias) 페어로 평탄화 + 길이 DESC 정렬
  const pairs = [];
  for (const inst of masterList) {
    for (const a of inst.aliases) {
      pairs.push({ canonical: inst.canonical, alias: a });
    }
  }
  pairs.sort((a, b) => b.alias.length - a.alias.length);

  let working = String(text).toLowerCase();
  const found = new Set();

  for (const p of pairs) {
    const re = new RegExp(`\\b${escapeRegex(p.alias)}\\b`);
    if (re.test(working)) {
      found.add(p.canonical);
      // 같은 alias 의 모든 등장을 마스킹 (짧은 alias 가 부분 매칭하는 것 방지)
      const reG = new RegExp(`\\b${escapeRegex(p.alias)}\\b`, 'g');
      working = working.replace(reG, ' '.repeat(p.alias.length));
    }
  }
  return Array.from(found);
}

/**
 * 편의 wrapper: DB 마스터 리스트 자동 로드 + 추출.
 * 마스터 리스트가 비어있거나 로드 실패 시 [] 반환 (호출자는 항상 배열 받음).
 */
export async function detectInstruments(text) {
  if (!text) return [];
  let master;
  try {
    master = await loadInstruments();
  } catch (e) {
    console.warn(`[instruments] master load failed: ${e.message}`);
    return [];
  }
  if (!master.length) return [];
  return extractInstrumentsFromText(text, master);
}
