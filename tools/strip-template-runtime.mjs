// pjl_templates.config_json 에 섞여 저장된 런타임 필드('_' prefix, 주로 _audioMotion) 청소.
//   2026-09-27: 에디터가 AudioMotion 인스턴스를 통째로 저장해 템플릿 목록이 25MB 였다.
//   실행 전 전체 config_json 을 data/temp/ 에 백업한다. 화면에 그리는 값은 하나도 안 바뀐다.
//
//   node tools/strip-template-runtime.mjs          # 미리보기 (몇 바이트 줄어드는지만)
//   node tools/strip-template-runtime.mjs --apply  # 백업 후 실제 갱신
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../lib/supabase.mjs';

const apply = process.argv.includes('--apply');
const strip = (c) => Object.fromEntries(Object.entries(c || {}).filter(([k]) => !k.startsWith('_')));

const { data, error } = await supabase.from('pjl_templates').select('id, name, config_json').order('id');
if (error) throw error;

const dirty = [];
let before = 0, after = 0;
for (const t of data) {
  const cfg = t.config_json;
  const b = JSON.stringify(cfg).length;
  before += b;
  if (!Array.isArray(cfg?.components)) { after += b; continue; }
  const clean = { ...cfg, components: cfg.components.map(strip) };
  const a = JSON.stringify(clean).length;
  after += a;
  if (a !== b) dirty.push({ id: t.id, name: t.name, b, a, clean });
}
console.log(`템플릿 ${data.length}개 · 청소 대상 ${dirty.length}개 · ${(before / 1e6).toFixed(2)}MB → ${(after / 1e6).toFixed(2)}MB`);

if (!apply) { console.log('(미리보기 — 실제 갱신은 --apply)'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.resolve(import.meta.dirname, `../data/temp/templates-config-backup-${stamp}.json`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, JSON.stringify(data.map(({ id, name, config_json }) => ({ id, name, config_json }))));
console.log(`백업: ${backup}`);

for (const d of dirty) {
  const { error: uerr } = await supabase.from('pjl_templates').update({ config_json: d.clean }).eq('id', d.id);
  if (uerr) { console.error(`#${d.id} ${d.name} 실패: ${uerr.message}`); continue; }
  console.log(`#${d.id} ${d.name}: ${(d.b / 1e3).toFixed(0)}KB → ${(d.a / 1e3).toFixed(0)}KB`);
}
