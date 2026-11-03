// 예약 렌더 대기열 — Builder 에서 [곡 + 템플릿] 을 여러 편 걸어 두고, 한 번 누르면 순서대로 녹화한다.
//
// 녹화 자체는 브라우저(Studio, WebCodecs)가 한다. 이 모듈이 맡는 것은 세 가지:
//   1) 대기열 상태 (data/cache/render-queue.json) — 새로고침·패널 재시작에도 남는다
//   2) 녹화 조각을 받아 디스크에 쓰기 — 저장 창(showSaveFilePicker)은 클릭이 있어야 떠서 자는 동안 못 쓴다
//   3) 끝난 30분 본을 3시간으로 늘리기 — PNL-3D-Studio 의 loop-video.py (바퀴 사이 디졸브 + PJL 인트로)
//
// 상태: queued → rendering → done | failed | stopped.  연장은 따로 ext.status: '' → running → done | failed

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dataCache as dataDir } from './paths.mjs';
import { LOOP_DIR } from './loop-videos.mjs';

// 기본 위치는 홈 폴더 기준 — 윈도우(C:\Users\User\Desktop\…)와 맥(~/Desktop/…)에서 똑같이 맞는다.
export const RENDER_OUT_DIR = process.env.PJL_RENDER_DIR || path.join(LOOP_DIR, '30분완성본');
const LOOP_TOOL = process.env.PJL_LOOP_TOOL || path.join(os.homedir(), 'Desktop', 'PNL-3D-Studio', 'tools', 'loop-video.py');
// 맥: PNL-3D-Studio 설치 때 만든 .venv-mac(numpy·pillow)을 먼저, 없으면 python3 (맥엔 `python` 이 없다).
const MAC_VENV_PY = path.join(path.dirname(path.dirname(LOOP_TOOL)), '.venv-mac', 'bin', 'python');
const PYTHON = process.env.PJL_PYTHON
  || (process.platform === 'win32' ? 'python' : (fs.existsSync(MAC_VENV_PY) ? MAC_VENV_PY : 'python3'));
const EXTEND_HOURS = parseFloat(process.env.PJL_EXTEND_HOURS) || 3;
const EXTEND_INTRO = process.env.PJL_EXTEND_INTRO || 'pjl-title';
const STATE_FILE = path.join(dataDir, 'render-queue.json');

let state = null;
const open = new Map();   // jobId → { fd, part, final, bytes }

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = { items: [] }; }
  if (!Array.isArray(state.items)) state.items = [];
  // 패널이 꺼졌다 켜졌으면 돌던 연장은 죽은 것이다.
  for (const it of state.items) if (it.ext?.status === 'running') { it.ext.status = 'failed'; it.ext.error = '패널이 꺼져 연장이 중단됨'; }
  return state;
}

function save() {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function find(id) {
  const it = load().items.find((x) => x.id === id);
  if (!it) throw new Error(`예약 없음: ${id}`);
  return it;
}

// ─── 저장공간 확인 ─────────────────────────────────────────────────────
// 3시간 본 하나가 ~17GB 다. 공간이 모자라면 ffmpeg 가 끝까지 돌다가 'No space left on device' 로 죽는다
// (2026-11-03: 두 번째 편 연장이 그렇게 실패) → 시작 전에 미리 재서 막는다.
const GB = 1024 ** 3;
const SPACE_MARGIN = 1 * GB;          // 계산이 빗나갈 몫 + 시스템이 쓸 몫
const DEFAULT_RATE = 1.6e6;           // 녹화 1초당 바이트 (60fps 실측 ≈ 1.5MB/s). 끝난 편이 있으면 그 값을 쓴다
export const fmtGB = (b) => `${(b / GB).toFixed(1)}GB`;

function freeBytes() {
  let dir = RENDER_OUT_DIR;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

// 끝난 편들의 (크기 ÷ 길이) 중앙값 — 템플릿·fps 가 비슷하면 거의 같다
function recordRate() {
  const r = load().items.filter((x) => x.bytes > 0 && x.durationSec > 60 && !x.manual).map((x) => x.bytes / x.durationSec).sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : DEFAULT_RATE;
}

// 늘리기 도구는 본 영상 그림을 통째로 한 번 복사해 둔 뒤(임시) 결과를 쓴다 → 결과 + 원본만큼 자리가 필요
//   loop-video.py 처럼 통째 바퀴 수로 센다: n = round((목표 - D) / D), 결과 = (n + 1) × 원본
const extendRatio = (durSec) => {
  const d = Math.max(60, durSec || 0);
  return 1 + Math.max(1, Math.round((EXTEND_HOURS * 3600 - d) / d));
};
const extendNeed = (srcBytes, durSec) => ({ out: srcBytes * extendRatio(durSec), temp: srcBytes });

// 대기열을 순서대로 돌렸을 때 어디서 자리가 모자라는지 흉내 낸다. 만든 파일은 계속 남는다고 본다.
export function spaceCheck(jobs) {
  const free = freeBytes();
  const rate = recordRate();
  let used = 0, fail = null;
  const per = (Array.isArray(jobs) ? jobs : []).map((j, i) => {
    const rec = (Number(j.durationSec) || 0) * rate;
    const ext = j.extend ? extendNeed(rec, j.durationSec) : { out: 0, temp: 0 };
    if (!fail && used + rec + SPACE_MARGIN > free) fail = { index: i, stage: '녹화' };
    used += rec;
    if (!fail && j.extend && used + ext.out + ext.temp + SPACE_MARGIN > free) fail = { index: i, stage: '연장' };
    used += ext.out;
    return { rec, ext: ext.out };
  });
  const peakTemp = Math.max(0, ...per.map((p, i) => (jobs[i].extend ? p.rec : 0)));
  const need = used + peakTemp + SPACE_MARGIN;
  return { free, need, enough: !fail, fail, per };   // `ok` 는 rqRoute 가 쓰는 이름이라 피한다
}

function spaceError(free, need, what) {
  return `저장공간 부족 — 남은 ${fmtGB(free)}, ${what}에 약 ${fmtGB(need)} 필요. 다 쓴 영상(업로드 끝난 3시간 본 등)을 지우고 다시 하세요`;
}

export function listQueue() {
  return { items: load().items, outDir: RENDER_OUT_DIR, extendHours: EXTEND_HOURS, extendReady: fs.existsSync(LOOP_TOOL) };
}

export function addJob(b) {
  const trackIds = (Array.isArray(b?.trackIds) ? b.trackIds : []).map((n) => parseInt(n, 10)).filter(Number.isFinite);
  const templateId = parseInt(b?.templateId, 10);
  if (!trackIds.length) throw new Error('곡이 없습니다');
  if (!Number.isFinite(templateId)) throw new Error('템플릿을 선택하세요');
  const it = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    trackIds, templateId,
    templateName: String(b.templateName || ''),
    firstTitle: String(b.firstTitle || ''),
    durationSec: Number(b.durationSec) || 0,
    extend: false,
    status: 'queued',
    ext: { status: '' },
  };
  load().items.push(it);
  save();
  return it;
}

const PATCHABLE = ['extend', 'status', 'error', 'note', 'videoId', 'startedAt', 'finishedAt', 'fps'];
export function patchJob(id, b) {
  const it = find(id);
  for (const k of PATCHABLE) if (b && k in b) it[k] = b[k];
  save();
  return it;
}

export function removeJob(id) {
  const it = find(id);
  if (it.status === 'rendering' || it.ext?.status === 'running') throw new Error('지금 돌고 있는 예약은 지울 수 없습니다');
  state.items = state.items.filter((x) => x.id !== id);
  save();
}

export function clearFinished() {
  load();
  state.items = state.items.filter((x) => x.status === 'queued' || x.status === 'rendering' || x.ext?.status === 'running');
  save();
}

// ─── 녹화 파일 받기 ───────────────────────────────────────────────────
function pickName(it) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())} ${Math.max(1, Math.round((it.durationSec || 0) / 60))}분`;
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${base}.mp4` : `${base} (${i}).mp4`;
    if (!fs.existsSync(path.join(RENDER_OUT_DIR, name))) return name;
  }
  return `${base} ${it.id}.mp4`;
}

export function openFile(id) {
  const it = find(id);
  closeFile(id, { discard: true });
  // 녹화할 자리도 없으면 30분 돌리고 나서 실패하지 말고 지금 멈춘다
  const free = freeBytes(), rec = (it.durationSec || 0) * recordRate() + SPACE_MARGIN;
  if (free < rec) throw new Error(spaceError(free, rec, '녹화'));
  fs.mkdirSync(RENDER_OUT_DIR, { recursive: true });
  const final = path.join(RENDER_OUT_DIR, pickName(it));
  const part = final + '.part';
  open.set(id, { fd: fs.openSync(part, 'w'), part, final, bytes: 0 });
  it.file = null; it.bytes = 0;
  save();
  return { name: path.basename(final) };
}

export function writeAt(id, pos, buf) {
  const f = open.get(id);
  if (!f) throw new Error('열린 파일이 없습니다 (패널이 재시작됐나요?)');
  if (!Number.isSafeInteger(pos) || pos < 0) throw new Error(`잘못된 위치: ${pos}`);
  let off = 0;
  try {
    while (off < buf.length) off += fs.writeSync(f.fd, buf, off, buf.length - off, pos + off);
  } catch (e) {
    if (e.code === 'ENOSPC') throw new Error('저장공간이 가득 차서 녹화 파일을 더 쓸 수 없습니다');
    throw e;
  }
  f.bytes = Math.max(f.bytes, pos + buf.length);
}

export function closeFile(id, { discard = false } = {}) {
  const f = open.get(id);
  if (!f) return null;
  open.delete(id);
  try { fs.closeSync(f.fd); } catch {}
  if (discard || f.bytes === 0) {
    try { fs.unlinkSync(f.part); } catch {}
    return null;
  }
  fs.renameSync(f.part, f.final);
  const it = find(id);
  it.file = f.final; it.bytes = f.bytes;
  save();
  return { file: f.final, bytes: f.bytes };
}

// ─── 수동 녹화(저장 창)로 저장한 영상 늘리기 ───────────────────────────
// 저장 창은 브라우저가 경로를 알려 주지 않는다 → 파일 이름 + 크기로 흔한 저장 위치를 뒤져 찾는다.
// 찾으면 대기열에 '이미 녹화 끝난 편'(manual)으로 올리고 바로 연장 — 진행·결과가 예약 렌더 목록에도 보인다.
const SEARCH_DEPTH = 3;
function findSavedFile(name, bytes) {
  const home = os.homedir();
  const roots = [...new Set([
    path.join(home, 'Downloads'), RENDER_OUT_DIR, LOOP_DIR,
    path.join(home, 'Desktop'), path.join(home, 'Movies'), path.join(home, 'Videos'), path.join(home, 'Documents'),
  ])];
  const hits = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === name) {
        try { const st = fs.statSync(p); if (!bytes || st.size === bytes) hits.push({ p, mtime: st.mtimeMs }); } catch {}
      } else if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(p, depth - 1);
      }
    }
  };
  for (const r of roots) walk(r, SEARCH_DEPTH);
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.p || null;
}

export function addManualExtend(b) {
  const name = path.basename(String(b?.name || ''));
  const bytes = Number(b?.bytes) || 0;
  if (!name) throw new Error('파일 이름이 없습니다');
  const file = findSavedFile(name, bytes);
  if (!file) throw new Error(`저장한 영상을 못 찾았습니다: ${name} — 다운로드·바탕화면·동영상 폴더 안에 저장하면 찾을 수 있습니다`);
  const it = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    manual: true,
    trackIds: (Array.isArray(b?.trackIds) ? b.trackIds : []).map((n) => parseInt(n, 10)).filter(Number.isFinite),
    templateName: String(b?.templateName || '수동 녹화'),
    firstTitle: String(b?.firstTitle || ''),
    durationSec: Number(b?.durationSec) || 0,
    extend: true,
    status: 'done',
    finishedAt: new Date().toISOString(),
    file, bytes,
    ext: { status: '' },
  };
  load().items.push(it);
  save();
  return startExtend(it.id);
}

export function getJob(id) { return find(id); }

// ─── 3시간으로 늘리기 ─────────────────────────────────────────────────
export function startExtend(id) {
  const it = find(id);
  if (it.ext?.status === 'running') return it;
  if (!it.file || !fs.existsSync(it.file)) throw new Error('늘릴 영상 파일이 없습니다');
  if (!fs.existsSync(LOOP_TOOL)) throw new Error(`늘리기 도구가 없습니다: ${LOOP_TOOL}`);
  // 자리가 모자라면 돌리지 않고 실패로 남긴다 — 목록에 이유가 보이고, 지운 뒤 [다시 늘리기]로 재시도
  const src = fs.statSync(it.file).size;
  const ex = extendNeed(src, it.durationSec || src / recordRate());
  const free = freeBytes(), need = ex.out + ex.temp + SPACE_MARGIN;
  if (free < need) {
    const now = new Date().toISOString();
    it.ext = { status: 'failed', startedAt: now, finishedAt: now, error: spaceError(free, need, `${EXTEND_HOURS}시간 연장`) };
    save();
    console.log(`[render-queue] 연장 건너뜀 — ${it.ext.error}`);
    return it;
  }
  it.ext = { status: 'running', startedAt: new Date().toISOString(), line: '준비 중…' };
  save();

  const args = [LOOP_TOOL, it.file, '--hours', String(EXTEND_HOURS)];
  if (EXTEND_INTRO && EXTEND_INTRO !== 'none') args.push('--intro', EXTEND_INTRO);
  const ch = spawn(PYTHON, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  let out = '', err = '';
  ch.stdout.on('data', (d) => {
    out += d.toString('utf8');
    const lines = out.trim().split(/\r?\n/);
    it.ext.line = lines[lines.length - 1] || it.ext.line;
  });
  ch.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-4000); });
  const finish = (code, e) => {
    if (it.ext.status !== 'running') return;
    const done = out.match(/^완료\s*:\s*(.+)$/m);
    const warn = out.split(/\r?\n/).filter((l) => l.includes('⚠'));
    it.ext.finishedAt = new Date().toISOString();
    if (code === 0 && done && fs.existsSync(done[1].trim())) {
      it.ext.status = 'done';
      it.ext.file = done[1].trim();
      it.ext.line = (out.trim().split(/\r?\n/).pop() || '').trim();
      if (warn.length) it.ext.warn = warn.join(' / ').slice(0, 600);
    } else {
      it.ext.status = 'failed';
      it.ext.error = (e?.message || err.trim() || out.trim().split(/\r?\n/).slice(-3).join(' / ') || `종료 코드 ${code}`).slice(-600);
    }
    save();
    console.log(`[render-queue] 연장 ${it.ext.status} — ${it.ext.file || it.ext.error}`);
  };
  ch.on('error', (e) => finish(-1, e));
  ch.on('close', (code) => finish(code));
  return it;
}
