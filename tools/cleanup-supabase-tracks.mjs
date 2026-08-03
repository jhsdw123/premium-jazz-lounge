// =============================================================================
// Supabase Storage 의 음악 파일(tracks/*) 정리 — R2 이전 완료분만 삭제.
//
// 안전 원칙:
//   - 대상은 오직 `tracks/` prefix (음악). template-bg/(이미지) 및 그 외는 절대 건드리지 않음.
//   - 각 파일이 R2 에 실제로 존재(HeadObject)하는 것만 삭제. 백업 없으면 건너뜀.
//   - DB(pjl_tracks 등) 는 일절 수정하지 않음 (storage_path 는 R2 에서 그대로 유효).
//
// 사용법:
//   node tools/cleanup-supabase-tracks.mjs            # DRY-RUN (미리보기, 삭제 안 함)
//   node tools/cleanup-supabase-tracks.mjs --delete   # 실제 삭제
// =============================================================================

import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { supabase, SUPABASE_BUCKET } from '../lib/supabase.mjs';
import { s3, S3_BUCKET } from '../lib/s3.mjs';

const DO_DELETE = process.argv.includes('--delete');
const PREFIX = 'tracks';

async function listAll(prefix) {
  const out = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    if (!data || data.length === 0) break;
    // 폴더 엔트리(id=null) 제외, 실제 파일만
    for (const f of data) {
      if (f.id === null) continue;
      out.push({ key: `${prefix}/${f.name}`, size: f.metadata?.size ?? 0 });
    }
    if (data.length < PAGE) break;
  }
  return out;
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

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

async function main() {
  console.log('─'.repeat(60));
  console.log(`Supabase(${SUPABASE_BUCKET}) 의 ${PREFIX}/ 정리`);
  console.log(DO_DELETE ? '*** 실제 삭제 모드 ***' : '*** DRY-RUN (삭제 안 함) ***');
  console.log('R2 에 백업 확인된 파일만 삭제. template-bg/ 및 기타는 건드리지 않음.');
  console.log('─'.repeat(60));

  const files = await listAll(PREFIX);
  console.log(`${PREFIX}/ 내 파일: ${files.length}개\n`);

  const backedUp = [];
  const notBackedUp = [];
  for (const f of files) {
    if (await existsInR2(f.key)) backedUp.push(f);
    else notBackedUp.push(f);
  }

  const backedUpMB = backedUp.reduce((a, f) => a + f.size, 0);
  console.log(`R2 백업 확인됨 (삭제 대상): ${backedUp.length}개, ${mb(backedUpMB)}MB`);
  console.log(`R2 에 없음 (건너뜀, 보존):   ${notBackedUp.length}개`);
  if (notBackedUp.length) {
    console.log('  ↳ 백업 안 된 파일(삭제 안 함):');
    for (const f of notBackedUp.slice(0, 20)) console.log(`     - ${f.key}`);
    if (notBackedUp.length > 20) console.log(`     ... 외 ${notBackedUp.length - 20}개`);
  }

  if (!DO_DELETE) {
    console.log('\n미리보기만 했음. 실제 삭제하려면: node tools/cleanup-supabase-tracks.mjs --delete');
    return;
  }

  if (backedUp.length === 0) { console.log('\n삭제할 것 없음.'); return; }

  console.log('\n삭제 진행...');
  let removed = 0;
  const CHUNK = 100;
  for (let i = 0; i < backedUp.length; i += CHUNK) {
    const batch = backedUp.slice(i, i + CHUNK).map((f) => f.key);
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(batch);
    if (error) { console.log(`  ✗ 배치 삭제 실패: ${error.message}`); continue; }
    removed += batch.length;
    console.log(`  ✓ ${removed}/${backedUp.length} 삭제됨`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`완료: ${removed}개 삭제 (~${mb(backedUpMB)}MB 확보). 건너뜀(보존) ${notBackedUp.length}개. template-bg/ 보존.`);
  console.log('─'.repeat(60));
}

main().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
