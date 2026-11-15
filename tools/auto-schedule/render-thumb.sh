#!/bin/zsh
# 썸네일 제작기(패널 🖼️ Thumbnail 탭)를 ego lite 로 조작해 썸네일 한 장을 만든다.
#   render-thumb.sh <ego TaskSpace id> "<프리셋 이름>" "<유튜브 제목 일부>" <배경.jpg> <저장.jpg>
# 순서: 프리셋 선택 → 프로젝트(유튜브 제목으로 찾음) 선택 → 배경을 루프 장면으로 교체 → 캔버스(1920×1080)를 JPG 로 저장.
# 프로젝트 목록은 "유튜브에 올린 영상"과 곡 목록으로 짝지어지므로, 예약(apply)을 먼저 끝낸 뒤 실행할 것.
set -e
SPACE=$1; PRESET=$2; TITLE=$3; BG=${4:A}; OUT=${5:A}
ego-browser nodejs <<EOF
const task = await taskSpace($SPACE);
const pages = await task.pages();
const page = pages[0] ?? (await task.adopt((await task.tabs())[0].page));
await page.goto("http://localhost:4001/", {timeout: 30000});
await page.click('[data-tab="thumbnail"]');
await page.waitForFunction(() => document.querySelectorAll('#thProjectSelect option').length > 3 && document.querySelectorAll('#thPresetSlotSelect option').length > 1, undefined, {timeout: 30000});
const ok = await page.evaluate((a) => {
  const ps = document.getElementById('thPresetSlotSelect');
  if (![...ps.options].some(o => o.value === a.preset)) return 'no-preset';
  ps.value = a.preset; ps.dispatchEvent(new Event('change'));
  return 'ok';
}, {preset: ${(qqq)PRESET}});
if (ok !== 'ok') throw new Error('프리셋 없음: ' + ${(qqq)PRESET});
await page.waitForTimeout(1500);
const idx = await page.evaluate((t) => {
  const o = [...document.querySelectorAll('#thProjectSelect option')].find(o => o.textContent.includes(t));
  if (!o) return null;
  const s = document.getElementById('thProjectSelect'); s.value = o.value; s.dispatchEvent(new Event('change'));
  return o.textContent;
}, ${(qqq)TITLE});
if (!idx) throw new Error('프로젝트 목록에 그 제목이 없음 (예약 적용 먼저?): ' + ${(qqq)TITLE});
await page.waitForFunction(() => /유튜브 제목 적용|못 찾음|실패/.test(document.getElementById('thProjectStatus').textContent), undefined, {timeout: 40000});
await page.waitForTimeout(3000);
await page.setInputFiles('#thBgImageInput', ${(qqq)BG});
await page.waitForTimeout(3000);
const st = await page.evaluate(() => document.getElementById('thProjectStatus').textContent);
const url = await page.evaluate(() => document.getElementById('thumbPreviewCanvas').toDataURL('image/jpeg', 0.92));
const fs = await import('node:fs');
fs.writeFileSync(${(qqq)OUT}, Buffer.from(url.split(',')[1], 'base64'));
console.log('프로젝트:', idx);
console.log('상태:', st);
console.log('저장:', ${(qqq)OUT});
EOF
