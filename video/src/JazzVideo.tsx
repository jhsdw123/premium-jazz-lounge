import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { TPlaylist } from './types';

export const JazzVideo: React.FC<{ playlist: TPlaylist }> = ({ playlist }) => {
  return (
    <AbsoluteFill
      style={{
        background: '#0A0A0A',
        color: '#D4AF37',
        padding: 40,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <h1 style={{ fontSize: 72, marginBottom: 24 }}>
        🎷 Premium Jazz Lounge — Phase 4-A Bootstrap
      </h1>
      <p style={{ fontSize: 28, color: '#FFFFFF' }}>{playlist.videoTitle}</p>
      <p style={{ fontSize: 24 }}>Tracks: {playlist.tracks.length}</p>
      <p style={{ fontSize: 24 }}>Total duration: {playlist.totalDurationSec}s</p>
      <p style={{ fontSize: 18, color: '#888', marginTop: 40 }}>
        (Phase 4-C 에서 비주얼라이저 + 텍스트 + Loop placeholder 추가)
      </p>
    </AbsoluteFill>
  );
};
