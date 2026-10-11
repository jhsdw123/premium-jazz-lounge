// 배경 루프 영상 (ClipLoop Studio 가 만든 루프 + Topaz 업스케일본).
//
// 폴더 하나(LOOP_DIR)에 파일이 평평하게 놓인다. 짝은 파일 이름으로 묶는다:
//   PJL-Loop-007.mp4                 ← 원본 (ClipLoop Studio 내보내기)
//   PJL-Loop-007_1_chf3_ghq5.mp4     ← 업스케일본 (Topaz 가 같은 폴더에 꼬리표를 붙여 저장)
// "다른 파일 이름 + '_' 로 시작하는 파일" 은 그 파일의 파생본으로 본다.
//
// R2 에 올리지 않는다 (300MB 를 올리면 15분). 패널이 로컬이라 디스크에서 바로 읽고,
// 고르는 순간 1080p 재생용 사본(.cache)을 한 번 만들어 Template Editor / Studio 가 그걸 튼다.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const LOOP_DIR = process.env.PJL_LOOP_DIR || 'C:\\Users\\User\\Desktop\\PJLLoopvideo';
const CACHE_DIR = path.join(LOOP_DIR, '.cache');
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const PROXY_W = 1920;
const PROXY_H = 1080;
// 재생용 사본 형식이 바뀌면 올린다 — 옛 캐시를 다시 만들게 된다.
const PROXY_VERSION = 1;
const PROXY_CODEC = 'avc1.640033';
const CACHE_KEEP_DAYS = 14;
// 아직 쓰는 중인 파일(Topaz 가 내보내는 중)은 건드리지 않는다.
const SETTLE_MS = 5000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => reject(new Error(`${cmd} 실행 실패: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} 실패: ${stderr.trim().slice(-400)}`))));
  });
}

const probeCache = new Map(); // "path|size|mtime" → probe 결과(Promise)

function statKey(full, st) {
  return `${full}|${st.size}|${Math.round(st.mtimeMs)}`;
}

function probe(full, st) {
  const k = statKey(full, st);
  if (!probeCache.has(k)) {
    const job = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', full])
      .then((out) => {
        const j = JSON.parse(out);
        const s = j.streams?.[0];
        if (!s) throw new Error('영상 스트림 없음');
        const [num, den] = String(s.r_frame_rate).split('/').map(Number);
        return { width: s.width, height: s.height, fpsNum: num, fpsDen: den || 1, fps: num / (den || 1), duration: Number(j.format?.duration) || 0 };
      });
    job.catch(() => probeCache.delete(k));
    probeCache.set(k, job);
  }
  return probeCache.get(k);
}

async function scanFiles() {
  let names;
  try {
    names = await fsp.readdir(LOOP_DIR);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(LOOP_DIR, name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    const base = path.basename(name, path.extname(name));
    const file = { name, base, full, st, sizeMB: +(st.size / 1048576).toFixed(1), mtime: st.mtimeMs, busy: Date.now() - st.mtimeMs < SETTLE_MS };
    if (!file.busy) {
      try {
        Object.assign(file, await probe(full, st));
      } catch {
        file.busy = true; // 헤더가 아직 없는 mp4 = 쓰는 중
      }
    }
    files.push(file);
  }
  return files;
}

// 이름으로 짝을 묶는다. 파생본의 파생본도 맨 위 원본 묶음으로 들어간다.
function groupFiles(files) {
  const parentOf = (f) => {
    let best = null;
    for (const p of files) {
      if (p !== f && f.base.startsWith(p.base + '_') && (!best || p.base.length > best.base.length)) best = p;
    }
    return best;
  };
  const rootOf = (f) => {
    let cur = f;
    for (let p = parentOf(cur); p; p = parentOf(cur)) cur = p;
    return cur;
  };
  const groups = new Map();
  for (const f of files) {
    const root = rootOf(f);
    if (!groups.has(root.base)) groups.set(root.base, { key: root.base, original: root, variants: [] });
    if (f !== root) groups.get(root.base).variants.push(f);
  }
  return [...groups.values()];
}

const pixelRate = (f) => (f.width || 0) * (f.height || 0) * (f.fps || 0);

// 묶음에서 실제로 틀 파일 = 가장 좋은 파생본(업스케일본). 없으면 원본.
function pickBest(group) {
  const ready = group.variants.filter((v) => !v.busy);
  if (!ready.length) return group.original.busy ? null : group.original;
  return ready.sort((a, b) => pixelRate(b) - pixelRate(a) || b.mtime - a.mtime)[0];
}

const publicFile = (f) => f && { name: f.name, width: f.width || null, height: f.height || null, fps: f.fps ? +f.fps.toFixed(2) : null, duration: f.duration || null, sizeMB: f.sizeMB, busy: f.busy };

export async function listLoops() {
  const groups = groupFiles(await scanFiles());
  return groups
    .map((g) => {
      const best = pickBest(g);
      return {
        key: g.key,
        original: publicFile(g.original),
        upscaled: best && best !== g.original ? publicFile(best) : null,
        use: publicFile(best),
        writing: g.variants.some((v) => v.busy) || g.original.busy,
        fileCount: 1 + g.variants.length,
        totalMB: +[g.original, ...g.variants].reduce((a, f) => a + f.sizeMB, 0).toFixed(1),
        mtime: Math.max(g.original.mtime, ...g.variants.map((v) => v.mtime)),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function findGroup(key) {
  const group = groupFiles(await scanFiles()).find((g) => g.key === key);
  if (!group) throw new Error(`루프 영상 없음: ${key} (${LOOP_DIR})`);
  return group;
}

const cacheId = (f, tag) => crypto.createHash('sha1').update(`${statKey(f.full, f.st)}|${tag}`).digest('hex').slice(0, 16);

export async function loopThumbPath(key) {
  const group = await findGroup(key);
  const src = group.original.busy ? pickBest(group) : group.original;
  if (!src) throw new Error('아직 쓰는 중인 파일입니다');
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const out = path.join(CACHE_DIR, `thumb_${cacheId(src, 'thumb')}.jpg`);
  if (!fs.existsSync(out)) {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src.full, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
  }
  return out;
}

const building = new Map(); // proxy id → 만드는 중인 Promise (같은 영상을 두 번 굽지 않게)

async function buildProxy(src, id) {
  const h264 = path.join(CACHE_DIR, `${id}.h264`);
  const meta = path.join(CACHE_DIR, `${id}.json`);
  const tmp = `${h264}.tmp`;
  // 프레임마다 키프레임(-g 1)인 Annex-B 스트림. 브라우저가 아무 프레임에서나 풀기 시작할 수 있고,
  // 끝 → 처음으로 넘어갈 때도 그냥 다음 프레임이라 이음새가 없다. 화면 채우기(cover)로 1920×1080.
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', src.full, '-an',
    '-vf', `scale=${PROXY_W}:${PROXY_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${PROXY_W}:${PROXY_H},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '1', '-bf', '0',
    '-profile:v', 'high', '-level', '5.1',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-x264-params', 'aud=1:repeat-headers=1',
    '-f', 'h264', tmp,
  ]);
  const out = await run('ffprobe', ['-v', 'error', '-f', 'h264', '-show_entries', 'packet=size', '-of', 'csv=p=0', tmp]);
  const sizes = out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter((n) => n > 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  const bytes = (await fsp.stat(tmp)).size;
  if (!sizes.length || total !== bytes) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`재생용 사본 색인이 파일 크기와 다릅니다 (${total} / ${bytes})`);
  }
  await fsp.rename(tmp, h264);
  await fsp.writeFile(meta, JSON.stringify({
    v: PROXY_VERSION, id, source: src.name, codec: PROXY_CODEC,
    width: PROXY_W, height: PROXY_H, fpsNum: src.fpsNum, fpsDen: src.fpsDen, frames: sizes.length, sizes,
  }));
}

async function pruneCache() {
  const limit = Date.now() - CACHE_KEEP_DAYS * 86400000;
  for (const name of await fsp.readdir(CACHE_DIR).catch(() => [])) {
    const full = path.join(CACHE_DIR, name);
    const st = await fsp.stat(full).catch(() => null);
    if (st?.isFile() && st.mtimeMs < limit) await fsp.rm(full, { force: true });
  }
}

// 고른 묶음의 재생용 사본을 보장하고 메타를 돌려준다 (없으면 굽는다 — 20초 루프 기준 수십 초).
export async function prepareLoop(key) {
  const group = await findGroup(key);
  const src = pickBest(group);
  if (!src) throw new Error('아직 쓰는 중인 파일입니다 — 저장이 끝난 뒤 다시 고르세요');
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const id = cacheId(src, `proxy-v${PROXY_VERSION}`);
  const h264 = path.join(CACHE_DIR, `${id}.h264`);
  const metaPath = path.join(CACHE_DIR, `${id}.json`);
  if (!fs.existsSync(h264) || !fs.existsSync(metaPath)) {
    if (!building.has(id)) building.set(id, buildProxy(src, id).finally(() => building.delete(id)));
    await building.get(id);
    pruneCache().catch(() => {});
  }
  // 쓰는 사본은 오래된 캐시 정리에 안 걸리게 시각을 갱신한다.
  const now = new Date();
  await Promise.all([fsp.utimes(h264, now, now), fsp.utimes(metaPath, now, now)]).catch(() => {});
  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  return { key, ...meta, upscaled: src !== group.original, url: `/api/loops/proxy/${id}.h264` };
}

// 휴지통으로 보낸다 (바로 지우지 않는다 — 잘못 눌렀을 때 되살릴 수 있게).
function recycle(paths) {
  const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in @(${list})) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`]);
}

// 묶음(원본 + 파생본 전부)을 폴더에서 치운다. 쓰는 중인 파일이 낀 묶음은 건너뛴다.
export async function deleteLoops(keys) {
  const groups = groupFiles(await scanFiles());
  const deleted = [];
  const skipped = [];
  for (const key of keys) {
    const g = groups.find((x) => x.key === key);
    if (!g) continue;
    const files = [g.original, ...g.variants];
    if (files.some((f) => f.busy)) { skipped.push({ key, reason: '저장하는 중인 파일이 있음' }); continue; }
    // 썸네일·재생용 사본은 다시 만들 수 있는 것이라 그냥 지운다.
    const best = pickBest(g);
    const proxyId = best && cacheId(best, `proxy-v${PROXY_VERSION}`);
    const cache = [`thumb_${cacheId(g.original, 'thumb')}.jpg`, ...(proxyId ? [`${proxyId}.h264`, `${proxyId}.json`] : [])];
    try {
      await recycle(files.map((f) => f.full));
    } catch (e) {
      skipped.push({ key, reason: e.message });
      continue;
    }
    const left = files.filter((f) => fs.existsSync(f.full));
    if (left.length) { skipped.push({ key, reason: `안 지워진 파일: ${left.map((f) => f.name).join(', ')}` }); continue; }
    for (const name of cache) await fsp.rm(path.join(CACHE_DIR, name), { force: true }).catch(() => {});
    deleted.push({ key, files: files.map((f) => f.name), sizeMB: +files.reduce((a, f) => a + f.sizeMB, 0).toFixed(1) });
  }
  return { deleted, skipped };
}

export function proxyFilePath(file) {
  if (!/^[0-9a-f]{16}\.h264$/.test(file)) return null;
  return path.join(CACHE_DIR, file);
}
