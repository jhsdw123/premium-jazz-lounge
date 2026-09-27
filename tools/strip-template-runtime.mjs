// 템플릿 설정 JSON 에 섞여 저장된 런타임 필드('_' prefix, 주로 _audioMotion) 청소.
//   2026-09-27: 에디터가 AudioMotion 인스턴스를 통째로 저장해 템플릿 목록이 25MB 였다.
//   실행 전 전체 JSON 을 data/temp/ 에 백업한다. 화면에 그리는 값은 하나도 안 바뀐다.
//
//   node tools/strip-template-runtime.mjs                   # pjl_templates.config_json 미리보기
//   node tools/strip-template-runtime.mjs --apply           # 백업 후 실제 갱신
//   node tools/strip-template-runtime.mjs --videos [--apply] # pjl_video_projects.template_json (빌드 때 복사본)
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../lib/supabase.mjs';

const apply = process.argv.includes('--apply');
const videos = process.argv.includes('--videos');
const table = videos ? 'pjl_video_projects' : 'pjl_templates';
const col = videos ? 'template_json' : 'config_json';
const label = videos ? 'build_id' : 'name';

const strip = (c) => Object.fromEntries(Object.entries(c || {}).filter(([k]) => !k.startsWith('_')));

// 한 번에 다 읽으면 (31MB) statement timeout — id 먼저 받고 10개씩 나눠 읽는다.
const { data: idRows, error } = await supabase.from(table).select('id').order('created_at');
if (error) throw error;
const data = [];
for (let i = 0; i < idRows.length; i += 10) {
  const ids = idRows.slice(i, i + 10).map((r) => r.id);
  const { data: part, error: perr } = await supabase.from(table).select(`id, ${label}, ${col}`).in('id', ids);
  if (perr) throw perr;
  data.push(...part);
}

const dirty = [];
let before = 0, after = 0;
for (const t of data) {
  const cfg = t[col];
  const b = JSON.stringify(cfg ?? null).length;
  before += b;
  if (!Array.isArray(cfg?.components)) { after += b; continue; }
  const clean = { ...cfg, components: cfg.components.map(strip) };
  const a = JSON.stringify(clean).length;
  after += a;
  if (a !== b) dirty.push({ id: t.id, name: t[label], b, a, clean });
}
console.log(`${table} ${data.length}개 · 청소 대상 ${dirty.length}개 · ${(before / 1e6).toFixed(2)}MB → ${(after / 1e6).toFixed(2)}MB`);

if (!apply) { console.log('(미리보기 — 실제 갱신은 --apply)'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.resolve(import.meta.dirname, `../data/temp/${table}-${col}-backup-${stamp}.json`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, JSON.stringify(data.map((t) => ({ id: t.id, [label]: t[label], [col]: t[col] }))));
console.log(`백업: ${backup}`);

let fail = 0;
for (const d of dirty) {
  const { error: uerr } = await supabase.from(table).update({ [col]: d.clean }).eq('id', d.id);
  if (uerr) { fail++; console.error(`${d.name} 실패: ${uerr.message}`); continue; }
  console.log(`${d.name}: ${(d.b / 1e3).toFixed(0)}KB → ${(d.a / 1e3).toFixed(0)}KB`);
}
console.log(`완료 ${dirty.length - fail}개 · 실패 ${fail}개`);
