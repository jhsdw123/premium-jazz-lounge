/**
 * Phase 4-C-1-A: 템플릿 배경 이미지 처리.
 *  - mp4 (Loop 영상) → 첫 프레임 PNG 추출
 *  - 이미지 → 그대로
 * 모두 결과를 Buffer + suggestedMime 으로 반환. 호출 측이 Storage 에 업로드.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

function runCommand(cmd, args, { timeoutMs = 60_000 } = {}) {
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
      reject(new Error(`${cmd} spawn 실패: ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v']);

/**
 * @param {Buffer} buffer
 * @param {string} originalFilename
 * @param {string} mimetype
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string }>}
 */
export async function processBackground(buffer, originalFilename, mimetype) {
  const lcName = (originalFilename || '').toLowerCase();
  const ext = lcName.match(/\.([a-z0-9]+)$/)?.[1] || '';
  const mt = (mimetype || '').toLowerCase();

  const isVideo = mt.startsWith('video/') || VIDEO_EXTS.has(ext);
  const isImage = mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext);

  if (!isVideo && !isImage) {
    throw new Error(`지원하지 않는 파일 형식: mime=${mt} ext=${ext}`);
  }

  if (isImage) {
    // 그대로 통과. mime 정규화.
    const mimeOut = mt.startsWith('image/')
      ? mt
      : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'webp' ? 'image/webp'
        : 'image/png');
    const extOut = mimeOut.split('/')[1] === 'jpeg' ? 'jpg' : mimeOut.split('/')[1];
    return { buffer, mime: mimeOut, ext: extOut };
  }

  // 비디오 → 첫 프레임 PNG 추출
  const tmpIn = join(tmpdir(), `pjl-bg-in-${randomUUID()}.${ext || 'mp4'}`);
  const tmpOut = join(tmpdir(), `pjl-bg-out-${randomUUID()}.png`);
  try {
    await fs.writeFile(tmpIn, buffer);
    await runCommand('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', tmpIn,
      '-vf', 'select=eq(n\\,0)',
      '-vframes', '1',
      '-q:v', '2',
      tmpOut,
    ]);
    const out = await fs.readFile(tmpOut);
    return { buffer: out, mime: 'image/png', ext: 'png' };
  } finally {
    await fs.unlink(tmpIn).catch(() => {});
    await fs.unlink(tmpOut).catch(() => {});
  }
}
