import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'pjl-jazz-tracks';

function fail(missing) {
  const msg = [
    '',
    '❌  Supabase 설정 누락:',
    ...missing.map(k => `   - ${k}`),
    '',
    '   .env.local 파일을 열어 위 값들을 채워주세요.',
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
