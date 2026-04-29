// Phase 3-C-1 검증 스크립트.
// 사용법: node tools/test-phase3c1.mjs
// 전제: 서버가 localhost:4001 에 떠 있음.

import { supabase } from '../lib/supabase.mjs';
import { normalizeTitle, findCollision } from '../lib/title-utils.mjs';

const BASE = 'http://localhost:4001';

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}

async function main() {
  console.log('\n═══ Phase 3-C-1 verification ═══\n');

  // ─── PRE-SETUP ────────────────────────────────────────────────────
  console.log('[setup] trackId=1 의 title_id 분리');
  await supabase.from('pjl_tracks').update({ title_id: null }).eq('id', 1);

  console.log('[setup] 기존 테스트 시드 정리');
  await supabase.from('pjl_titles').delete().eq('title_en', 'Velvet Night Jazz');

  console.log('[setup] collision seed insert: "Velvet Night Jazz"');
  const seed = {
    title_en: 'Velvet Night Jazz',
    normalized_words: normalizeTitle('Velvet Night Jazz'),
    status: 'used',
    use_count: 1,
  };
  const { data: seedRow, error: seedErr } = await supabase
    .from('pjl_titles')
    .insert(seed)
    .select('id, title_en, normalized_words')
    .single();
  if (seedErr) {
    console.error('seed insert FAILED:', seedErr.message);
    process.exit(1);
  }
  console.log(`  seed.id=${seedRow.id}, normalized=${JSON.stringify(seedRow.normalized_words)}\n`);

  // ─── STEP 1: generate ─────────────────────────────────────────────
  console.log('[step 1] POST /api/titles/generate {trackId:1}');
  const g1 = await http('POST', '/api/titles/generate', { trackId: 1 });
  console.log(`  HTTP ${g1.status}`);
  console.log(`  body: ${JSON.stringify(g1.body, null, 2)}\n`);

  if (g1.status !== 200 || !g1.body.ok) {
    console.error('GENERATE FAILED. abort.');
    process.exit(1);
  }
  const firstTitle = g1.body.title.title_en;
  const firstId = g1.body.title.id;
  const firstNorm = g1.body.title.normalized_words;

  // ─── ASSERT 1: collision check vs seed ────────────────────────────
  console.log(`[assert 1] "${firstTitle}" vs seed "Velvet Night Jazz" 충돌 검사`);
  const seedNorm = normalizeTitle('Velvet Night Jazz');
  const overlap = firstNorm.filter((w) => seedNorm.includes(w));
  console.log(`  overlap: ${JSON.stringify(overlap)}`);
  if (overlap.length >= 2) {
    console.error(`  ❌ FAIL: ${overlap.length}-word collision passed through!`);
    process.exit(1);
  }
  console.log(`  ✓ PASS: ${overlap.length} word(s) overlap (< 2)\n`);

  // ─── STEP 2: reroll ───────────────────────────────────────────────
  console.log('[step 2] POST /api/titles/reroll {trackId:1, reason:"verification"}');
  const r1 = await http('POST', '/api/titles/reroll', {
    trackId: 1,
    reason: 'verification test',
  });
  console.log(`  HTTP ${r1.status}`);
  console.log(`  body: ${JSON.stringify(r1.body, null, 2)}\n`);

  if (r1.status !== 200 || !r1.body.ok) {
    console.error('REROLL FAILED. abort.');
    process.exit(1);
  }
  const secondTitle = r1.body.title.title_en;
  const secondId = r1.body.title.id;

  // ─── ASSERT 2: second != first ────────────────────────────────────
  console.log(`[assert 2] new title "${secondTitle}" (id=${secondId}) != old "${firstTitle}" (id=${firstId})`);
  if (secondId === firstId) {
    console.error('  ❌ FAIL: same title returned');
    process.exit(1);
  }
  console.log(`  ✓ PASS: distinct title\n`);

  // ─── ASSERT 3: first title is now status='rejected' ───────────────
  console.log(`[assert 3] old title id=${firstId} status='rejected' 확인`);
  const { data: oldRow } = await supabase
    .from('pjl_titles')
    .select('id, title_en, status, rejected_reason')
    .eq('id', firstId)
    .single();
  console.log(`  ${JSON.stringify(oldRow)}`);
  if (oldRow?.status !== 'rejected') {
    console.error(`  ❌ FAIL: status=${oldRow?.status}`);
    process.exit(1);
  }
  console.log(`  ✓ PASS: rejected with reason="${oldRow.rejected_reason}"\n`);

  // ─── ASSERT 4: tracks.title_id 가 새 title 가리킴 ─────────────────
  console.log(`[assert 4] tracks.id=1.title_id == ${secondId}`);
  const { data: trackRow } = await supabase
    .from('pjl_tracks')
    .select('id, title_id')
    .eq('id', 1)
    .single();
  console.log(`  ${JSON.stringify(trackRow)}`);
  if (trackRow?.title_id !== secondId) {
    console.error(`  ❌ FAIL: title_id=${trackRow?.title_id}`);
    process.exit(1);
  }
  console.log(`  ✓ PASS\n`);

  console.log('═══ ALL CHECKS PASSED ═══\n');
}

main().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
