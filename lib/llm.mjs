/**
 * Gemini Pro 호출 + JSON 응답 파싱 + 제목 생성 prompt.
 *
 * 의존성: native fetch (Node 18+). 외부 SDK 미사용.
 */

const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';

function getApiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) {
    throw new Error('GEMINI_API_KEY 가 .env.local 에 없습니다');
  }
  return k;
}

/**
 * Gemini generateContent 단일 호출. JSON 응답 강제.
 */
export async function callGemini(prompt, opts = {}) {
  const model = process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const apiKey = getApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 1.0,
      maxOutputTokens: opts.maxOutputTokens ?? 512,
      responseMimeType: 'application/json',
      ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text;
}

/**
 * Gemini 응답 텍스트 → 제목 배열.
 *  1) 코드펜스 제거 후 JSON.parse
 *  2) {"titles": [...]} 또는 [...] 둘 다 허용
 *  3) 실패 시 따옴표로 둘러싼 문자열 추출 fallback
 */
export function parseTitlesJson(text) {
  if (!text) return [];
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  let parseFailed = false;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    parseFailed = true;
  }

  if (!parseFailed) {
    if (Array.isArray(parsed?.titles)) {
      return parsed.titles.filter((s) => typeof s === 'string' && s.trim());
    }
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === 'string' && s.trim());
    }
    // JSON 은 valid 인데 구조가 다름 → regex fallback 으로 떨어지면 JSON key 이름("titles" 등)
    // 까지 후보로 잡히는 버그 발생. 빈 배열로 short-circuit.
    return [];
  }

  // JSON.parse 실패 → 마지막 수단: 따옴표 묶인 문자열 추출 (단, JSON 키 이름 제외)
  const RESERVED = new Set(['titles', 'title']);
  const m = cleaned.match(/"([^"\n]{2,80})"/g) || [];
  return m
    .map((s) => s.slice(1, -1))
    .filter((s) => s && !RESERVED.has(s.toLowerCase()));
}

/**
 * 제목 N개 생성. JSON 파싱 실패 시 1회 재호출 (사용자 요청).
 *
 * @param {object} args
 * @param {string} args.promptText        Suno 프롬프트 (mood/instruments 힌트)
 * @param {string[]} args.avoidList       회피할 기존 제목 (rejected 포함)
 * @param {string[]} args.heavyWords      사용 빈도 높은 단어 (절대 사용 금지). Phase 4-D-5-D
 * @param {string[]} args.bannedFirstWords 첫 단어로 쓰면 안 되는 단어들. Phase 4-D-5-D
 * @param {number} args.count             후보 개수 (기본 10)
 * @param {number} args.attempt           1=첫 호출, 2+=재시도 (temperature 점증)
 */
export async function generateTitleCandidates({
  promptText = '',
  avoidList = [],
  heavyWords = [],
  bannedFirstWords = [],
  count = 10,
  attempt = 1,
}) {
  const avoidSampled = avoidList.slice(-100);              // 최근 100개만 prompt 포함
  const heavySampled = heavyWords.slice(0, 40);            // 최대 40개
  const banFirstSampled = (Array.isArray(bannedFirstWords) ? bannedFirstWords : Array.from(bannedFirstWords)).slice(0, 40);

  const promptParts = [
    'You are naming a short instrumental jazz piece for a YouTube channel.',
    'Output JSON ONLY in this exact schema: {"titles": ["Title One", "Title Two"]}.',
    'Each title is 2-4 English words, evocative, jazz-flavored mood, in Title Case.',
    'No emojis, no quotation marks inside the title text, no numbering.',
    '',
    'CRITICAL DIVERSITY REQUIREMENTS — viewers will see these as a list, repetition looks lazy:',
    '  1. EVERY candidate MUST start with a DIFFERENT first word.',
    '  2. NO two candidates may share more than ONE meaningful word.',
    '  3. Use diverse vocabulary — exotic places, instruments, weather, times of day, moods, eras, textures.',
    '  4. AVOID overusing common jazz filler (groove, bounce, swing, blues, rhythm, smooth) unless context demands.',
    banFirstSampled.length
      ? `  5. DO NOT start any title with these (already used as first word): ${banFirstSampled.join(', ')}`
      : '',
    heavySampled.length
      ? `  6. DO NOT USE these overused words at all: ${heavySampled.join(', ')}`
      : '',
    '',
    'COLLISION CONSTRAINT: Avoid sharing 2 or more meaningful words with ANY existing title below.',
    avoidSampled.length
      ? 'Existing titles to avoid:\n' + avoidSampled.map((t) => `  - ${t}`).join('\n')
      : '(no existing titles yet)',
    '',
    `Mood / instruments / context: ${promptText || 'classic instrumental jazz'}`,
    '',
    `Generate ${count} candidate titles. They MUST be dramatically different from each other (different first word + different vocabulary).`,
    attempt > 1
      ? '(Previous attempt collided. Be more creative — entirely fresh vocabulary, no recycled words.)'
      : '',
  ].filter(Boolean);

  const finalPrompt = promptParts.join('\n');
  const temperature = Math.min(1.0 + (attempt - 1) * 0.15, 1.5);

  // responseSchema 강제: Gemini 가 정확히 {"titles": ["...", ...]} 형식만 반환하도록.
  // 이게 없으면 빈 객체 / null / 잘못된 shape 가 가끔 옴.
  const responseSchema = {
    type: 'OBJECT',
    properties: {
      titles: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        minItems: count,
      },
    },
    required: ['titles'],
  };

  let text;
  try {
    text = await callGemini(finalPrompt, { temperature, responseSchema });
  } catch (e) {
    // transient 1회 재시도
    if (attempt === 1) {
      await new Promise((r) => setTimeout(r, 600));
      text = await callGemini(finalPrompt, { temperature, responseSchema });
    } else {
      throw e;
    }
  }

  const titles = parseTitlesJson(text);
  if (!titles.length && attempt === 1) {
    // JSON 파싱 실패 → 1회만 재호출 (사용자 요청한 fallback)
    return generateTitleCandidates({ promptText, avoidList, count, attempt: 2 });
  }
  return titles;
}
