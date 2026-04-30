import React, { useRef } from 'react';
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

// Auto Gain Control 상수 — 곡마다 음량 다른 문제를 자동 정규화로 해결.
const AGC_TARGET_PEAK = 0.7;          // 정규화 후 목표 peak (천장 안 박힘)
const AGC_LOOKBACK_FRAMES = 60;       // 2초 (30fps) peak 추적 윈도우
const AGC_MIN_PEAK = 0.01;            // div-by-zero 방지 (조용 구간 보호)
const FALLING_SMOOTHING_BASE = 0.92;  // EMA falling baseline (rising 은 0.7)
const SENSITIVITY_BASELINE = 0.15;    // Editor default. 사용자 slider 의 1.0 multiplier 기준.

export const VisualizerComponent: React.FC<{
  comp: Component;
  currentTrack: Track;
}> = ({ comp, currentTrack }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // refs — Remotion render concurrency=1 일 때 frame 간 persist.
  const peakHistoryRef = useRef<number[]>([]);
  const prevAmpsRef = useRef<Float32Array | null>(null);
  const lastTrackIdRef = useRef<number | null>(null);

  // 곡 변경 시 AGC + smoothing state reset
  if (lastTrackIdRef.current !== currentTrack.id) {
    peakHistoryRef.current = [];
    prevAmpsRef.current = null;
    lastTrackIdRef.current = currentTrack.id;
  }

  const audioData = useAudioData(staticFile(currentTrack.audioPath));

  // 트랙 시작 frame 보정 — Remotion 의 절대 frame 에서 트랙 내부 frame 으로
  const trackStartFrame = Math.round(currentTrack.startSec * fps);
  const localFrame = Math.max(0, frame - trackStartFrame);

  const N = Math.max(1, comp.barCount | 0 || 80);

  // Editor 와 같은 옵션
  const opts: VisOpts = {
    barCount: N,
    centerCut: comp.centerCut ?? 0,
    trimStart: comp.trimStart ?? 3,
    sensitivity: comp.sensitivity ?? SENSITIVITY_BASELINE,
    midBoost: comp.midBoost ?? 1.5,
    highBoost: comp.highBoost ?? 0.8,
    smoothing: comp.smoothing ?? 0.85,
  };

  let heights: Float32Array;
  if (!audioData) {
    heights = new Float32Array(N);
  } else {
    // 1) 현재 frame 의 raw spectrum (1024 bin)
    const visualization = visualizeAudio({
      fps,
      frame: localFrame,
      audioData,
      numberOfSamples: 1024,
      optimizeFor: 'speed',
    });

    // 2) 현재 frame peak
    let currentPeak = 0;
    for (let i = 0; i < visualization.length; i++) {
      const v = visualization[i];
      if (v > currentPeak) currentPeak = v;
    }

    // 3) peak history 갱신 (최근 60 frame = 2 sec)
    peakHistoryRef.current.push(currentPeak);
    if (peakHistoryRef.current.length > AGC_LOOKBACK_FRAMES) {
      peakHistoryRef.current.shift();
    }

    // 4) running max
    let runningMaxPeak = AGC_MIN_PEAK;
    for (const p of peakHistoryRef.current) {
      if (p > runningMaxPeak) runningMaxPeak = p;
    }

    // 5) auto gain — peak 가 AGC_TARGET_PEAK 가 되도록
    const autoGain = AGC_TARGET_PEAK / runningMaxPeak;

    // 6) 사용자 sensitivity multiplier (Editor default 0.15 = 1.0 multiplier)
    const sensitivityMultiplier = opts.sensitivity / SENSITIVITY_BASELINE;

    const finalGain = autoGain * sensitivityMultiplier;

    // 7) AGC 적용
    const normalized = new Float32Array(visualization.length);
    for (let i = 0; i < visualization.length; i++) {
      normalized[i] = visualization[i] * finalGain;
    }

    // 8) 시간 스무딩 (EMA — refs 로 frame 간 persist).
    //    Editor: rising fast (prev*0.3 + curr*0.7), falling smooth.
    //    falling 은 사용자 slider 와 0.92 baseline 중 더 부드러운 값 사용.
    const sm = Math.max(FALLING_SMOOTHING_BASE, opts.smoothing);
    const prev = prevAmpsRef.current;
    const smoothed = new Float32Array(normalized.length);
    if (!prev || prev.length !== normalized.length) {
      // 곡 시작 / 첫 frame: smoothing 없이 normalized 그대로
      for (let i = 0; i < normalized.length; i++) smoothed[i] = normalized[i];
    } else {
      for (let i = 0; i < normalized.length; i++) {
        const p = prev[i];
        const c = normalized[i];
        smoothed[i] = c >= p ? p * 0.3 + c * 0.7 : p * sm + c * (1 - sm);
      }
    }
    prevAmpsRef.current = smoothed;

    // 9) 디버그 로그 (1초마다 — 30fps 기준)
    if (frame % 30 === 0) {
      let mxS = 0;
      for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > mxS) mxS = smoothed[i];
      // eslint-disable-next-line no-console
      console.log(
        `[AGC] frame=${frame} runningPeak=${runningMaxPeak.toFixed(3)} ` +
        `autoGain=${autoGain.toFixed(2)} sensMul=${sensitivityMultiplier.toFixed(2)} ` +
        `smoothedMax=${mxS.toFixed(3)}`
      );
    }

    // 10) bin → bar amplitude (rawToBarHeights 의 'remotion' 모드는
    //     fixed sensitivity baseline + EQ 만 적용. AGC + 사용자 sensitivity
    //     는 이미 위에서 처리됨)
    heights = rawToBarHeights(smoothed, opts, 'remotion');
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
