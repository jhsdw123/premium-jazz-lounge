/**
 * Premium Jazz Lounge — Remotion HUD 영상 생성기
 *
 * 출력: 1920×1080 30fps mp4 (배경 이미지 + 비주얼라이저 + 텍스트 + Progress 등)
 * 용도: Filmora 에서 라인드로잉 Loop 영상과 마스킹 합성
 *       (Filmora 합성 자동화 X — 사용자 워크플로우의 일부)
 *
 * 배경: template.background_image_url
 *       (라인드로잉 영상 첫 프레임 또는 정적 이미지)
 * 컴포넌트: components 배열 또는 옛 schema 자동 변환 (adaptTemplate)
 */
import React from 'react';
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TPlaylist } from './types';
import { adaptTemplate } from './lib/templateAdapter';
import { TextComponent } from './components/TextComponent';
import { ImageComponent } from './components/ImageComponent';
import { VisualizerComponent } from './components/VisualizerComponent';
import { ProgressComponent } from './components/ProgressComponent';

export const JazzVideo: React.FC<{ playlist: TPlaylist }> = ({ playlist }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentSec = frame / fps;

  // 현재 트랙 결정
  let currentTrackIdx = playlist.tracks.findIndex(
    (t) => currentSec >= t.startSec && currentSec < t.endSec
  );
  if (currentTrackIdx < 0) currentTrackIdx = 0;
  const currentTrack = playlist.tracks[currentTrackIdx] || playlist.tracks[0];

  // 빈 playlist 방어
  if (!currentTrack) {
    return (
      <AbsoluteFill style={{ background: '#0A0A0A', color: '#D4AF37', padding: 40 }}>
        <h1 style={{ fontSize: 72 }}>(playlist 비어있음)</h1>
      </AbsoluteFill>
    );
  }

  const trackElapsed = Math.max(0, currentSec - currentTrack.startSec);
  const totalProgress = playlist.totalDurationSec > 0
    ? currentSec / playlist.totalDurationSec
    : 0;
  const trackProgress = currentTrack.durationSec > 0
    ? trackElapsed / currentTrack.durationSec
    : 0;

  // 옛/새 schema 모두 지원
  const tpl: any = playlist.template || {};
  const adapted = adaptTemplate(tpl);
  const components = adapted.components;
  const bgColor = adapted.canvas?.bgColor || '#0A0A0A';
  const bgImageUrl: string | null = tpl.background_image_url || null;

  // 변수 치환 컨텍스트
  const ctx = {
    trackTitle: currentTrack.title,
    trackNumber: currentTrackIdx + 1,
    totalTracks: playlist.tracks.length,
    trackProgress,
    totalProgress,
  };

  return (
    <AbsoluteFill style={{ background: bgColor }}>
      {/* 배경 이미지 (Filmora 마스킹용 HUD 영상의 베이스 레이어) */}
      {bgImageUrl && (
        <Img
          src={bgImageUrl}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            zIndex: 0,
          }}
        />
      )}

      {/* 모든 트랙 오디오 — Sequence 로 시간 분리 */}
      {playlist.tracks.map((track) => (
        <Sequence
          key={track.id}
          from={Math.round(track.startSec * fps)}
          durationInFrames={Math.max(1, Math.round(track.durationSec * fps))}
        >
          <Audio src={staticFile(track.audioPath)} />
        </Sequence>
      ))}

      {/* 컴포넌트들 — 절대 좌표 */}
      {components.map((comp, idx) => {
        const key = comp.id || `c${idx}`;
        if (comp.type === 'text') {
          return <TextComponent key={key} comp={comp} ctx={ctx} />;
        }
        if (comp.type === 'image') {
          return <ImageComponent key={key} comp={comp} />;
        }
        if (comp.type === 'visualizer') {
          return <VisualizerComponent key={key} comp={comp} currentTrack={currentTrack} />;
        }
        if (comp.type === 'progress') {
          return <ProgressComponent key={key} comp={comp} ctx={ctx} />;
        }
        return null;
      })}
    </AbsoluteFill>
  );
};
