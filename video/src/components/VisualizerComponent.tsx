/**
 * Phase 4-C-2 v5: AudioMotion-analyzer 사전 분석 데이터 → SVG 막대 렌더링.
 *
 * Editor 의 실시간 AudioMotion 비주얼라이저와 시각적 동등성을 위해
 * Remotion 빌드 시점에 puppeteer 가 AudioMotion 의 getBars() 를 30fps 간격으로
 * 캡처해서 binary (Uint8Array, 0~255) 로 video/public/analysis/track-{id}.bin 에 저장.
 *
 * 본 컴포넌트는 그 데이터를 fetch 해서 현재 frame 의 amplitude slice 를 SVG 로 그림.
 *
 * AudioMotion 의 풍부한 시각효과 (radial / mirror / reflex / led / lumi / alpha) 중
 * 핵심 요소 (mirror, basic reflex, radial 일부) 만 SVG 로 재현. 나머지는 단순화.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useCurrentFrame, useVideoConfig, staticFile, continueRender, delayRender } from 'remotion';
import type { Component } from '../lib/templateAdapter';

type Track = {
  id: number;
  title: string;
  audioPath: string;
  durationSec: number;
  startSec: number;
  endSec: number;
};

// mode → bands per frame (Editor 의 AudioMotion mode 옵션과 동일)
const BANDS_BY_MODE: Record<number, number> = {
  0: 128, 1: 240, 2: 120, 3: 80, 4: 60, 5: 40, 6: 30, 7: 20, 8: 10, 10: 128,
};

function getBandsForMode(mode: number): number {
  return BANDS_BY_MODE[mode] ?? 80;
}

// 사전 분석 데이터 캐시 — 곡당 한 번만 fetch.
const _binCache = new Map<number, Uint8Array | 'missing'>();

export const VisualizerComponent: React.FC<{
  comp: Component;
  currentTrack: Track;
}> = ({ comp, currentTrack }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [binData, setBinData] = useState<Uint8Array | null | 'missing'>(
    () => {
      const cached = _binCache.get(currentTrack.id);
      return cached === undefined ? null : cached;
    }
  );
  const handleRef = useRef<number | null>(null);

  useEffect(() => {
    const cached = _binCache.get(currentTrack.id);
    if (cached !== undefined) {
      setBinData(cached);
      return;
    }
    const handle = delayRender(`vis-bin-${currentTrack.id}`);
    handleRef.current = handle;
    fetch(staticFile(`analysis/track-${currentTrack.id}.bin`))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const arr = new Uint8Array(buf);
        _binCache.set(currentTrack.id, arr);
        setBinData(arr);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[Visualizer] analysis bin missing for track ${currentTrack.id}:`, e.message);
        _binCache.set(currentTrack.id, 'missing');
        setBinData('missing');
      })
      .finally(() => {
        if (handleRef.current !== null) {
          continueRender(handleRef.current);
          handleRef.current = null;
        }
      });
    return () => {
      if (handleRef.current !== null) {
        continueRender(handleRef.current);
        handleRef.current = null;
      }
    };
  }, [currentTrack.id]);

  const W = comp.width;
  const H = comp.height;
  const mode = comp.mode ?? 3;
  const bands = getBandsForMode(mode);

  // 현재 frame 의 amplitude slice
  let amplitudes: Float32Array;
  if (!binData || binData === 'missing') {
    amplitudes = new Float32Array(bands);
  } else {
    const trackStartFrame = Math.round(currentTrack.startSec * fps);
    const localFrame = Math.max(0, frame - trackStartFrame);
    const offset = localFrame * bands;
    if (offset + bands > binData.length) {
      amplitudes = new Float32Array(bands);
    } else {
      amplitudes = new Float32Array(bands);
      for (let i = 0; i < bands; i++) {
        amplitudes[i] = binData[offset + i] / 255;
      }
    }
  }

  const glow = Math.max(0, comp.glow ?? 20);
  const glowColor = comp.colorMode === 'gradient' ? '#D4AF37' : (comp.color || '#D4AF37');

  return (
    <div
      style={{
        position: 'absolute',
        left: comp.x,
        top: comp.y,
        width: W,
        height: H,
        opacity: comp.opacity ?? 1,
        filter: glow > 0 ? `drop-shadow(0 0 ${glow}px ${glowColor})` : 'none',
        pointerEvents: 'none',
      }}
    >
      {comp.radial
        ? <RadialBars amplitudes={amplitudes} comp={comp} W={W} H={H} />
        : <LinearBars amplitudes={amplitudes} comp={comp} W={W} H={H} />}
    </div>
  );
};

// ─── 색상 ────────────────────────────────────────────────────
function hexToRgb(hex?: string): { r: number; g: number; b: number } {
  if (!hex || typeof hex !== 'string') return { r: 212, g: 175, b: 55 };
  let m = hex.replace('#', '');
  if (m.length === 3) m = m.split('').map((c) => c + c).join('');
  if (m.length !== 6) return { r: 212, g: 175, b: 55 };
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

function gradientColorAt(stops: any[] | undefined, pct: number): string {
  if (!stops || !stops.length) return '#D4AF37';
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  if (pct <= sorted[0].position) return sorted[0].color;
  if (pct >= sorted[sorted.length - 1].position) return sorted[sorted.length - 1].color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (pct >= a.position && pct <= b.position) {
      const span = Math.max(0.0001, b.position - a.position);
      const t = (pct - a.position) / span;
      const c1 = hexToRgb(a.color);
      const c2 = hexToRgb(b.color);
      const r = Math.round(c1.r + (c2.r - c1.r) * t);
      const g = Math.round(c1.g + (c2.g - c1.g) * t);
      const bl = Math.round(c1.b + (c2.b - c1.b) * t);
      return `rgb(${r},${g},${bl})`;
    }
  }
  return sorted[sorted.length - 1].color;
}

function getBarColor(c: any, percent: number): string {
  if (c.colorMode === 'gradient' && c.gradientStops?.length) {
    return gradientColorAt(c.gradientStops, percent * 100);
  }
  // gradient 키워드 → 단색 fallback (영상 SVG 단순화: AudioMotion 의 named gradient 는 색만 매핑).
  return colorForGradientPreset(c.gradient, percent) || c.color || '#D4AF37';
}

// AudioMotion 기본 gradient 키워드 → percent 기반 색.
const GRADIENT_PRESETS: Record<string, string[]> = {
  classic: ['#FF0000', '#FFFF00', '#00FF00'],
  prism: ['#FF0000', '#FFA500', '#FFFF00', '#00FF00', '#0000FF', '#4B0082', '#EE82EE'],
  rainbow: ['#FF0000', '#FFA500', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF'],
  orangered: ['#FFA500', '#FF4500'],
  steelblue: ['#87CEEB', '#4682B4', '#1E3A5F'],
};

function colorForGradientPreset(name: string | undefined, percent: number): string | null {
  if (!name) return null;
  const stops = GRADIENT_PRESETS[name];
  if (!stops) return null;
  if (stops.length === 1) return stops[0];
  const seg = percent * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const t = seg - i;
  const c1 = hexToRgb(stops[i]);
  const c2 = hexToRgb(stops[i + 1]);
  return `rgb(${Math.round(c1.r + (c2.r - c1.r) * t)},${Math.round(c1.g + (c2.g - c1.g) * t)},${Math.round(c1.b + (c2.b - c1.b) * t)})`;
}

// ─── 선형 막대 ───────────────────────────────────────────────
const LinearBars: React.FC<{ amplitudes: Float32Array; comp: any; W: number; H: number }> = ({
  amplitudes, comp, W, H,
}) => {
  const N = amplitudes.length;
  if (N === 0) return null;
  const mirror = comp.mirror ?? 0;       // -1 left, 0 none, 1 right
  const reflexRatio = Math.max(0, Math.min(1, comp.reflexRatio ?? 0));
  const reflexAlpha = Math.max(0, Math.min(1, comp.reflexAlpha ?? 1));
  const mainH = H * (1 - reflexRatio);

  // mirror 처리 — AudioMotion 의 mirror=1 은 오른쪽 절반 미러, -1 은 왼쪽.
  // 단순화: mirror!==0 이면 좌우 대칭 표시 (N/2 막대 * 2).
  const display = mirror !== 0 ? buildMirrored(amplitudes, mirror) : amplitudes;
  const M = display.length;
  const barTotal = W / M;
  const barW = Math.max(1, barTotal - 0.5);

  const bars = [];
  for (let i = 0; i < M; i++) {
    const amp = display[i];
    const h = Math.max(2, amp * mainH * 0.95);
    const x = i * barTotal;
    const y = mainH - h;
    const color = getBarColor(comp, M > 1 ? i / (M - 1) : 0);
    bars.push(
      <rect key={`b${i}`} x={x} y={y} width={barW} height={h} fill={color}
        rx={comp.roundBars ? barW / 2 : 0} />
    );
  }

  // 반사 (reflex) 영역
  const reflexBars: React.ReactElement[] = [];
  if (reflexRatio > 0) {
    const reflexH = H - mainH;
    for (let i = 0; i < M; i++) {
      const amp = display[i];
      const h = Math.max(0, amp * mainH * 0.95);
      const reflectH = Math.min(reflexH, h * 0.6);
      const x = i * barTotal;
      const color = getBarColor(comp, M > 1 ? i / (M - 1) : 0);
      reflexBars.push(
        <rect key={`r${i}`} x={x} y={mainH} width={barW} height={reflectH} fill={color}
          opacity={reflexAlpha * 0.5}
          rx={comp.roundBars ? barW / 2 : 0} />
      );
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
      {bars}
      {reflexBars}
    </svg>
  );
};

function buildMirrored(amps: Float32Array, mirror: number): Float32Array {
  const N = amps.length;
  const half = Math.floor(N / 2);
  // mirror=1: 왼쪽 절반은 오른쪽의 거울. mirror=-1: 오른쪽 절반은 왼쪽의 거울.
  if (mirror === 1) {
    const out = new Float32Array(N);
    for (let i = 0; i < half; i++) {
      const v = amps[half + i];
      out[half + i] = v;
      out[half - 1 - i] = v;
    }
    return out;
  } else {
    const out = new Float32Array(N);
    for (let i = 0; i < half; i++) {
      const v = amps[i];
      out[i] = v;
      out[N - 1 - i] = v;
    }
    return out;
  }
}

// ─── 원형 (radial) 막대 ──────────────────────────────────────
const RadialBars: React.FC<{ amplitudes: Float32Array; comp: any; W: number; H: number }> = ({
  amplitudes, comp, W, H,
}) => {
  const N = amplitudes.length;
  if (N === 0) return null;
  const cx = W / 2;
  const cy = H / 2;
  const innerR = Math.min(W, H) * 0.18;
  const outerMax = Math.min(W, H) * 0.45 - innerR;
  const angleStep = (Math.PI * 2) / N;
  const bars = [];
  for (let i = 0; i < N; i++) {
    const amp = amplitudes[i];
    const len = Math.max(2, amp * outerMax);
    const a = i * angleStep - Math.PI / 2;
    const x1 = cx + Math.cos(a) * innerR;
    const y1 = cy + Math.sin(a) * innerR;
    const x2 = cx + Math.cos(a) * (innerR + len);
    const y2 = cy + Math.sin(a) * (innerR + len);
    const color = getBarColor(comp, N > 1 ? i / (N - 1) : 0);
    bars.push(
      <line key={`r${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={color} strokeWidth={Math.max(2, (Math.PI * 2 * innerR) / N - 1)}
        strokeLinecap={comp.roundBars ? 'round' : 'butt'} />
    );
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
      {bars}
    </svg>
  );
};
