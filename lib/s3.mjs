import { S3Client } from '@aws-sdk/client-s3';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// .env.local 명시적 로드 (supabase.mjs 와 동일 패턴 — CWD 무관, ESM 호이스팅 안전).
const __envFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.env.local'
);
config({ path: __envFile });

// S3 호환 스토리지 설정. Cloudflare R2 / MinIO / 기타 S3 호환 백엔드 공용.
// 나중에 R2 → MinIO(자체 VPS) 로 옮길 때 코드 수정 없이 이 env 값만 교체하면 됨.
//   - R2:    S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com, S3_FORCE_PATH_STYLE=false
//   - MinIO: S3_ENDPOINT=https://my-vps:9000,                        S3_FORCE_PATH_STYLE=true
export const S3_ENDPOINT = process.env.S3_ENDPOINT;
export const S3_BUCKET =
  process.env.S3_BUCKET || process.env.SUPABASE_STORAGE_BUCKET || 'pjl-jazz-tracks';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_FORCE_PATH_STYLE =
  String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';

function fail(missing) {
  const msg = [
    '',
    '❌  S3/R2 스토리지 설정 누락:',
    ...missing.map((k) => `   - ${k}`),
    '',
    `   .env.local 경로: ${__envFile}`,
    '   R2 값 위치: Cloudflare Dashboard → R2 → Manage R2 API Tokens',
    '',
  ].join('\n');
  throw new Error(msg);
}

const missing = [];
if (!S3_ENDPOINT) missing.push('S3_ENDPOINT');
if (!S3_ACCESS_KEY_ID) missing.push('S3_ACCESS_KEY_ID');
if (!S3_SECRET_ACCESS_KEY) missing.push('S3_SECRET_ACCESS_KEY');
if (missing.length) fail(missing);

export const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
  // 최신 aws-sdk-js v3 의 기본 CRC32 무결성 체크섬이 일부 S3 호환 백엔드와
  // 충돌하는 사례가 있어, 필요할 때만 계산하도록 보수적으로 설정.
  requestChecksumCalculation: 'when_required',
  responseChecksumValidation: 'when_required',
});

export default s3;
