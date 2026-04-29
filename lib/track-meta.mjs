import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * 외부 프로세스 실행 헬퍼. 표준출력/에러 모두 수집해서 반환.
 */
function runCommand(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${cmd} spawn 실패: ${err.message}. PATH 에 ffmpeg/ffprobe 가 있는지 확인.`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * ffprobe 로 raw 길이(초) 추출.
 */
async function probeDurationSec(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ]);
  const j = JSON.parse(stdout);
  const d = parseFloat(j?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * silencedetect 로 양끝 silence 잘라낸 actual 길이(초) 추정.
 *
 * 알고리즘:
 *  - silencedetect 출력에서 silence_start / silence_end 페어 파싱.
 *  - 첫 silence_start 가 ≤ 0.5s → leading silence, 그 silence_end 만큼 컷.
 *  - 마지막 silence 가 EOF 까지 이어지면 (start 만 있고 end 없음 또는 end ≈ raw)
 *    raw - last_start = trailing silence.
 *  - actual = raw - leading - trailing.
 *
 *  silence 미검출 시 actual = raw.
 */
async function detectActualDurationSec(filePath, rawDurationSec) {
  if (rawDurationSec == null) return null;

  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', filePath,
    '-af', 'silencedetect=noise=-40dB:d=0.5',
    '-f', 'null', '-',
  ]);

  const starts = [];
  const ends = [];
  for (const line of stderr.split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (m) { starts.push(parseFloat(m[1])); continue; }
    m = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (m) ends.push(parseFloat(m[1]));
  }

  let leading = 0;
  let trailing = 0;

  // Leading: 첫 silence_start 가 거의 0 → 그 silence_end 가 leading silence 의 끝
  if (starts.length > 0 && starts[0] <= 0.5 && ends.length > 0) {
    leading = Math.max(0, ends[0]);
  }

  // Trailing: starts 가 ends 보다 많으면 마지막 silence 가 EOF 까지 이어진 것
  if (starts.length > ends.length) {
    const lastStart = starts[starts.length - 1];
    if (lastStart < rawDurationSec) {
      trailing = Math.max(0, rawDurationSec - lastStart);
    }
  } else if (ends.length > 0) {
    // 또는 마지막 silence_end 가 raw 끝과 거의 같으면 (≤0.3s 차이) trailing 으로 간주
    const lastEnd = ends[ends.length - 1];
    const lastStart = starts[starts.length - 1] ?? lastEnd;
    if (rawDurationSec - lastEnd <= 0.3 && lastStart < rawDurationSec) {
      trailing = Math.max(0, rawDurationSec - lastStart);
    }
  }

  const actual = rawDurationSec - leading - trailing;
  return Math.max(0, actual);
}

/**
 * 곡 분석 — Buffer 또는 디스크 파일 경로.
 *  - 항상 객체 반환. 실패한 필드는 null.
 *  - 부분 실패에 강건: ffprobe 가 깨져도 silencedetect 시도하지 않고 모두 null,
 *    silencedetect 만 실패하면 raw 만 살림.
 *
 * BPM: Phase 3 에서는 null. (aubio/onset-detection 도입 시 이 함수만 갱신.)
 */
export async function analyzeTrack(input) {
  let tmpFile = null;
  let pathToUse;
  try {
    if (Buffer.isBuffer(input)) {
      tmpFile = join(tmpdir(), `pjl-analyze-${randomUUID()}.audio`);
      await fs.writeFile(tmpFile, input);
      pathToUse = tmpFile;
    } else if (typeof input === 'string') {
      pathToUse = input;
    } else {
      return { bpm: null, durationRawSec: null, durationActualSec: null };
    }

    let durationRawSec = null;
    let durationActualSec = null;

    try {
      durationRawSec = await probeDurationSec(pathToUse);
    } catch (e) {
      // ffprobe 실패 시 더 진행 안 함 — 파일이 깨졌거나 ffprobe 없음
      return { bpm: null, durationRawSec: null, durationActualSec: null, _probeError: e.message };
    }

    if (durationRawSec != null) {
      try {
        durationActualSec = await detectActualDurationSec(pathToUse, durationRawSec);
      } catch (e) {
        durationActualSec = null;  // silence 분석 실패해도 raw 는 살림
      }
    }

    return {
      bpm: null,
      durationRawSec: durationRawSec != null ? Number(durationRawSec.toFixed(2)) : null,
      durationActualSec: durationActualSec != null ? Number(durationActualSec.toFixed(2)) : null,
    };
  } finally {
    if (tmpFile) {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}
