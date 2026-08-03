// =============================================================================
// 템플릿 배경(template-bg/*) Supabase → R2 마이그레이션 + DB 정규화
//
// pjl_templates.background_image_url 이 Supabase signed URL(또는 풀 URL)인 경우:
//   1) URL 에서 객체 Key(template-bg/..) 추출
//   2) Supabase Storage 에서 다운로드 → R2 동일 Key 로 업로드(이미 있으면 건너뜀)
//   3) DB background_image_url 을 "Key(path)" 로 갱신
//      → 이후 서버가 GET 시점에 fresh signed URL 로 재서명(7일 만료 문제 해소)
//
// 멱등: 이미 path 로 저장됐고 R2 에 객체 있으면 건너뜀.
//
// 사용법:
//   node tools/migrate-template-bg-to-r2.mjs --dry-run
//   node tools/migrate-template-bg-to-r2.mjs
// =============================================================================

import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { supabase, SUPABASE_BUCKET } from '../lib/supabase.mjs';
import { s3, S3_BUCKET } from '../lib/s3.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

const EXT_TO_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', mp4: 'video/mp4',
};
function mimeFor(key, blobType) {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const ext = (key || '').toLowerCase().match(/\.([^.\\\/]+)$/)?.[1];
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}
function keyFromValue(v) {
  if (!v) return null;
  const m = String(v).match(/template-bg\/[^?"'\s]+/);
  return m ? m[0] : null;
}
async function existsInR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
    throw e;
  }
}

async function main() {
  console.log('─'.repeat(60));
  console.log(`템플릿 배경 ${SUPABASE_BUCKET} → R2(${S3_BUCKET}) 마이그레이션`);
  console.log(DRY_RUN ? '*** DRY-RUN ***' : '실제 실행 모드');
  console.log('─'.repeat(60));

  const { data: rows, error } = await supabase
    .from('pjl_templates')
    .select('id, name, background_image_url')
    .not('background_image_url', 'is', null);
  if (error) throw error;

  let migrated = 0, skipped = 0, dbFixed = 0, dlErr = 0, upErr = 0, noKey = 0;

  for (const t of rows) {
    const key = keyFromValue(t.background_image_url);
    const tag = `#${t.id} ${t.name}`;
    if (!key) { console.log(`  ? ${tag} — Key 추출 불가: ${String(t.background_image_url).slice(0, 50)}`); noKey++; continue; }

    const already = await existsInR2(key);
    const alreadyPath = t.background_image_url === key; // DB 가 이미 path

    if (already && alreadyPath) { console.log(`  ⏭ ${tag} — 이미 완료`); skipped++; continue; }

    if (DRY_RUN) {
      console.log(`  · ${tag} — ${already ? 'R2존재' : '업로드필요'}, DB→path ${alreadyPath ? '불필요' : '필요'} (${key})`);
      migrated++; continue;
    }

    // R2 에 없으면 Supabase 에서 받아 업로드
    if (!already) {
      try {
        const { data: blob, error: dErr } = await supabase.storage
          .from(SUPABASE_BUCKET).download(key);
        if (dErr) throw dErr;
        const buf = Buffer.from(await blob.arrayBuffer());
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET, Key: key, Body: buf,
          ContentType: mimeFor(key, blob.type), CacheControl: '86400',
        }));
        console.log(`  ✓ ${tag} — R2 업로드 (${(buf.length / 1024).toFixed(0)}KB)`);
        migrated++;
      } catch (e) {
        console.log(`  ✗ ${tag} — 이전 실패: ${e.message}`);
        if (/download|not found|object/i.test(e.message)) dlErr++; else upErr++;
        continue;
      }
    }

    // DB 를 path 로 갱신
    const { error: uErr } = await supabase
      .from('pjl_templates')
      .update({ background_image_url: key })
      .eq('id', t.id);
    if (uErr) { console.log(`  ✗ ${tag} — DB 갱신 실패: ${uErr.message}`); upErr++; continue; }
    dbFixed++;
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`완료: 이전 ${migrated} / 건너뜀 ${skipped} / DB→path 갱신 ${dbFixed} / Key불가 ${noKey} / 다운로드실패 ${dlErr} / 기타실패 ${upErr}`);
  console.log('─'.repeat(60));
  if (dlErr || upErr) process.exitCode = 1;
}

main().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
