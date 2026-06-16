// 기존 pjl_tracks.original_filename 깨짐(mojibake) 복구.
//   multer(busboy) 가 multipart 파일명을 latin1 로 디코드한 탓에, 과거 업로드된
//   한글/특수문자 파일명이 ` ì¬ì¦_ë°¤ê±°ë¦¬.mp3 ` 식으로 저장돼 있다.
//   이 스크립트가 latin1→utf8 재해석으로 원본을 복원한다.
//
// 사용:
//   node tools/repair-filenames.mjs           # dry-run (바뀔 것만 출력, DB 변경 X)
//   node tools/repair-filenames.mjs --apply    # 실제 UPDATE
//
// 안전장치:
//   - 순수 ASCII / 이미 정상 유니코드 / 재해석 실패(U+FFFD) 는 건드리지 않음(서버와 동일 로직).
//   - is_active 무관 전체 row 대상(soft-delete 포함) — 표시는 active 만이지만 일관성 위해 다 고침.

import { supabase } from '../lib/supabase.mjs';

const APPLY = process.argv.includes('--apply');

// server.mjs 의 decodeOriginalName 과 동일 로직 (단일 출처 유지: 변경 시 양쪽 같이).
function decodeOriginalName(name) {
  if (!name) return name;
  if (/[^\x00-\xff]/.test(name)) return name;
  const reinterpreted = Buffer.from(name, 'latin1').toString('utf8');
  if (reinterpreted.includes('�')) return name;
  return reinterpreted;
}

async function main() {
  const { data, error } = await supabase
    .from('pjl_tracks')
    .select('id, original_filename')
    .not('original_filename', 'is', null);
  if (error) throw new Error(`조회 실패: ${error.message}`);

  const changes = [];
  for (const row of data) {
    const fixed = decodeOriginalName(row.original_filename);
    if (fixed !== row.original_filename) {
      changes.push({ id: row.id, from: row.original_filename, to: fixed });
    }
  }

  console.log(`총 ${data.length} row 중 복구 대상 ${changes.length} 개\n`);
  for (const c of changes) {
    console.log(`  #${c.id}`);
    console.log(`    - ${c.from}`);
    console.log(`    + ${c.to}`);
  }

  if (!changes.length) {
    console.log('\n복구할 항목 없음.');
    return;
  }

  if (!APPLY) {
    console.log('\n[dry-run] 실제 변경하려면 --apply 붙여서 다시 실행.');
    return;
  }

  let ok = 0, fail = 0;
  for (const c of changes) {
    const { error: uerr } = await supabase
      .from('pjl_tracks')
      .update({ original_filename: c.to })
      .eq('id', c.id);
    if (uerr) { fail++; console.error(`  #${c.id} 실패: ${uerr.message}`); }
    else ok++;
  }
  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
