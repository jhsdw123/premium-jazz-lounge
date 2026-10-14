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
  while (off < buf.length) off += fs.writeSync(f.fd, buf, off, buf.length - off, pos + off);
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

// ─── 3시간으로 늘리기 ─────────────────────────────────────────────────
export function startExtend(id) {
  const it = find(id);
  if (it.ext?.status === 'running') return it;
  if (!it.file || !fs.existsSync(it.file)) throw new Error('늘릴 영상 파일이 없습니다');
  if (!fs.existsSync(LOOP_TOOL)) throw new Error(`늘리기 도구가 없습니다: ${LOOP_TOOL}`);
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
