/**
 * Phase 4-C-2 v5: AudioMotion-analyzer 사전 분석.
 *
 * puppeteer 로 control-panel 의 analysis.html 을 띄우고, signed audio URL 을
 * 브라우저에서 재생하면서 AudioMotion 의 getBars() 결과를 frame 단위로 캡처.
 * 결과를 Uint8Array (band 수 × frame 수, 0~255 양자화) 바이너리로 저장.
 *
 * 출력: video/public/analysis/track-{trackId}.bin
 */

import puppeteer from 'puppeteer';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { videoPublic } from './paths.mjs';

const ANALYSIS_DIR = resolve(videoPublic, 'analysis');

const BANDS_BY_MODE = { 0: 128, 1: 240, 2: 120, 3: 80, 4: 60, 5: 40, 6: 30, 7: 20, 8: 10, 10: 128 };

let _browser = null;

async function getBrowser() {
  if (_browser && !_browser.isConnected?.() === false) {
    try {
      // 기존 인스턴스가 살아있으면 재사용
      const pages = await _browser.pages();
      if (pages.length >= 0) return _browser;
    } catch {}
  }
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--mute-audio',
    ],
  });
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

/**
 * 한 트랙 분석.
 *
 * @param {object} args
 * @param {string} args.controlPanelOrigin - 예: 'http://localhost:4001'
 * @param {string} args.audioUrl           - signed URL or local file URL
 * @param {number} args.trackId            - 결과 파일명에 사용
 * @param {object} [args.visOptions]       - AudioMotion 옵션 (mode, minFreq, etc.)
 * @returns {{ binPath: string, totalFrames: number, bandsPerFrame: number, captured: number }}
 */
export async function analyzeTrack({ controlPanelOrigin, audioUrl, trackId, visOptions = {} }) {
  await ensureDir(ANALYSIS_DIR);
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      console.log(`[analysis browser ${t}]`, msg.text());
    }
  });
  page.on('pageerror', (err) => console.log('[analysis pageerror]', err.message));

  try {
    await page.goto(`${controlPanelOrigin}/analysis.html`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => typeof window.PJL_runAnalysis === 'function', { timeout: 30000 });

    const result = await page.evaluate(
      async (audioUrl, opts) => window.PJL_runAnalysis({ audioUrl, ...opts }),
      audioUrl,
      visOptions
    );

    if (!result || !Array.isArray(result.samples)) {
      throw new Error('analysis 결과가 비어있음');
    }

    const buf = Buffer.from(Uint8Array.from(result.samples));
    const filename = `track-${trackId}.bin`;
    const binPath = resolve(ANALYSIS_DIR, filename);
    await fs.writeFile(binPath, buf);

    return {
      binPath,
      filename,
      totalFrames: result.totalFrames,
      bandsPerFrame: result.bandsPerFrame,
      captured: result.captured,
      bytes: buf.length,
    };
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Visualizer 컴포넌트(들)에서 AudioMotion 옵션 추출.
 * 여러 개 있으면 첫 번째 것만 사용 — 모든 visualizer 가 같은 분석을 공유.
 * (band 수가 다르면 각자 다시 분석해야 하지만 그건 future work.)
 */
export function pickVisualizerOptions(template) {
  const cfg = template?.config_json || {};
  const components = Array.isArray(cfg.components) ? cfg.components : [];
  const v = components.find((c) => c?.type === 'visualizer');
  if (!v) return null;
  return {
    mode: v.mode ?? 3,
    fps: 30,
    minFreq: v.minFreq ?? 30,
    maxFreq: v.maxFreq ?? 20000,
    smoothing: v.smoothing ?? 0.5,
    weightingFilter: v.weightingFilter ?? 'D',
    frequencyScale: v.frequencyScale ?? 'log',
    minDecibels: v.minDecibels ?? -85,
    maxDecibels: v.maxDecibels ?? -25,
    playbackRate: 2,
  };
}

export function bandsForMode(mode) {
  return BANDS_BY_MODE[mode] ?? 80;
}

export { ANALYSIS_DIR };
