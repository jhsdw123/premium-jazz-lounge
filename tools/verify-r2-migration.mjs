// R2 마이그레이션 검증 (읽기 전용, 아무것도 변경 안 함)
import { HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { supabase } from '../lib/supabase.mjs';
import { s3, S3_BUCKET } from '../lib/s3.mjs';

async function countTracks() {
  const { count, error } = await supabase
    .from('pjl_tracks')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .not('storage_path', 'is', null);
  if (error) throw error;
  return count;
}

async function sampleR2(n) {
  const { data } = await supabase
    .from('pjl_tracks')
    .select('storage_path')
    .eq('is_active', true)
    .not('storage_path', 'is', null)
    .limit(n);
  let ok = 0, miss = 0;
  for (const t of data) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: t.storage_path }));
      ok++;
    } catch { miss++; }
  }
  return { ok, miss, checked: data.length };
}

async function templates() {
  const { data, error } = await supabase
    .from('pjl_templates')
    .select('id, name, background_image_url');
  if (error) return { err: error.message };
  const withBg = data.filter((t) => t.background_image_url);
  const supabaseUrls = withBg.filter((t) =>
    /supabase\.co/.test(t.background_image_url || '')
  );
  return {
    total: data.length,
    withBg: withBg.length,
    pointingToSupabase: supabaseUrls.length,
    sample: withBg.slice(0, 3).map((t) => ({
      id: t.id, name: t.name,
      url: (t.background_image_url || '').slice(0, 70) + '...',
    })),
  };
}

const trackCount = await countTracks();
const r2 = await sampleR2(5);
const tpl = await templates();

console.log('\n=== R2 마이그레이션 검증 ===');
console.log(`DB 활성 트랙(storage_path 보유): ${trackCount}개`);
console.log(`R2 샘플 존재확인: ${r2.ok}/${r2.checked} 존재, ${r2.miss} 누락`);
console.log('\n=== 템플릿(pjl_templates) ===');
console.log(JSON.stringify(tpl, null, 2));
console.log('');
