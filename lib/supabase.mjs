import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// .env.local 명시적 로드 (이 모듈이 process.env 를 읽기 전에 실행되어야 함)
// ESM 임포트 호이스팅 때문에 server.mjs 가 아닌 여기서 로드해야 안전함.
const __envFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.env.local'
);
config({ path: __envFile });

// URL 정규화: 일부 사용자가 Supabase Dashboard 의 REST endpoint URL
// (`https://xxx.supabase.co/rest/v1/`) 을 그대로 붙여 넣는 경우가 흔함.
// supabase-js 는 base URL 뒤에 `/rest/v1`, `/storage/v1` 등을 직접 붙이므로
// 이런 trailing path 가 있으면 storage 호출이 깨짐. → 잘라낸다.
function normalizeSupabaseUrl(raw) {
  if (!raw) return raw;
  let u = raw.trim();
  u = u.replace(/\/+$/, '');                // trailing slashes
  u = u.replace(/\/rest\/v\d+$/, '');       // /rest/v1 등
  u = u.replace(/\/storage\/v\d+$/, '');    // /storage/v1 등
  return u;
}

const RAW_URL = process.env.SUPABASE_URL;
export const SUPABASE_URL = normalizeSupabaseUrl(RAW_URL);
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'pjl-jazz-tracks';

if (RAW_URL && SUPABASE_URL !== RAW_URL) {
  console.warn(`⚠  SUPABASE_URL trimmed: "${RAW_URL}" → "${SUPABASE_URL}"`);
}

function fail(missing) {
  const msg = [
    '',
    '❌  Supabase 설정 누락:',
    ...missing.map(k => `   - ${k}`),
    '',
    `   .env.local 경로: ${__envFile}`,
    '   템플릿: .env.local.example',
    '   값 위치: Supabase Dashboard → Project Settings → API',
    '',
  ].join('\n');
  throw new Error(msg);
}

const missing = [];
if (!SUPABASE_URL) missing.push('SUPABASE_URL');
if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
if (missing.length) fail(missing);

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export default supabase;
