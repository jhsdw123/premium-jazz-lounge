// PJL 자동 예약 도구 — Claude 가 "재즈 예약 걸어줘" 요청 때 쓰는 명령 모음.
// 패널(localhost:4001)이 켜져 있어야 함. 순서 설명서 = ~/.claude/skills/pjl-auto-schedule/SKILL.md
//
//   node tools/auto-schedule/pjl-auto.mjs pending                  비공개·예약없는 영상 + 짝 프로젝트 후보
//   node tools/auto-schedule/pjl-auto.mjs titles                   안 쓴 제목 목록(분류별) + 최근 대괄호 문구
//   node tools/auto-schedule/pjl-auto.mjs frame <loopKey> <out.jpg> 루프 영상 1초 장면 → 썸네일 배경
//   node tools/auto-schedule/pjl-auto.mjs generate <videoId> <projectId> "<제목>"   제미나이 설명 생성(제목 고정) + 검사
//   node tools/auto-schedule/pjl-auto.mjs apply <videoId> [--dry]  드라이런 → 다음 월/목 16:30 SGT 예약 적용
//   node tools/auto-schedule/pjl-auto.mjs preset "<이름>" '<테마JSON>'  썸네일 스타일(프리셋) 저장
//   node tools/auto-schedule/pjl-auto.mjs upload-thumb <videoId> <jpg>  유튜브 썸네일 올리기
//   node tools/auto-schedule/pjl-auto.mjs status                   비공개 영상 예약 상태
//
// 생성 결과·로그: data/auto-schedule/<videoId>.*.json

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: join(ROOT, '.env.local') });
const API = process.env.PJL_PANEL_URL || 'http://localhost:4001';
const OUT = join(ROOT, 'data', 'auto-schedule');
fs.mkdirSync(OUT, { recursive: true });
const LOOP_DIR = process.env.PJL_LOOP_DIR || join(os.homedir(), 'Desktop', 'PJLLoopvideo');

async function get(p) {
  const r = await fetch(API + p);
  const j = await r.json();
  if (!j.ok) throw new Error(`${p}: ${j.error || r.status}`);
  return j;
}
async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${p}: ${j.error || r.status}`);
  return j;
}
async function supa() {
  const { createClient } = await import('@supabase/supabase-js');
  const e = process.env;
  return createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_SERVICE_KEY || e.SUPABASE_ANON_KEY);
}
const lane = (t) => (t.match(/^\[([^\]]+)\]/) || [])[1] || '';
const kstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(2, 10).replace(/-/g, '');

// 프로젝트 → pjl_track_usage 의 export(video_id). 첫 곡이 1번 자리였던 export 중 프로젝트 생성 시각에 가장 가까운 것.
async function exportFor(project) {
  const sb = await supa();
  const first = project.tracks?.[0]?.id;
  const { data, error } = await sb.from('pjl_track_usage').select('video_id, used_at').eq('track_id', first).eq('track_position', 1);
  if (error) throw error;
  const t0 = Date.parse(project.created_at);
  const c = (data || []).filter((u) => Date.parse(u.used_at) >= t0 - 3600e3)
    .sort((a, b) => Date.parse(a.used_at) - Date.parse(b.used_at))[0];
  return c ? { firstTrackId: first, exportId: c.video_id, usedAt: c.used_at } : null;
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (cmd === 'pending') {
  const { videos } = await get('/api/youtube/videos?max=50');
  // --test "<영상 이름>" : 짝 찾기만 시험 (이미 올린 프로젝트까지 후보에 포함)
  const testName = args[0] === '--test' ? args[1] : null;
  const pend = testName ? [{ id: 'TEST', title: testName }] : videos.filter((v) => v.privacyStatus !== 'public' && !v.publishAt);
  const { videos: projects } = await get('/api/videos/recent?limit=30&done=1&yt=1');
  const free = testName ? projects : projects.filter((p) => !p.youtube);
  const out = [];
  for (const v of pend) {
    // 영상 이름 예: "261105 51분 3h22m" → 날짜(KST) + 한 바퀴 길이(분)
    const m = v.title.match(/(\d{6})\s+(\d+)분/);
    const cands = free.map((p) => {
      const mins = Math.round((p.total_duration_sec || 0) / 60);
      const score = (m && kstDate(p.created_at) === m[1] ? 2 : 0) + (m && Math.abs(mins - Number(m[2])) <= 1 ? 2 : 0);
      return { projectId: p.id, build: p.build_id, created: p.created_at, minutes: mins, tracks: p.tracks?.length,
        first3: (p.tracks || []).slice(0, 3).map((t) => t.title_en), loopKey: p.template?.config_json?.backgroundVideo?.key
          || (typeof p.template?.config_json === 'string' ? JSON.parse(p.template.config_json).backgroundVideo?.key : null), score };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
    out.push({ videoId: v.id, ytTitle: v.title, uploaded: v.publishedAt, thumbnail: v.thumbnail, candidates: cands });
  }
  fs.writeFileSync(join(OUT, 'pending.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (!out.length) console.log('비공개·예약없는 영상 없음');
} else if (cmd === 'titles') {
  const lib = await get('/api/titles/library');
  const { videos } = await get('/api/youtube/videos?max=50');
  const used = new Set(videos.map((v) => v.title.trim().toLowerCase()));
  const recent = videos.filter((v) => v.publishAt || v.privacyStatus === 'public').slice(0, 8).map((v) => `${(v.publishAt || v.publishedAt || '').slice(0, 10)} [${lane(v.title)}] ${v.title.slice(0, 70)}`);
  console.log('## 최근/예약 영상 (대괄호 문구 겹치지 않게)\n' + recent.join('\n'));
  for (const m of lib.months) {
    console.log(`\n## ${m.month}`);
    for (const t of m.titles) console.log(`${used.has(t.title.toLowerCase()) ? '✓쓴것 ' : ''}${t.id} ${t.title}`);
  }
} else if (cmd === 'frame') {
  const [key, out] = args;
  const src = join(LOOP_DIR, `${key}.mp4`);
  if (!fs.existsSync(src)) throw new Error(`루프 영상 없음: ${src}`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '1', '-i', src, '-frames:v', '1', '-q:v', '2', resolve(out)]);
  console.log('저장:', resolve(out));
} else if (cmd === 'generate') {
  const [videoId, projectId, title] = args;
  const { videos: projects } = await get('/api/videos/recent?limit=30&done=1');
  const p = projects.find((x) => x.id === projectId);
  if (!p) throw new Error('프로젝트 없음: ' + projectId);
  const ex = await exportFor(p);
  if (!ex) throw new Error('곡 사용 기록(export) 못 찾음');
  const tr = await get(`/api/tracks/${ex.firstTrackId}/last-video?video=${encodeURIComponent(ex.exportId)}`);
  const lib = await get('/api/titles/library');
  const entry = lib.months.flatMap((m) => m.titles).find((t) => t.title === title);
  if (!entry) throw new Error('제목 목록에 없는 제목 (정확히 복사할 것): ' + title);
  console.log(`곡 ${tr.track_count}개 (${ex.exportId}) · 첫 곡 ${tr.tracks[0]?.title} · 마지막 곡 시작 ${tr.tracks.at(-1)?.timecode}`);
  const d = await post('/api/uploader/path-b/generate', { seriesName: '', volNumber: null, mood: '', scenarios: '', era: '', notes: '', baseTitle: title, newTracks: tr.tracks });
  const g = d.generated;
  const exp = { ...entry.i18n };
  const mism = Object.entries(exp).filter(([l, v]) => g.localizations?.[l]?.title !== v).map(([l]) => l);
  const all = [g.title?.default, g.description?.default, ...Object.values(g.localizations || {}).flatMap((x) => [x.title, x.description])].join('\n');
  const check = { fixedTitles: g.fixedTitles, enOk: g.title?.default === title, langs: Object.keys(g.localizations || {}).length,
    mismatch: mism, missing: g.missingLanguages, volMention: /\bVol\.?\s*\d/i.test(all), geminiSec: d.geminiElapsed };
  fs.writeFileSync(join(OUT, `${videoId}.gen.json`), JSON.stringify({ projectId, title, exportId: ex.exportId, generated: g }, null, 2));
  console.log(JSON.stringify(check));
  if (!check.enOk || mism.length || check.volMention || check.langs < 16) { console.log('⚠ 검사 실패 — 적용하지 말 것'); process.exit(3); }
  console.log('✅ 검사 통과 →', join(OUT, `${videoId}.gen.json`));
} else if (cmd === 'apply') {
  const [videoId] = args;
  const dry = args.includes('--dry');
  const { generated } = JSON.parse(fs.readFileSync(join(OUT, `${videoId}.gen.json`), 'utf8'));
  const ns = await get('/api/uploader/next-schedule');
  const body = { videoId, generatedMeta: generated, scheduleAt: ns.nextSlot, playlistIds: [], dryRun: true };
  const dr = await post('/api/uploader/apply', body);
  console.log('드라이런:', dr.plan.updateSnippet.title, '|', dr.plan.updateLocalizations, '|', dr.plan.updateStatus, '| 재생목록', dr.plan.playlistSource, `| 슬롯 ${ns.nextSlotSGT} SGT`);
  if (dry) process.exit(0);
  const ap = await post('/api/uploader/apply', { ...body, dryRun: false });
  fs.writeFileSync(join(OUT, `${videoId}.apply.json`), JSON.stringify({ ...ap, slotSGT: ns.nextSlotSGT }, null, 2));
  console.log('✅ 적용:', JSON.stringify(ap.updated), '재생목록', ap.playlists.map((x) => x.ok ? 'ok' : 'FAIL ' + x.error).join(','), '| 백업', ap.backup);
} else if (cmd === 'preset') {
  // 테마 JSON: { border, grad, stroke, amp, ampStroke?, titleStroke?, titleW?, gradInt?, filter? }
  const [name, themeJson] = args;
  const t = JSON.parse(themeJson);
  const big = { font: "'Playfair Display', serif", size: 275, color: '#ffffff', alpha: 1, align: 'center', bold: true, italic: false,
    underline: false, hollow: false, spacing: 0, strokeW: 16, strokeCol: t.stroke, glow: 0, shadowX: 4, shadowY: 4 };
  const data = {
    version: 1, filter: t.filter || 'yt_punchy',
    bgFx: { blur: 0, dim: 0, sat: 100, gradMode: 'bottom', gradInt: t.gradInt ?? 55, gradColor: t.grad, spotX: 50, spotY: 50 },
    frame: { borderMode: 'premium', borderColor: t.border, thickness: 23, sideText: 'Premium', sideFont: "'Playfair Display', serif",
      sideTxtColor: '#ffffff', sideX: 0, sideY: -410 },
    customTexts: [
      // 0번 = 위쪽 작은 유튜브 제목 (프로젝트 고르면 자동으로 글자 교체됨)
      { text: 'TITLE', font: "'Merriweather', serif", size: 43, color: '#ffffff', alpha: 1, x: 0.5, y: 0.058, align: 'center', bold: false,
        italic: false, underline: false, hollow: false, spacing: 0, strokeW: t.titleW ?? 4, strokeCol: t.titleStroke || '#2a140c', glow: 0, shadowX: 2, shadowY: 2 },
      { ...big, text: 'SWING', x: 0.305, y: 0.825 },
      { ...big, text: '&', size: 240, font: "'DM Serif Display', serif", color: t.amp, strokeW: 11, strokeCol: t.ampStroke || '#ffffff', x: 0.596, y: 0.84 },
      { ...big, text: 'JAZZ', x: 0.79, y: 0.825 },
    ],
    exportSettings: { format: 'image/jpeg', maxSizeKB: 1900, filename: 'thumb' },
  };
  await post('/api/thumbnail/presets', { name, data });
  console.log('프리셋 저장:', name);
} else if (cmd === 'upload-thumb') {
  const [videoId, jpg] = args;
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
  const tokPath = process.env.YOUTUBE_TOKEN_PATH?.startsWith('/') ? process.env.YOUTUBE_TOKEN_PATH : join(ROOT, process.env.YOUTUBE_TOKEN_PATH || 'secrets/youtube-token.json');
  auth.setCredentials(JSON.parse(fs.readFileSync(tokPath, 'utf8')));
  if (fs.statSync(jpg).size > 2 * 1024 * 1024) throw new Error('썸네일 2MB 초과');
  const yt = google.youtube({ version: 'v3', auth });
  const r = await yt.thumbnails.set({ videoId, media: { mimeType: 'image/jpeg', body: fs.createReadStream(jpg) } });
  console.log('✅ 썸네일 올림:', videoId, r.data.items?.[0]?.maxres?.url || r.data.items?.[0]?.high?.url);
} else if (cmd === 'status') {
  const { videos } = await get('/api/youtube/videos?max=50');
  for (const v of videos.filter((x) => x.privacyStatus !== 'public')) {
    const when = v.publishAt ? new Date(v.publishAt).toLocaleString('ko-KR', { timeZone: 'Asia/Singapore' }) + ' SGT' : '예약 없음';
    console.log(`${v.id} | ${when} | 언어 ${v.localizationCount} | ${v.title}`);
  }
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 14).join('\n'));
}
