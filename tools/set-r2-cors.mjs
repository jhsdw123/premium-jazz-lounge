// R2 버킷 CORS 설정 (Studio 시각화/mp4 export 용 — crossOrigin + decodeAudioData).
// 토큰 권한이 부족하면 AccessDenied 가 뜨며, 그 경우 Cloudflare 대시보드에서 수동 설정해야 함.
import { PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { s3, S3_BUCKET } from '../lib/s3.mjs';

const ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:4001,http://127.0.0.1:4001')
  .split(',').map((s) => s.trim()).filter(Boolean);

const config = {
  Bucket: S3_BUCKET,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: ORIGINS,
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Length', 'Content-Range', 'Content-Type', 'ETag', 'Accept-Ranges'],
      MaxAgeSeconds: 3600,
    }],
  },
};

try {
  await s3.send(new PutBucketCorsCommand(config));
  const cur = await s3.send(new GetBucketCorsCommand({ Bucket: S3_BUCKET }));
  console.log('✓ R2 CORS 설정 완료. Origins:', ORIGINS.join(', '));
  console.log(JSON.stringify(cur.CORSRules, null, 2));
} catch (e) {
  console.error('✗ CORS 설정 실패:', e.name, e.message);
  console.error('\n→ 토큰 권한 부족일 수 있음. Cloudflare 대시보드에서 수동 설정:');
  console.error('   R2 → 버킷(pjl-jazz-tracks) → Settings → CORS Policy → 아래 JSON 붙여넣기:');
  console.error(JSON.stringify(config.CORSConfiguration.CORSRules, null, 2));
  process.exitCode = 1;
}
