import React from 'react';
import { staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';
import { rawToBarHeights, getBarColor, type VisOpts } from '../lib/visualizerLogic';
import type { Component } from '../lib/templateAdapter';

type Track = {
  id: number;
  title: string;
  audioPath: string;
  durationSec: number;
  startSec: number;
  endSec: number;
};

export const VisualizerComponent: React.FC<{
  comp: Component;
  currentTrack: Track;
}> = ({ comp, currentTrack }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const audioData = useAudioData(staticFile(currentTrack.audioPath));

  // 트랙 시작 frame 보정 — Remotion 의 절대 frame 에서 트랙 내부 frame 으로
  const trackStartFrame = Math.round(currentTrack.startSec * fps);
  const localFrame = Math.max(0, frame - trackStartFrame);

  const N = Math.max(1, comp.barCount | 0 || 80);

  // Editor 와 같은 옵션 적용
  const opts: VisOpts = {
    barCount: N,
    centerCut: comp.centerCut ?? 0,
    trimStart: comp.trimStart ?? 3,
    sensitivity: comp.sensitivity ?? 0.15,
    midBoost: comp.midBoost ?? 1.5,
    highBoost: comp.highBoost ?? 0.8,
    smoothing: comp.smoothing ?? 0.85,
  };

  // 시간 스무딩 — Remotion 은 frame 간 state 가 없어서 매 frame 독립 계산이라
  // 시각적으로 jittery. Editor 의 rising-fast / falling-smooth 패턴을 흉내내려고
  // 최근 K frame 을 sample 한 뒤 oldest→newest 순으로 EMA 적용.
  //
  // fix v3: history 6→10 으로 확장 + falling smoothing 0.92 로 baseline 강화
  // (형님 sensitivity 슬라이더 값과 max 비교, 더 부드러운 쪽 선택).
  const SMOOTHING_HISTORY = 10;
  const FALLING_SMOOTHING_BASE = 0.92;

  let heights: Float32Array;
  if (!audioData) {
    heights = new Float32Array(N);
  } else {
    const seriesHeights: Float32Array[] = [];
    for (let k = SMOOTHING_HISTORY - 1; k >= 0; k--) {
      const f = Math.max(0, localFrame - k);
      const samples = visualizeAudio({
        fps,
        frame: f,
        audioData,
        numberOfSamples: 1024,
        optimizeFor: 'speed',
      });
      seriesHeights.push(rawToBarHeights(samples, opts, 'remotion'));
    }
    // Editor 의 smoothing 정확 재현: rising 빠름 (prev*0.3 + raw*0.7),
    // falling 만 smoothing 적용. 사용자 slider (opts.smoothing, default 0.85) 와
    // 0.92 baseline 중 더 큰 값 (= 더 부드러운 쪽) 사용.
    const smoothed = new Float32Array(N);
    const effectiveSmoothing = Math.max(FALLING_SMOOTHING_BASE, opts.smoothing);
    for (const h of seriesHeights) {
      for (let i = 0; i < N; i++) {
        const prev = smoothed[i];
        const raw = h[i];
        smoothed[i] = raw > prev
          ? prev * 0.3 + raw * 0.7
          : prev * effectiveSmoothing + raw * (1 - effectiveSmoothing);
      }
    }
    heights = smoothed;
  }

  const barWidth = Math.max(1, comp.barWidth | 0 || 6);
  const barGap = Math.max(0, comp.barGap | 0 || 0);
  const ew = barWidth + barGap;
  const splitGap = Math.max(0, comp.splitGap | 0 || 0);
  const halfSplit = splitGap / 2;
  const verticalMode = comp.verticalMode || 'symmetric';
  const W = comp.width;
  const H = comp.height;
  const halfBars = Math.max(1, Math.min(N, Math.floor((W / 2) / Math.max(1, ew))));
  const heightCap = H * 0.85;

  const bars: React.ReactElement[] = [];
  for (let i = 0; i < halfBars; i++) {
    let barH = Math.min(heights[i] || 0, heightCap);
    if (barH < 2) barH = 2;
    const halfH = barH / 2;
    const colorCss = getBarColor(comp, i, halfBars);

    if (verticalMode === 'symmetric' && splitGap === 0) {
      // 단일 블록 (가운데 oy 기준 위/아래 동시)
      bars.push(
        <div
          key={`r${i}`}
          style={{
            position: 'absolute',
            left: W / 2 + i * ew,
            top: H / 2 - halfH,
            width: barWidth,
            height: barH,
            background: colorCss,
            borderRadius: barWidth / 2,
          }}
        />,
        <div
          key={`l${i}`}
          style={{
            position: 'absolute',
            left: W / 2 - (i + 1) * ew,
            top: H / 2 - halfH,
            width: barWidth,
            height: barH,
            background: colorCss,
            borderRadius: barWidth / 2,
          }}
        />
      );
    } else {
      if (verticalMode !== 'down') {
        bars.push(
          <div
            key={`tr${i}`}
            style={{
              position: 'absolute',
              left: W / 2 + i * ew,
              top: H / 2 - halfSplit - halfH,
              width: barWidth,
              height: halfH,
              background: colorCss,
              borderRadius: barWidth / 2,
            }}
          />,
          <div
            key={`tl${i}`}
            style={{
              position: 'absolute',
              left: W / 2 - (i + 1) * ew,
              top: H / 2 - halfSplit - halfH,
              width: barWidth,
              height: halfH,
              background: colorCss,
              borderRadius: barWidth / 2,
            }}
          />
        );
      }
      if (verticalMode !== 'up') {
        bars.push(
          <div
            key={`br${i}`}
            style={{
              position: 'absolute',
              left: W / 2 + i * ew,
              top: H / 2 + halfSplit,
              width: barWidth,
              height: halfH,
              background: colorCss,
              borderRadius: barWidth / 2,
            }}
          />,
          <div
            key={`bl${i}`}
            style={{
              position: 'absolute',
              left: W / 2 - (i + 1) * ew,
              top: H / 2 + halfSplit,
              width: barWidth,
              height: halfH,
              background: colorCss,
              borderRadius: barWidth / 2,
            }}
          />
        );
      }
    }
  }

  // glow — 그룹 단위로 drop-shadow filter (gradient 모드는 색이 다양해 단일색 글로우만)
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
      {bars}
    </div>
  );
};
