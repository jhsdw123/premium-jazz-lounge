// =============================================================================
// Supabase Storage → Cloudflare R2 일회성 마이그레이션
//
// 동작: pjl_tracks(is_active=true) 의 storage_path 를 읽어, 각 파일을
//       기존 Supabase Storage 에서 다운로드 → R2 에 "동일한 Key" 로 업로드.
//       Key 가 그대로라 DB(storage_path)는 수정 불필요.
//
// 특징:
//   - 멱등(idempotent): R2 에 이미 있으면 건너뜀 → 몇 번 다시 돌려도 안전.
//   - 원본(Supabase) 은 건드리지 않음 → 검증 끝날 때까지 백업으로 유지.
//
// 사용법:
//   node tools/migrate-storage-to-r2.mjs           # 실제 실행
//   node tools/migrate-storage-to-r2.mjs --dry-run # 옮길 목록만 출력
// =============================================================================

import {
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { supabase, SUPABASE_BUCKET } from '../lib/supabase.mjs';
import { s3, S3_BUCKET } from '../lib/s3.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

const EXT_TO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  aac: 'audio/aac', aiff: 'audio/aiff', wma: 'audio/x-ms-wma',
};
function mimeFor(path, blobType) {
  if (blobType && blobType !== 'application/octet-stream') return blobType;
  const ext = (path || '').toLowerCase().match(/\.([^.\\\/]+)$/)?.[1];
  return EXT_TO_MIME[ext] || 'audio/mpeg';
}

async function existsInR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') return false;
    throw e; // 진짜 에러(권한 등)는 위로
  }
}

async function main() {
  console.log('─'.repeat(60));
  console.log(`Supabase(${SUPABASE_BUCKET}) → R2(${S3_BUCKET}) 마이그레이션`);
  console.log(DRY_RUN ? '*** DRY-RUN (실제 업로드 안 함) ***' : '실제 실행 모드');
  console.log('─'.repeat(60));

  // 1) 전체 활성 트랙 목록 (페이지네이션)
  const tracks = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('pjl_tracks')
      .select('id, storage_path, original_filename')
      .eq('is_active', true)
      .not('storage_path', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    tracks.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`대상 트랙: ${tracks.length}개\n`);

  let migrated = 0, skipped = 0, dlErr = 0, upErr = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const key = t.storage_path;
    const tag = `[${i + 1}/${tracks.length}] ${t.original_filename || key}`;

    // 이미 R2 에 있으면 건너뜀
    let already;
    try {
      already = await existsInR2(key);
    } catch (e) {
      console.log(`  ⚠ ${tag} — R2 확인 실패: ${e.message}`);
      upErr++;
      continue;
    }
    if (already) { console.log(`  ⏭ ${tag} — 이미 R2 존재`); skipped++; continue; }

    if (DRY_RUN) { console.log(`  · ${tag} — 옮길 예정`); migrated++; continue; }

    // 2) Supabase 에서 다운로드
    let buf, mime;
    try {
      const { data: blob, error } = await supabase.storage
        .from(SUPABASE_BUCKET).download(key);
      if (error) throw error;
      if (!blob) throw new Error('빈 응답');
      buf = Buffer.from(await blob.arrayBuffer());
      mime = mimeFor(key, blob.type);
    } catch (e) {
      console.log(`  ✗ ${tag} — 다운로드 실패: ${e.message}`);
      dlErr++;
      continue;
    }

    // 3) R2 에 동일 Key 로 업로드
    try {
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: key, Body: buf,
        ContentType: mime, CacheControl: '3600',
      }));
      console.log(`  ✓ ${tag} — ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
      migrated++;
    } catch (e) {
      console.log(`  ✗ ${tag} — 업로드 실패: ${e.message}`);
      upErr++;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`완료: 옮김 ${migrated} / 건너뜀(이미존재) ${skipped} / 다운로드실패 ${dlErr} / 업로드실패 ${upErr}`);
  console.log('─'.repeat(60));
  if (dlErr || upErr) {
    console.log('⚠ 실패 건 있음 — 위 로그 확인 후 다시 실행하면 성공분은 건너뛰고 실패분만 재시도함.');
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
