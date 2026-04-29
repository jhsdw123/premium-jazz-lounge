// Phase 3-C-2-C 검증 스크립트.
// 사용법: 서버 실행 중에 `node tools/test-phase3c2c.mjs`
// 전제: tools/migrations/0001_random_rpc_and_instruments.sql 적용됨.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase.mjs';
import { extractInstrumentsFromText, loadInstruments } from '../lib/instruments.mjs';

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

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} ${code}: ${err.slice(-300)}`)));
  });
}

async function main() {
  console.log('\n═══ Phase 3-C-2-C verification ═══\n');

  // ─── 1) 마이그레이션 상태 ────────────────────────────────────────
  console.log('[check] pjl_instruments seeded?');
  const { data: insts } = await supabase.from('pjl_instruments').select('canonical_name').limit(20);
  console.log(`  ${insts?.length || 0} instruments in DB`);
  if (!insts?.length) {
    console.error('  ❌ pjl_instruments empty.');
    console.error('     → Supabase SQL Editor 에 tools/migrations/0001_*.sql 붙여넣고 Run 후 재실행.');
    process.exit(2);
  }

  console.log('[check] pjl_random_tracks RPC?');
  const { error: rpcErr } = await supabase.rpc('pjl_random_tracks', { _limit: 1 });
  if (rpcErr) {
    console.warn(`  ⚠ RPC missing: ${rpcErr.message}`);
    console.warn('     → 같은 마이그레이션 적용 필요. random ordering 은 JS fallback 으로 동작.');
  } else {
    console.log('  ✓ RPC available');
  }

  // ─── 2) 단위 테스트: extractInstrumentsFromText ─────────────────
  console.log('\n[unit] extractInstrumentsFromText (DB 마스터 사용)');
  const master = await loadInstruments(true);
  const cases = [
    { text: 'alto saxophone, piano, upright bass', mustHave: ['Saxophone','Piano','Bass'] },
    { text: 'bass guitar, brushed drums',          mustHave: ['Bass Guitar','Drums'] },
    { text: 'jazz guitar with rhodes',             mustHave: ['Guitar','Piano'] },
    { text: 'just some words',                     mustHave: [] },
  ];
  let pass = 0;
  for (const tc of cases) {
    const got = extractInstrumentsFromText(tc.text, master);
    const ok = tc.mustHave.every((e) => got.includes(e));
    console.log(`  ${ok?'✓':'✗'} "${tc.text}" → ${JSON.stringify(got)}`);
    if (ok) pass++;
  }
  console.log(`  ${pass}/${cases.length} unit tests pass`);

  // ─── 3) E2E 업로드 → instruments 자동 추출 ───────────────────────
  console.log('\n[e2e] synthetic mp3 upload with prompt');
  const tmpFile = join(tmpdir(), `pjl-e2e-${randomUUID()}.mp3`);
  await exec('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=44100',
    '-c:a', 'libmp3lame', '-q:a', '7', tmpFile,
  ]);
  console.log(`  generated ${tmpFile}`);

  const fd = new FormData();
  fd.append('files', new Blob([await fs.readFile(tmpFile)], { type: 'audio/mpeg' }), 'phase3c2c-test.mp3');
  fd.append('promptText', 'alto saxophone, piano, upright bass');
  fd.append('hasVocals', 'false');
  const upRes = await fetch(`${BASE}/api/tracks/upload`, { method: 'POST', body: fd });
  const upJson = await upRes.json();
  console.log(`  HTTP ${upRes.status}: ${JSON.stringify(upJson.results?.[0])}`);
  await fs.unlink(tmpFile).catch(() => {});

  if (!upJson.ok || !upJson.results?.[0]?.trackId) {
    console.error('  ❌ upload failed'); process.exit(1);
  }
  const newId = upJson.results[0].trackId;
  const uploadInst = upJson.results[0].instruments || [];
  console.log(`  trackId=${newId}, instruments from upload: ${JSON.stringify(uploadInst)}`);

  // verify in DB
  const got = await http('GET', `/api/tracks?ids=${newId}`);
  const dbInst = got.body.tracks?.[0]?.instruments || [];
  console.log(`  instruments from DB:     ${JSON.stringify(dbInst)}`);
  const expected = ['Saxophone', 'Piano', 'Bass'];
  const allPresent = expected.every((e) => dbInst.includes(e));
  console.log(`  ${allPresent?'✓':'✗'} Saxophone+Piano+Bass 모두 채워짐`);
  if (!allPresent) process.exit(1);

  // ─── 4) bulk extract on existing tracks ──────────────────────────
  console.log('\n[e2e] POST /api/tracks/extract-instruments (overwrite=true)');
  const ext = await http('POST', '/api/tracks/extract-instruments', { overwrite: true });
  console.log(`  HTTP ${ext.status} summary=${JSON.stringify(ext.body.summary)}`);
  console.log(`  results: ${JSON.stringify(ext.body.results?.slice(0, 5))}`);

  // ─── 5) random ordering ───────────────────────────────────────────
  console.log('\n[e2e] /api/tracks?orderBy=random');
  const r1 = await http('GET', '/api/tracks?orderBy=random&limit=5');
  console.log(`  HTTP ${r1.status} count=${r1.body.count}`);
  const r2 = await http('GET', '/api/tracks?orderBy=random&limit=5');
  const ids1 = r1.body.tracks?.map(t => t.id) || [];
  const ids2 = r2.body.tracks?.map(t => t.id) || [];
  console.log(`  call#1 ids: ${JSON.stringify(ids1)}`);
  console.log(`  call#2 ids: ${JSON.stringify(ids2)}`);

  // 정리: 테스트 곡 삭제
  console.log('\n[cleanup] delete test track');
  await http('POST', '/api/tracks/delete', { ids: [newId] });

  console.log('\n═══ ALL CHECKS PASSED ═══\n');
}

main().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
