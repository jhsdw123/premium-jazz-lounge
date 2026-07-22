/**
 * 보컬/코러스 자동 검출 — Demucs 스템 분리 기반.
 *
 * 원리:
 *  1. R2 에서 트랙 다운로드
 *  2. Demucs (htdemucs, --two-stems=vocals) 로 보컬 스템 물리 분리
 *  3. 보컬 스템에 ffmpeg silencedetect 를 걸어 "소리가 있는 구간" 을 역산
 *  4. 임계치(-35dB) 이상 & 최소 길이(0.6s) 이상 구간이 있으면 flagged
 *  5. pjl_tracks.has_vocals 업데이트 + data/vocal-check/results.json 에 상세 저장
 *
 * 사용법:
 *   node tools/check-vocals.mjs                  # 미검사 active 트랙 전부
 *   node tools/check-vocals.mjs --force          # 검사 이력 무시하고 전부 재검사
 *   node tools/check-vocals.mjs --track-id 12    # 특정 트랙만
 *   node tools/check-vocals.mjs --limit 5        # 최대 5곡
 *   node tools/check-vocals.mjs --noise -30      # 감도 조절 (기본 -35dB, 높일수록 둔감)
 *   node tools/check-vocals.mjs --keep           # 분리된 스템 wav 보존 (디버그용)
 *
 * 사전 조건: .venv-demucs (py -3.14 venv + pip install demucs soundfile), 시스템 ffmpeg/ffprobe.
 */

import { promises as fs } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import supabase from '../lib/supabase.mjs';
import { downloadTrack } from '../lib/storage.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENV_PYTHON = join(PROJECT_ROOT, '.venv-demucs', 'Scripts', 'python.exe');
const WORK_DIR = join(PROJECT_ROOT, 'data', 'vocal-check');
const TMP_DIR = join(WORK_DIR, 'tmp');
const STEMS_DIR = join(WORK_DIR, 'stems');
const FLAGGED_DIR = join(WORK_DIR, 'flagged');
const RESULTS_FILE = join(WORK_DIR, 'results.json');

// ── CLI 인자 ─────────────────────────────────────────────
function parseArgs(argv) {
  const args = { force: false, keep: false, report: false, noise: -35, minDur: 0.6, limit: null, trackIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--report') args.report = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--noise') args.noise = parseFloat(argv[++i]);
    else if (a === '--min-dur') args.minDur = parseFloat(argv[++i]);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--track-id') {
      args.trackIds.push(...String(argv[++i]).split(',').map((s) => parseInt(s.trim(), 10)));
    }
  }
  return args;
}

// ── 외부 프로세스 (track-meta.mjs 패턴) ───────────────────
function runCommand(cmd, cmdArgs, { timeoutMs = 120_000, onStderr = null } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${cmd} spawn 실패: ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// ── 오디오 분석 헬퍼 ─────────────────────────────────────
async function probeDurationSec(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath,
  ]);
  const d = parseFloat(JSON.parse(stdout)?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** 보컬 스템 전체의 max/mean 볼륨 (dB). */
async function detectVolume(filePath) {
  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
  ]);
  const max = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  return {
    maxDb: max ? parseFloat(max[1]) : null,
    meanDb: mean ? parseFloat(mean[1]) : null,
  };
}

/**
 * silencedetect 로 "무음 구간" 을 얻고, 전체 길이에서 뒤집어
 * "소리가 있는 구간(=보컬 활동)" 리스트를 만든다.
 */
async function detectActiveSegments(filePath, noiseDb, minDurSec) {
  const duration = await probeDurationSec(filePath);
  if (duration == null) throw new Error('보컬 스템 duration 파싱 실패');

  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner', '-nostats', '-i', filePath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=0.3`,
    '-f', 'null', '-',
  ], { timeoutMs: 300_000 });

  const silences = [];
  let pendingStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (m) { pendingStart = parseFloat(m[1]); continue; }
    m = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (m && pendingStart != null) {
      silences.push([Math.max(0, pendingStart), parseFloat(m[1])]);
      pendingStart = null;
    }
  }
  // 마지막 silence 가 EOF 까지 이어지면 end 없이 끝남
  if (pendingStart != null) silences.push([Math.max(0, pendingStart), duration]);

  // 무음 구간의 여집합 = 활동 구간
  const active = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s > cursor) active.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration) active.push([cursor, duration]);

  // 0.8s 미만 간격으로 붙어 있는 구간은 병합 (한 프레이즈로 취급)
  const merged = [];
  for (const seg of active) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] < 0.8) last[1] = seg[1];
    else merged.push([...seg]);
  }

  return {
    duration,
    segments: merged
      .filter(([s, e]) => e - s >= minDurSec)
      .map(([s, e]) => ({ start: Number(s.toFixed(1)), end: Number(e.toFixed(1)) })),
  };
}

// ── Demucs 실행 ──────────────────────────────────────────
async function separateVocals(inputFile, trackId) {
  const outDir = join(STEMS_DIR, String(trackId));
  await fs.rm(outDir, { recursive: true, force: true });
  await runCommand(VENV_PYTHON, [
    '-m', 'demucs',
    '--two-stems=vocals',
    '-n', 'htdemucs',
    '-d', 'cpu',
    '-o', outDir,
    inputFile,
  ], {
    timeoutMs: 900_000,
    onStderr: (s) => {
      const m = s.match(/(\d+)%\|/);
      if (m) process.stdout.write(`\r    분리 중... ${m[1]}%   `);
    },
  });
  process.stdout.write('\r');
  const stemBase = basename(inputFile, extname(inputFile));
  const vocalsPath = join(outDir, 'htdemucs', stemBase, 'vocals.wav');
  await fs.access(vocalsPath);
  return { vocalsPath, outDir };
}

// ── 상태 파일 ────────────────────────────────────────────
async function loadResults() {
  try {
    return JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
async function saveResults(results) {
  await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    await fs.access(VENV_PYTHON);
  } catch {
    console.error(`❌ ${VENV_PYTHON} 없음. 먼저: py -3.14 -m venv .venv-demucs && .venv-demucs\\Scripts\\python -m pip install demucs soundfile`);
    process.exit(1);
  }

  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(STEMS_DIR, { recursive: true });
  await fs.mkdir(FLAGGED_DIR, { recursive: true });

  let query = supabase
    .from('pjl_tracks')
    .select('id, original_filename, storage_path, duration_raw_sec')
    .eq('is_active', true)
    .order('id', { ascending: true });
  if (args.trackIds.length) query = query.in('id', args.trackIds);

  const { data: tracks, error } = await query;
  if (error) throw new Error(`pjl_tracks 조회 실패: ${error.message}`);
  if (!tracks?.length) {
    console.log('active 트랙이 없음.');
    return;
  }

  const results = await loadResults();

  // --report: 스캔 없이 현재까지 결과만 출력
  if (args.report) {
    const done = tracks.filter((t) => results[t.id]).length;
    console.log(`진행: ${done}/${tracks.length}곡 검사 완료\n`);
    printSummary(tracks, results);
    return;
  }

  let targets = args.force
    ? tracks
    : tracks.filter((t) => !results[t.id]);
  if (args.limit) targets = targets.slice(0, args.limit);

  console.log(`총 ${tracks.length}곡 중 ${targets.length}곡 검사 (noise=${args.noise}dB, minDur=${args.minDur}s)\n`);
  if (!targets.length) {
    console.log('전부 검사 완료 상태. 재검사하려면 --force.');
    printSummary(tracks, results);
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const label = `[${i + 1}/${targets.length}] #${t.id} ${t.original_filename || t.storage_path}`;
    console.log(label);

    const ext = extname(t.storage_path) || '.mp3';
    const tmpFile = join(TMP_DIR, `track-${t.id}${ext}`);
    let outDir = null;

    try {
      console.log('    R2 다운로드...');
      const buf = await downloadTrack(t.storage_path);
      await fs.writeFile(tmpFile, buf);

      const sep = await separateVocals(tmpFile, t.id);
      outDir = sep.outDir;

      const [vol, act] = [
        await detectVolume(sep.vocalsPath),
        await detectActiveSegments(sep.vocalsPath, args.noise, args.minDur),
      ];

      const hasVocals = act.segments.length > 0;

      // 플래그된 곡은 보컬 스템만 mp3 로 남김 — 이 파일만 들으면 진짜/가짜 즉시 판별 가능
      let vocalsMp3 = null;
      if (hasVocals) {
        vocalsMp3 = join(FLAGGED_DIR, `${t.id}_vocals.mp3`);
        await runCommand('ffmpeg', [
          '-y', '-hide_banner', '-nostats', '-i', sep.vocalsPath,
          '-codec:a', 'libmp3lame', '-b:a', '128k', vocalsMp3,
        ]).catch(() => { vocalsMp3 = null; });
      }

      const entry = {
        checked_at: new Date().toISOString(),
        verdict: hasVocals ? 'flagged' : 'clean',
        stem_max_db: vol.maxDb,
        stem_mean_db: vol.meanDb,
        segments: act.segments,
        params: { noise_db: args.noise, min_dur_sec: args.minDur, model: 'htdemucs' },
        filename: t.original_filename,
        vocals_mp3: vocalsMp3,
      };
      results[t.id] = entry;
      await saveResults(results);

      const { error: upErr } = await supabase
        .from('pjl_tracks')
        .update({ has_vocals: hasVocals, updated_at: new Date().toISOString() })
        .eq('id', t.id);
      if (upErr) console.warn(`    ⚠ DB 업데이트 실패: ${upErr.message}`);

      if (hasVocals) {
        const spots = act.segments.map((s) => `${fmtTime(s.start)}~${fmtTime(s.end)}`).join(', ');
        console.log(`    🚨 FLAGGED — 보컬 의심 구간: ${spots} (스템 피크 ${vol.maxDb}dB)`);
      } else {
        console.log(`    ✅ clean (스템 피크 ${vol.maxDb ?? '?'}dB)`);
      }
    } catch (e) {
      results[t.id] = { checked_at: new Date().toISOString(), verdict: 'error', error: e.message };
      await saveResults(results);
      console.error(`    ❌ 실패: ${e.message}`);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
      if (outDir && !args.keep) await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
    console.log('');
  }

  printSummary(tracks, results);
}

function printSummary(tracks, results) {
  const flagged = [];
  const clean = [];
  const errored = [];
  for (const t of tracks) {
    const r = results[t.id];
    if (!r) continue;
    if (r.verdict === 'flagged') flagged.push({ t, r });
    else if (r.verdict === 'clean') clean.push({ t, r });
    else errored.push({ t, r });
  }

  console.log('════════════════════════════════════════');
  console.log(`요약: clean ${clean.length} / flagged ${flagged.length} / error ${errored.length}`);
  if (flagged.length) {
    console.log('\n🚨 보컬 의심 트랙 — 아래 타임스탬프만 직접 들어서 확정할 것:');
    for (const { t, r } of flagged) {
      const spots = r.segments.map((s) => `${fmtTime(s.start)}~${fmtTime(s.end)}`).join(', ');
      console.log(`  #${t.id} ${t.original_filename || t.storage_path}`);
      console.log(`      ${spots}`);
    }
  }
  if (errored.length) {
    console.log('\n❌ 검사 실패 (재시도: --track-id 로 지정):');
    for (const { t, r } of errored) console.log(`  #${t.id} ${t.original_filename}: ${r.error}`);
  }
  console.log(`\n상세 결과: data/vocal-check/results.json`);
}

main().catch((e) => {
  console.error('치명적 오류:', e.message);
  process.exit(1);
});
